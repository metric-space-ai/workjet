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
