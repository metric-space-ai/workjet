import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  ProjectId,
  type CtoxWorkjetProjectControlRequest,
  type WorkjetSupervisorJournal,
  type WorkjetSupervisorTurnIntent,
} from "@workjet/contracts";
import {
  bindWorkjetSupervisor,
  resumeWorkjetSupervisorTurn,
  submitWorkjetSupervisorTurn,
} from "./workjetSupervisorControl";
import type { WorkjetProjectControlPort } from "./workjetProjectControl";
import { canResumeSupervisorJournal } from "./nativeSupervisorComposer";

const intent: WorkjetSupervisorTurnIntent = {
  instanceId: "managed:acceptance",
  projectId: ProjectId.make("71462c13-b395-402f-b6c8-788b405783e7"),
  threadId: "e28290b0-7b0a-4d19-a242-f27041fadb84",
  commandId: CommandId.make("durable-submit-1"),
  goal: "Make the requested project change.",
  createdAt: "2026-10-07T21:00:00.000Z",
};
const binding = {
  contract: "ctox.workjet.supervisor_binding.v1",
  projectId: intent.projectId,
  threadId: intent.threadId,
  threadKey: `business-os/threads/${intent.threadId}`,
} as const;
const turn = {
  commandId: "canonical-native-turn-1",
  taskId: "native-task-1",
  threadId: intent.threadId,
  threadKey: binding.threadKey,
  executionPhase: "running",
  status: "running",
  queueStatus: "running",
  attempt: 1,
  terminal: false,
  result: null,
  resultTruncated: false,
  errorCode: null,
  errorMessage: null,
} as const;

describe("native supervisor setup", () => {
  it("binds an empty chat without a fabricated prompt, journal or execution", async () => {
    const requests: CtoxWorkjetProjectControlRequest[] = [];
    const scope = {
      instanceId: intent.instanceId,
      projectId: intent.projectId,
      threadId: intent.threadId,
    };
    const result = await bindWorkjetSupervisor(
      scope,
      CommandId.make("setup-only"),
      async (instanceId, request) => {
        expect(instanceId).toBe(scope.instanceId);
        requests.push(request);
        if (request.action !== "project.supervisor.bind")
          throw new Error("Setup must never start a turn");
        return {
          _tag: "completed",
          response: {
            action: request.action,
            commandId: request.commandId,
            projectId: request.projectId,
            binding,
          },
        };
      },
    );
    expect(result._tag).toBe("completed");
    expect(requests).toEqual([
      {
        action: "project.supervisor.bind",
        commandId: "setup-only",
        projectId: scope.projectId,
        threadId: scope.threadId,
      },
    ]);
  });

  it.each(["command", "project", "thread"] as const)(
    "rejects a setup receipt with a foreign %s",
    async (field) => {
      const result = await bindWorkjetSupervisor(
        intent,
        CommandId.make("setup-correlated"),
        async () => ({
          _tag: "completed",
          response: {
            action: "project.supervisor.bind",
            commandId: CommandId.make(field === "command" ? "foreign-command" : "setup-correlated"),
            projectId:
              field === "project"
                ? ProjectId.make("94754cae-084a-4ec6-8330-bf5d2e9d6068")
                : intent.projectId,
            binding: {
              ...binding,
              threadId:
                field === "thread" ? "6f688cca-f01b-4e08-ac6e-d91c9c512d5b" : binding.threadId,
            },
          },
        }),
      );
      expect(result).toEqual({ _tag: "failed", code: "guest_failed" });
    },
  );

  it.each(["authentication_required", "timeout", "not_active"] as const)(
    "preserves %s setup failure without submitting work",
    async (code) => {
      let calls = 0;
      expect(
        await bindWorkjetSupervisor(
          intent,
          CommandId.make("setup-refused"),
          async (_instance, request) => {
            calls += 1;
            expect(request.action).toBe("project.supervisor.bind");
            return { _tag: "failed", code };
          },
        ),
      ).toEqual({ _tag: "failed", code });
      expect(calls).toBe(1);
    },
  );
});

describe("durable native supervisor submission", () => {
  it.each([
    { code: "not_active", legacy: false },
    { code: "timeout", legacy: false },
    { code: "not_active", legacy: true },
    { code: "timeout", legacy: true },
  ] as const)(
    "recovers $code binding failure (legacy=$legacy) using the original intent",
    async ({ code, legacy }) => {
      const state: { saved: WorkjetSupervisorJournal | null } = {
        saved: legacy
          ? { intent, turn: null, submission: "not-submitted", submissionError: code }
          : null,
      };
      const journal = {
        save: async (value: WorkjetSupervisorJournal) => {
          state.saved = structuredClone(value);
        },
      };
      const requests: CtoxWorkjetProjectControlRequest[] = [];
      let bindingReady = legacy;
      const port: WorkjetProjectControlPort = async (instanceId, request) => {
        expect(instanceId).toBe(intent.instanceId);
        expect(state.saved?.intent).toEqual(intent);
        requests.push(request);
        if (request.action === "project.supervisor.bind") {
          expect(request.commandId).toBe(`${intent.commandId}:bind`);
          if (!bindingReady) {
            bindingReady = true;
            return { _tag: "failed", code };
          }
          return {
            _tag: "completed",
            response: {
              action: request.action,
              commandId: request.commandId,
              projectId: request.projectId,
              binding,
            },
          };
        }
        if (request.action === "project.supervisor.turn.submit")
          return {
            _tag: "completed",
            response: {
              action: request.action,
              commandId: request.commandId,
              projectId: request.projectId,
              binding,
              contract: "ctox.workjet.supervisor_turn.v1",
              messageId: "native-message-1",
              turn,
            },
          };
        return { _tag: "failed", code: "unsupported" };
      };
      if (!legacy) {
        expect(await submitWorkjetSupervisorTurn(intent, journal, port)).toEqual({
          _tag: "failed",
          code,
        });
        expect(state.saved).toEqual({
          intent,
          turn: null,
          submission: "prepared",
          submissionError: code,
        });
      }
      expect(canResumeSupervisorJournal(state.saved, null)).toBe(true);
      expect(canResumeSupervisorJournal(state.saved, code)).toBe(true);
      expect(canResumeSupervisorJournal(state.saved, "local_failed")).toBe(false);
      await resumeWorkjetSupervisorTurn(
        structuredClone(state.saved!),
        CommandId.make("observation-after-binding-readiness"),
        journal,
        port,
      );
      expect(
        requests.filter((request) => request.action === "project.supervisor.bind"),
      ).toHaveLength(legacy ? 1 : 2);
      expect(
        requests.filter((request) => request.action === "project.supervisor.turn.submit"),
      ).toEqual([
        {
          action: "project.supervisor.turn.submit",
          commandId: intent.commandId,
          projectId: intent.projectId,
          threadId: intent.threadId,
          goal: intent.goal,
        },
      ]);
      expect(state.saved).toEqual({ intent, turn, submission: "confirmed" });
    },
  );

  it.each(["authentication_required", "unsupported", "guest_failed"] as const)(
    "does not replay a persisted %s refusal",
    async (code) => {
      const saved: WorkjetSupervisorJournal = {
        intent,
        turn: null,
        submission: "not-submitted",
        submissionError: code,
      };
      let calls = 0;
      expect(canResumeSupervisorJournal(saved, null)).toBe(false);
      expect(canResumeSupervisorJournal(saved, "timeout")).toBe(false);
      expect(
        await resumeWorkjetSupervisorTurn(
          saved,
          CommandId.make("observation-after-refusal"),
          {
            save: async () => {
              throw new Error("A refused intent must not be rewritten");
            },
          },
          async () => {
            calls += 1;
            return { _tag: "failed", code };
          },
        ),
      ).toEqual({ _tag: "failed", code });
      expect(calls).toBe(0);
    },
  );
  it("recovers a lost submit reply with the same saved command, then watches the native execution", async () => {
    const state: { saved: WorkjetSupervisorJournal | null } = { saved: null };
    const journal = {
      save: async (value: WorkjetSupervisorJournal) => {
        state.saved = structuredClone(value);
      },
    };
    const runs = new Map<string, typeof turn>();
    let loseFirstReply = true;
    const submitted: unknown[] = [];
    const observed: string[] = [];
    const port: WorkjetProjectControlPort = async (instanceId, request) => {
      expect(instanceId).toBe(intent.instanceId);
      expect(state.saved?.intent.commandId).toBe(intent.commandId);
      if (request.action === "project.supervisor.bind")
        return {
          _tag: "completed",
          response: {
            action: request.action,
            commandId: request.commandId,
            projectId: request.projectId,
            binding,
          },
        };
      if (request.action === "project.supervisor.turn.submit") {
        submitted.push(request);
        if (!runs.has(request.commandId)) runs.set(request.commandId, turn);
        if (loseFirstReply) {
          loseFirstReply = false;
          return { _tag: "failed", code: "timeout" };
        }
        return {
          _tag: "completed",
          response: {
            action: request.action,
            commandId: request.commandId,
            projectId: request.projectId,
            binding,
            contract: "ctox.workjet.supervisor_turn.v1",
            messageId: "native-message-1",
            turn,
          },
        };
      }
      if (request.action === "project.supervisor.turn.watch") {
        observed.push(request.targetCommandId);
        return {
          _tag: "completed",
          response: {
            action: request.action,
            commandId: request.commandId,
            projectId: request.projectId,
            binding,
            contract: "ctox.workjet.supervisor_turn.v1",
            turn: {
              ...turn,
              executionPhase: "terminal",
              status: "completed",
              queueStatus: "completed",
              terminal: true,
              result: "Change completed.",
            },
          },
        };
      }
      return { _tag: "failed", code: "unsupported" };
    };
    expect(await submitWorkjetSupervisorTurn(intent, journal, port)).toEqual({
      _tag: "failed",
      code: "timeout",
    });
    expect(state.saved).toEqual({ intent, turn: null, submission: "awaiting-receipt" });
    expect(canResumeSupervisorJournal(state.saved, "timeout")).toBe(true);
    expect(canResumeSupervisorJournal(state.saved, null)).toBe(true);
    for (const refusal of [
      "authentication_required",
      "unsupported",
      "guest_failed",
      "local_failed",
    ])
      expect(canResumeSupervisorJournal(state.saved, refusal)).toBe(false);
    // A fresh UI/runtime uses only persisted intent; it has no in-memory send token.
    await resumeWorkjetSupervisorTurn(
      structuredClone(state.saved!),
      CommandId.make("watch-after-reopen"),
      journal,
      port,
    );
    expect(runs.size).toBe(1);
    expect(submitted).toHaveLength(2);
    expect(submitted[1]).toEqual(submitted[0]);
    await resumeWorkjetSupervisorTurn(
      structuredClone(state.saved!),
      CommandId.make("watch-after-submit"),
      journal,
      port,
    );
    expect(observed).toEqual([turn.commandId]);
    expect(canResumeSupervisorJournal(state.saved, null)).toBe(false);
    expect(canResumeSupervisorJournal(state.saved, "timeout")).toBe(false);
    expect(state.saved?.turn).toMatchObject({
      taskId: turn.taskId,
      commandId: turn.commandId,
      attempt: 1,
      terminal: true,
      result: "Change completed.",
    });
  });
  it("records a pre-submit refusal without treating a lost submit reply as a refusal", async () => {
    const observations: WorkjetSupervisorJournal[] = [];
    const result = await submitWorkjetSupervisorTurn(
      intent,
      {
        save: async (value) => {
          observations.push(value);
        },
      },
      async (_instance, request) => {
        expect(request.action).toBe("project.supervisor.bind");
        return { _tag: "failed", code: "unsupported" };
      },
    );
    expect(result).toEqual({ _tag: "failed", code: "unsupported" });
    expect(observations.map((value) => value.submission)).toEqual(["prepared", "not-submitted"]);
    expect(observations.at(-1)?.submissionError).toBe("unsupported");
    expect(canResumeSupervisorJournal(observations.at(-1)!, null)).toBe(false);
    expect(canResumeSupervisorJournal(observations.at(-1)!, "timeout")).toBe(false);
  });

  it("does not dispatch if saving the intent fails", async () => {
    let calls = 0;
    await expect(
      submitWorkjetSupervisorTurn(
        intent,
        {
          save: async () => {
            throw new Error("disk unavailable");
          },
        },
        async () => {
          calls += 1;
          return { _tag: "failed", code: "unsupported" };
        },
      ),
    ).rejects.toThrow("disk unavailable");
    expect(calls).toBe(0);
  });
  it("rejects a receipt for another native execution and keeps the original intent", async () => {
    let saved: WorkjetSupervisorJournal | null = null;
    const result = await resumeWorkjetSupervisorTurn(
      { intent, turn, submission: "confirmed" },
      CommandId.make("watch-1"),
      {
        save: async (value) => {
          saved = value;
        },
      },
      async (_instance, request) => ({
        _tag: "completed",
        response: {
          action: "project.supervisor.turn.watch",
          commandId: "commandId" in request ? request.commandId : CommandId.make("invalid"),
          projectId: intent.projectId,
          binding,
          contract: "ctox.workjet.supervisor_turn.v1",
          turn: { ...turn, commandId: "foreign-execution" },
        },
      }),
    );
    expect(result).toEqual({ _tag: "failed", code: "guest_failed" });
    expect(saved).toBeNull();
  });
});
