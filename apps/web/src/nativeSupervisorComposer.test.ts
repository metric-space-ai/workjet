import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  ProjectId,
  ThreadId,
  CommandId,
  type WorkjetThreadConfig,
  type WorkjetSupervisorJournal,
} from "@workjet/contracts";
import {
  isNativeSupervisorThread,
  nativeSupervisorBlockReason,
  resolveNativeSupervisorScope,
  supervisorJournalMatchesScope,
  persistSupervisorJournal,
  nativeSupervisorResultText,
} from "./nativeSupervisorComposer";

const threadId = ThreadId.make("e28290b0-7b0a-4d19-a242-f27041fadb84");
const projectId = ProjectId.make("71462c13-b395-402f-b6c8-788b405783e7");
const instanceId = "managed:acceptance";
const config: WorkjetThreadConfig = {
  ...DEFAULT_WORKJET_THREAD_CONFIG,
  role: "orchestrator",
  team: {
    role: "supervisor",
    projectId,
    threadId,
    parentThreadId: null,
    goal: "Coordinate",
    createdAt: "2026-10-07T00:00:00.000Z",
  },
};
const project = {
  id: projectId,
  environmentId: EnvironmentId.make("local"),
  ctoxRegistration: {
    instanceId,
    commandId: CommandId.make("registered-project"),
    status: "confirmed" as const,
  },
};
const scope = { instanceId, projectId, threadId };
const journal: WorkjetSupervisorJournal = {
  intent: {
    ...scope,
    commandId: CommandId.make("durable-send"),
    goal: "Build the requested change",
    createdAt: "2026-10-07T00:00:00.000Z",
  },
  turn: null,
  submission: "prepared",
};
const registry = {
  presentationInstanceId: instanceId,
  phase: "ready" as const,
  projects: [{ id: projectId, title: "greppy.xyz", workingCopies: [] }],
  selectedProjectId: null,
};
const input = { config, project, instanceId, threadId, registry, computers: [] };

describe("native supervisor composer authority", () => {
  it("uses persisted project identity, not the registry selection or title", () => {
    expect(resolveNativeSupervisorScope(input)).toEqual(scope);
    expect(isNativeSupervisorThread(config)).toBe(true);
    expect(isNativeSupervisorThread(DEFAULT_WORKJET_THREAD_CONFIG)).toBe(false);
  });
  it("refuses foreign instances, incomplete registry and missing identity", () => {
    expect(resolveNativeSupervisorScope({ ...input, instanceId: "managed:foreign" })).toBeNull();
    expect(
      resolveNativeSupervisorScope({ ...input, registry: { ...registry, refreshFailed: true } }),
    ).toBeNull();
    expect(
      resolveNativeSupervisorScope({ ...input, registry: { ...registry, phase: "loading" } }),
    ).toBeNull();
    expect(
      resolveNativeSupervisorScope({ ...input, project: { ...project, ctoxRegistration: null } }),
    ).toBeNull();
    expect(
      resolveNativeSupervisorScope({ ...input, threadId: ThreadId.make("imported-title") }),
    ).toBeNull();
  });
  it("keeps a stored retry attached to its original instance/project/thread", () => {
    expect(supervisorJournalMatchesScope(journal, scope)).toBe(true);
    expect(
      supervisorJournalMatchesScope(journal, { ...scope, instanceId: "managed:foreign" }),
    ).toBe(false);
    expect(supervisorJournalMatchesScope(journal, { ...scope, threadId: "another-thread" })).toBe(
      false,
    );
    expect(
      supervisorJournalMatchesScope(journal, {
        ...scope,
        projectId: ProjectId.make("another-project"),
      }),
    ).toBe(false);
  });
  it("requires acknowledged durable storage and preserves unrelated configuration", async () => {
    let saved: WorkjetThreadConfig | null = null;
    const next = await persistSupervisorJournal({
      config,
      journal,
      dispatch: async (value) => {
        saved = value;
        return { _tag: "Success" };
      },
    });
    expect(saved).toEqual({ ...config, ctoxSupervisorTurn: journal });
    expect(next.managedInstructions).toBe(config.managedInstructions);
    await expect(
      persistSupervisorJournal({ config, journal, dispatch: async () => ({ _tag: "Failure" }) }),
    ).rejects.toThrow("Could not save");
    await expect(
      persistSupervisorJournal({
        config: DEFAULT_WORKJET_THREAD_CONFIG,
        journal,
        dispatch: async () => ({ _tag: "Success" }),
      }),
    ).rejects.toThrow("identity changed");
  });
  it("retains a confirmed running task when sending or selecting another request", async () => {
    const running: WorkjetSupervisorJournal = {
      ...journal,
      submission: "confirmed",
      turn: {
        commandId: "first-native-command",
        taskId: "first-native-task",
        threadId,
        threadKey: `business-os/threads/${threadId}`,
        executionPhase: "running",
        status: "accepted",
        queueStatus: "running",
        attempt: 1,
        terminal: false,
        result: "**Retained answer**",
        resultTruncated: false,
        errorCode: null,
        errorMessage: null,
      },
    };
    const second = {
      ...journal,
      intent: { ...journal.intent, commandId: CommandId.make("follow-up") },
    };
    const next = await persistSupervisorJournal({
      config: { ...config, ctoxSupervisorTurn: running },
      journal: second,
      dispatch: async () => ({ _tag: "Success" }),
    });
    expect(next).toMatchObject({
      ctoxSupervisorTurn: second,
      ctoxSupervisorPreviousTurns: [running],
    });
    const confirmedSecond: WorkjetSupervisorJournal = {
      ...second,
      submission: "confirmed",
      turn: { ...running.turn!, commandId: "second-native-command", taskId: "second-native-task" },
    };
    const confirmedConfig = await persistSupervisorJournal({
      config: next,
      journal: confirmedSecond,
      dispatch: async () => ({ _tag: "Success" }),
    });
    const restored = await persistSupervisorJournal({
      config: confirmedConfig,
      journal: running,
      dispatch: async () => ({ _tag: "Success" }),
    });
    expect(restored).toMatchObject({
      ctoxSupervisorTurn: running,
      ctoxSupervisorPreviousTurns: [confirmedSecond],
    });
  });
  it("never replaces an uncertain dispatch with another command", async () => {
    let dispatched = false;
    await expect(
      persistSupervisorJournal({
        config: { ...config, ctoxSupervisorTurn: { ...journal, submission: "awaiting-receipt" } },
        journal: {
          ...journal,
          intent: { ...journal.intent, commandId: CommandId.make("second-command") },
        },
        dispatch: async () => {
          dispatched = true;
          return { _tag: "Success" };
        },
      }),
    ).rejects.toThrow("previous CTOX receipt");
    expect(dispatched).toBe(false);
  });
  it("extracts a correlated public reply from the native result object and serialized envelope", () => {
    const turn = { commandId: "native-command", taskId: "native-task", attempt: 1 };
    const result = {
      command_id: turn.commandId,
      execution_task_id: turn.taskId,
      attempt: turn.attempt,
      status: "succeeded",
      user_reply: "The project has three verified next steps.",
      writebacks: [],
    };
    expect(nativeSupervisorResultText(result, turn)).toBe(result.user_reply);
    expect(nativeSupervisorResultText(JSON.stringify(result), turn)).toBe(result.user_reply);
  });
  it("unwraps only a legacy chat envelope belonging to the already-correlated turn", () => {
    const turn = { commandId: "cmd-public", taskId: "native-task", attempt: 1 };
    const reply = "- **Verified** source\n- No completion claimed";
    const legacy = {
      chat_id: "chat_cmd-public",
      outbound_text: reply,
      response: reply,
      answer: reply,
      summary: reply,
      document_writeback: null,
    };
    const result = {
      command_id: turn.commandId,
      execution_task_id: turn.taskId,
      attempt: 1,
      user_reply: JSON.stringify(legacy),
    };
    expect(nativeSupervisorResultText(result, turn)).toBe(reply);
    expect(nativeSupervisorResultText(JSON.stringify(result), turn)).toBe(reply);
    for (const chat of [
      { ...legacy, chat_id: "chat_foreign" },
      { answer: reply },
      { ...legacy, outbound_text: null },
    ]) {
      const user_reply = JSON.stringify(chat);
      expect(nativeSupervisorResultText({ ...result, user_reply }, turn)).toBe(user_reply);
    }
    expect(nativeSupervisorResultText({ ...result, execution_task_id: "foreign" }, turn)).toBe(
      "The result belongs to a different Supervisor turn.",
    );
    expect(nativeSupervisorResultText(JSON.stringify(legacy), turn)).toBe(JSON.stringify(legacy));
  });
  it("never presents another task or attempt's reply as this turn's answer", () => {
    const turn = { commandId: "native-command", taskId: "native-task", attempt: 1 };
    const result = {
      command_id: turn.commandId,
      execution_task_id: turn.taskId,
      attempt: turn.attempt,
      user_reply: "Foreign reply",
    };
    for (const mismatch of [
      { command_id: "another-command" },
      { execution_task_id: "another-task" },
      { attempt: 2 },
    ]) {
      expect(nativeSupervisorResultText({ ...result, ...mismatch }, turn)).toBe(
        "The result belongs to a different Supervisor turn.",
      );
    }
    expect(nativeSupervisorResultText("ordinary reply", turn)).toBe("ordinary reply");
    expect(nativeSupervisorResultText('{"user_reply":"ordinary JSON"}', turn)).toBe(
      '{"user_reply":"ordinary JSON"}',
    );
  });
  it("shows only the received result, without constructing a provider event", () => {
    expect(nativeSupervisorResultText(null)).toBe("");
    expect(nativeSupervisorResultText("Actual native result")).toBe("Actual native result");
    expect(nativeSupervisorResultText({ outcome: "done" })).toBe('{\n  "outcome": "done"\n}');
  });
});

describe("nativeSupervisorBlockReason", () => {
  const ready = {
    presentationInstanceId: "managed:acceptance",
    phase: "ready",
    projects: [],
    selectedProjectId: null,
  } as const;
  it("names a failed project list before anything else", () => {
    expect(
      nativeSupervisorBlockReason({ project: null, registry: { ...ready, refreshFailed: true } }),
    ).toContain("Could not read");
  });
  it("names a project still waiting for CTOX confirmation", () => {
    const project = {
      id: ProjectId.make("p1"),
      environmentId: "env" as never,
      ctoxRegistration: { instanceId: "managed:acceptance", commandId: "c", status: "pending" },
    } as never;
    expect(nativeSupervisorBlockReason({ project, registry: ready })).toContain(
      "waiting for confirmation",
    );
  });
  it("names the missing mapping when the project is confirmed but not bound", () => {
    expect(nativeSupervisorBlockReason({ project: null, registry: ready })).toContain(
      "no confirmed CTOX binding",
    );
  });
});
