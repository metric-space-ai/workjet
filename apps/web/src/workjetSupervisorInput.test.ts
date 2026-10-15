import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  ProjectId,
  type CtoxWorkjetProjectControlRequest,
  type CtoxWorkjetProjectControlResult,
  type WorkjetSupervisorJournal,
  type WorkjetSupervisorInputIntent,
} from "@workjet/contracts";
import { submitWorkjetSupervisorInput } from "./workjetSupervisorInput";
import { resumeWorkjetSupervisorTurn } from "./workjetSupervisorControl";

const intent: WorkjetSupervisorInputIntent = {
  instanceId: "managed:acceptance",
  projectId: ProjectId.make("71462c13-b395-402f-b6c8-788b405783e7"),
  threadId: "e28290b0-7b0a-4d19-a242-f27041fadb84",
  targetCommandId: "native-command",
  commandId: CommandId.make("saved-owner-input"),
  body: "Use the attached checked PR evidence.",
  createdAt: "2026-10-09T19:00:00.000Z",
};
const binding = {
  contract: "ctox.workjet.supervisor_binding.v1",
  projectId: intent.projectId,
  threadId: intent.threadId,
  threadKey: `business-os/threads/${intent.threadId}`,
} as const;
const turn = {
  commandId: intent.targetCommandId,
  taskId: "native-task",
  threadId: intent.threadId,
  threadKey: binding.threadKey,
  executionPhase: "running",
  status: "accepted",
  queueStatus: "retry_wait",
  attempt: 4,
  terminal: false,
  result: null,
  resultTruncated: false,
  errorCode: null,
  errorMessage: null,
} as const;
const saved: WorkjetSupervisorJournal = {
  intent: {
    instanceId: intent.instanceId,
    projectId: intent.projectId,
    threadId: intent.threadId,
    commandId: CommandId.make("original-submit"),
    goal: "Review the open PR.",
    createdAt: intent.createdAt,
  },
  turn,
  submission: "confirmed",
};
function capability(request: CtoxWorkjetProjectControlRequest): CtoxWorkjetProjectControlResult {
  if (request.action !== "project.supervisor.turn.capabilities" || request.includeInput !== true)
    throw new Error("Expected an explicit scoped input capability read.");
  return {
    _tag: "completed",
    response: {
      action: request.action,
      commandId: request.commandId,
      projectId: intent.projectId,
      contract: "ctox.workjet.supervisor_turn_capabilities.v1",
      binding,
      turnKinds: ["work", "conversation"],
      defaultTurnKind: "work",
      inputContract: "ctox.workjet.supervisor_input.v1",
      inputDelivery: "next_slice",
      maxInputChars: 4096,
    },
  };
}
const receipt = {
  action: "project.supervisor.turn.input",
  commandId: intent.commandId,
  projectId: intent.projectId,
  contract: "ctox.workjet.supervisor_input.v1",
  binding,
  turn,
  input: { inputId: "native-input", sequence: 1, body: intent.body, createdAt: intent.createdAt },
  delivery: "next_slice",
  workerInterrupted: false,
} as const;

describe("durable same-task Supervisor context", () => {
  it("recovers a lost receipt with the same input ID and preserves it through later watches", async () => {
    let state = saved;
    const requests: CtoxWorkjetProjectControlRequest[] = [];
    const admitted = new Set<string>();
    let loseFirst = true;
    const journal = {
      save: async (next: WorkjetSupervisorJournal) => {
        state = structuredClone(next);
      },
    };
    const port = async (
      _instance: string,
      request: CtoxWorkjetProjectControlRequest,
    ): Promise<CtoxWorkjetProjectControlResult> => {
      requests.push(request);
      if (request.action === "project.supervisor.turn.capabilities") return capability(request);
      if (request.action === "project.supervisor.turn.watch")
        return {
          _tag: "completed",
          response: {
            action: request.action,
            commandId: request.commandId,
            projectId: intent.projectId,
            contract: "ctox.workjet.supervisor_turn.v1",
            binding,
            turn: { ...turn, attempt: 5 },
          },
        };
      if (request.action !== "project.supervisor.turn.input")
        throw new Error("Must not create, cancel or resubmit the task.");
      expect(state.inputs?.[0]?.submission).toBe("awaiting-receipt");
      admitted.add(request.commandId);
      if (loseFirst) {
        loseFirst = false;
        throw new Error("receipt transport closed");
      }
      return { _tag: "completed", response: receipt };
    };
    await expect(submitWorkjetSupervisorInput(state, intent, journal, port)).rejects.toThrow(
      "transport closed",
    );
    expect(state.inputs?.[0]?.intent).toEqual(intent);
    expect(state.inputs?.[0]?.submission).toBe("awaiting-receipt");
    expect((await submitWorkjetSupervisorInput(state, intent, journal, port))._tag).toBe(
      "completed",
    );
    expect(admitted.size).toBe(1);
    expect(requests.filter((r) => r.action === "project.supervisor.turn.input")).toEqual([
      {
        action: "project.supervisor.turn.input",
        commandId: intent.commandId,
        projectId: intent.projectId,
        threadId: intent.threadId,
        targetCommandId: turn.commandId,
        body: intent.body,
      },
      {
        action: "project.supervisor.turn.input",
        commandId: intent.commandId,
        projectId: intent.projectId,
        threadId: intent.threadId,
        targetCommandId: turn.commandId,
        body: intent.body,
      },
    ]);
    await resumeWorkjetSupervisorTurn(state, CommandId.make("later-watch"), journal, port);
    expect(state.inputs?.[0]?.receipt).toEqual(receipt);
    const count = requests.length;
    await submitWorkjetSupervisorInput(state, intent, journal, port);
    expect(requests.length).toBe(count);
  });

  it("does not replace an observed task hold with an older idempotent input receipt", async () => {
    const held: WorkjetSupervisorJournal = {
      ...saved,
      turn: { ...turn, executionPhase: "blocked", queueStatus: "blocked" },
      inputs: [{ intent, receipt: null, submission: "awaiting-receipt" }],
    };
    let state = held;
    await submitWorkjetSupervisorInput(
      held,
      intent,
      {
        save: async (next) => {
          state = next;
        },
      },
      async (_id, request) =>
        request.action === "project.supervisor.turn.capabilities"
          ? capability(request)
          : { _tag: "completed", response: receipt },
    );
    expect(state.turn).toEqual(held.turn);
    expect(state.inputs?.[0]?.receipt).toEqual(receipt);
  });

  it("recovers an admitted input after the task finishes without reverting its current state", async () => {
    const finished: WorkjetSupervisorJournal = {
      ...saved,
      turn: {
        ...turn,
        executionPhase: "terminal",
        queueStatus: "completed",
        terminal: true,
        status: "completed",
        attempt: 5,
        result: "Completed",
      },
      inputs: [{ intent, receipt: null, submission: "awaiting-receipt" }],
    };
    let state = finished;
    await submitWorkjetSupervisorInput(
      finished,
      intent,
      {
        save: async (next) => {
          state = next;
        },
      },
      async (_id, request) =>
        request.action === "project.supervisor.turn.capabilities"
          ? capability(request)
          : { _tag: "completed", response: receipt },
    );
    expect(state.turn).toEqual(finished.turn);
    expect(state.inputs?.[0]?.receipt).toEqual(receipt);
    await expect(
      submitWorkjetSupervisorInput(
        finished,
        { ...intent, commandId: CommandId.make("new-context") },
        { save: async () => {} },
      ),
    ).rejects.toThrow("This task has finished");
  });

  it("never sends input without opt-in support", async () => {
    const requests: CtoxWorkjetProjectControlRequest[] = [];
    const result = await submitWorkjetSupervisorInput(
      saved,
      intent,
      { save: async () => {} },
      async (_id, request) => {
        requests.push(request);
        return { _tag: "failed", code: "unsupported" };
      },
    );
    expect(result).toEqual({ _tag: "failed", code: "unsupported" });
    expect(requests.map((r) => r.action)).toEqual(["project.supervisor.turn.capabilities"]);
  });

  it("does not dispatch if the local input identity cannot be saved", async () => {
    let dispatched = false;
    await expect(
      submitWorkjetSupervisorInput(
        saved,
        intent,
        {
          save: async () => {
            throw new Error("save failed");
          },
        },
        async () => {
          dispatched = true;
          return { _tag: "failed", code: "timeout" };
        },
      ),
    ).rejects.toThrow("save failed");
    expect(dispatched).toBe(false);
  });

  it.each(["task", "body", "target"] as const)(
    "rejects a foreign %s receipt without claiming delivery",
    async (field) => {
      let state = saved;
      const result = await submitWorkjetSupervisorInput(
        saved,
        intent,
        {
          save: async (next) => {
            state = next;
          },
        },
        async (_id, request) => {
          if (request.action === "project.supervisor.turn.capabilities") return capability(request);
          return {
            _tag: "completed",
            response: {
              ...receipt,
              turn: {
                ...turn,
                taskId: field === "task" ? "foreign" : turn.taskId,
                commandId: field === "target" ? "foreign" : turn.commandId,
              },
              input: { ...receipt.input, body: field === "body" ? "foreign" : intent.body },
            },
          };
        },
      );
      expect(result).toEqual({ _tag: "failed", code: "guest_failed" });
      expect(state.inputs?.[0]?.submission).toBe("awaiting-receipt");
    },
  );

  it("refuses a changed payload for a saved idempotent input", async () => {
    const prepared: WorkjetSupervisorJournal = {
      ...saved,
      inputs: [{ intent, receipt: null, submission: "awaiting-receipt" }],
    };
    await expect(
      submitWorkjetSupervisorInput(
        prepared,
        { ...intent, body: "changed" },
        { save: async () => {} },
      ),
    ).rejects.toThrow("different context");
  });
});
