import { describe, expect, it } from "vite-plus/test";
import { CommandId, ProjectId } from "./baseSchemas.ts";
import { DEFAULT_WORKJET_THREAD_CONFIG, type WorkjetThreadConfig } from "./workjet.ts";
import { retainWorkjetCtoxBinding } from "./workjetCtoxBinding.ts";
import type { WorkjetSupervisorJournal } from "./workjetSupervisor.ts";

const intent = {
  instanceId: "managed:acceptance",
  projectId: ProjectId.make("native-project-one"),
  threadId: "e28290b0-7b0a-4d19-a242-f27041fadb84",
  commandId: CommandId.make("persisted-submit-one"),
  goal: "Make the project change.",
  createdAt: "2026-10-07T21:00:00.000Z",
};
const pending: WorkjetSupervisorJournal = { intent, turn: null, submission: "awaiting-receipt" };
const turn = {
  commandId: "actual-native-command",
  taskId: "actual-native-task",
  threadId: intent.threadId,
  threadKey: `business-os/threads/${intent.threadId}`,
  executionPhase: "running",
  status: "running",
  queueStatus: "running",
  attempt: 1,
  terminal: false,
  result: null,
  resultTruncated: false,
  errorCode: null,
  errorMessage: null,
};
const config = (journal: WorkjetSupervisorJournal): WorkjetThreadConfig => ({
  ...DEFAULT_WORKJET_THREAD_CONFIG,
  ctoxSupervisorTurn: journal,
});

describe("server-retained supervisor submission", () => {
  it("keeps an uncertain command across unrelated configuration updates", () => {
    const retained = retainWorkjetCtoxBinding(config(pending), DEFAULT_WORKJET_THREAD_CONFIG);
    expect(retained.error).toBeNull();
    expect(retained.config).toMatchObject({ ctoxSupervisorTurn: pending });
  });
  it("refuses a second logical submit before the first receipt or terminal result", () => {
    const second = {
      ...pending,
      intent: { ...intent, commandId: CommandId.make("second-submit") },
    };
    expect(retainWorkjetCtoxBinding(config(pending), config(second)).error).toContain(
      "still unresolved",
    );
    expect(
      retainWorkjetCtoxBinding(
        config({ ...pending, turn, submission: "confirmed" }),
        config(second),
      ).error,
    ).toContain("still unresolved");
  });
  it("allows a separate request only when the confirmed prior receipt remains durable", () => {
    const confirmed: WorkjetSupervisorJournal = { intent, turn, submission: "confirmed" };
    const second = {
      ...pending,
      intent: { ...intent, commandId: CommandId.make("new-owner-message") },
    };
    const next = { ...config(second), ctoxSupervisorPreviousTurns: [confirmed] };
    expect(retainWorkjetCtoxBinding(config(confirmed), next).error).toBeNull();
    expect(
      retainWorkjetCtoxBinding(config(pending), { ...next, ctoxSupervisorPreviousTurns: [pending] })
        .error,
    ).toContain("still unresolved");
    expect(
      retainWorkjetCtoxBinding(config(confirmed), {
        ...next,
        ctoxSupervisorPreviousTurns: [{ ...confirmed, turn: { ...turn, taskId: "forged" } }],
      }).error,
    ).not.toBeNull();
  });
  it("retains previous tasks on unrelated settings changes and cannot erase or retarget active tasks", () => {
    const confirmed: WorkjetSupervisorJournal = { intent, turn, submission: "confirmed" };
    const nextIntent = { ...intent, commandId: CommandId.make("new-owner-message") };
    const nextJournal: WorkjetSupervisorJournal = {
      intent: nextIntent,
      submission: "confirmed",
      turn: { ...turn, commandId: "new-native-command", taskId: "new-native-task" },
    };
    const before = { ...config(nextJournal), ctoxSupervisorPreviousTurns: [confirmed] };
    expect(retainWorkjetCtoxBinding(before, DEFAULT_WORKJET_THREAD_CONFIG).config).toMatchObject({
      ctoxSupervisorPreviousTurns: [confirmed],
      ctoxSupervisorTurn: nextJournal,
    });
    expect(
      retainWorkjetCtoxBinding(before, { ...before, ctoxSupervisorPreviousTurns: [] }).error,
    ).toContain("cannot be removed");
    const selected = { ...config(confirmed), ctoxSupervisorPreviousTurns: [nextJournal] };
    expect(retainWorkjetCtoxBinding(before, selected).error).toBeNull();
    expect(
      retainWorkjetCtoxBinding(before, {
        ...selected,
        ctoxSupervisorTurn: { ...confirmed, turn: { ...turn, taskId: "foreign-task" } },
      }).error,
    ).not.toBeNull();
  });
  it("cannot change the retry payload, erase uncertainty, or replace the native identity", () => {
    const confirmed: WorkjetSupervisorJournal = { intent, turn, submission: "confirmed" };
    for (const changed of [
      { ...pending, intent: { ...intent, goal: "Different goal" } },
      { ...pending, intent: { ...intent, instanceId: "managed:foreign" } },
      { ...pending, submission: "prepared" as const },
      { ...pending, submission: "not-submitted" as const, submissionError: "unsupported" as const },
    ])
      expect(retainWorkjetCtoxBinding(config(pending), config(changed)).error).not.toBeNull();
    expect(retainWorkjetCtoxBinding(config(confirmed), config(pending)).error).not.toBeNull();
    expect(
      retainWorkjetCtoxBinding(
        config(confirmed),
        config({ ...confirmed, turn: { ...turn, taskId: "foreign-task" } }),
      ).error,
    ).not.toBeNull();
    expect(
      retainWorkjetCtoxBinding(
        config(confirmed),
        config({ ...confirmed, turn: { ...turn, attempt: 0 } }),
      ).error,
    ).not.toBeNull();
  });
  it("permits another turn after confirmed completion or a failure before dispatch", () => {
    const second = {
      intent: { ...intent, commandId: CommandId.make("next-logical-submit") },
      turn: null,
      submission: "prepared" as const,
    };
    const completed: WorkjetSupervisorJournal = {
      intent,
      turn: { ...turn, executionPhase: "terminal", status: "completed", terminal: true },
      submission: "confirmed",
    };
    expect(retainWorkjetCtoxBinding(config(completed), config(second)).error).toBeNull();
    const rejected: WorkjetSupervisorJournal = {
      intent,
      turn: null,
      submission: "not-submitted",
      submissionError: "unsupported",
    };
    expect(retainWorkjetCtoxBinding(config(rejected), config(second)).error).toBeNull();
  });
});
