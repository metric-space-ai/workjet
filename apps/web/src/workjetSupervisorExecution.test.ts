import {
  CommandId,
  ProjectId,
  nextWorkjetSupervisorExecutionPageRequest,
  type CtoxWorkjetProjectControlResult,
  type WorkjetSupervisorJournal,
} from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { readWorkjetSupervisorExecutionPage } from "./workjetSupervisorExecution";
import type { WorkjetProjectControlPort } from "./workjetProjectControl";

const threadId = "e28290b0-7b0a-4d19-a242-f27041fadb84";
const saved: WorkjetSupervisorJournal = {
  intent: {
    instanceId: "managed:acceptance",
    projectId: ProjectId.make("native-project"),
    threadId,
    commandId: CommandId.make("saved-submit"),
    goal: "Make the project change.",
    createdAt: "2026-10-07T21:00:00.000Z",
  },
  turn: {
    commandId: "native-command",
    taskId: "native-task",
    threadId,
    threadKey: `business-os/threads/${threadId}`,
    executionPhase: "running",
    status: "running",
    queueStatus: "running",
    attempt: 1,
    terminal: false,
    result: null,
    resultTruncated: false,
    errorCode: null,
    errorMessage: null,
  },
  submission: "confirmed",
};
const binding = {
  contract: "ctox.workjet.supervisor_binding.v1",
  projectId: saved.intent.projectId,
  threadId,
  threadKey: saved.turn!.threadKey,
} as const;
const event = {
  id: "native-event",
  sequence: 12,
  kind: "worker.phase",
  title: "Recorded step",
  created_at_ms: 1791410400000,
};
const page = {
  command_id: saved.turn!.commandId,
  task_id: saved.turn!.taskId!,
  attempt: { attempt_id: "native-attempt", attempt_index: 47 },
  events: [event],
  next_cursor: { after_sequence: 12, after_event_id: event.id },
  has_more: true,
};
const response = {
  action: "project.supervisor.turn.watch",
  commandId: CommandId.make("observe-one"),
  projectId: saved.intent.projectId,
  contract: "ctox.workjet.supervisor_turn.v1",
  binding,
  turn: saved.turn!,
  executionContract: "ctox.workjet.supervisor_execution.v1",
  executionPage: page,
} as const;

describe("bounded installed supervisor observer", () => {
  it("backfills pages with native event IDs under a fixed attempt without dispatching a turn", async () => {
    const requests: string[] = [];
    const journals: WorkjetSupervisorJournal[] = [];
    const port: WorkjetProjectControlPort = async (instanceId, request) => {
      expect(instanceId).toBe(saved.intent.instanceId);
      expect(request.action).toBe("project.supervisor.turn.watch");
      if (request.action !== "project.supervisor.turn.watch")
        throw new Error("An observer must not submit.");
      requests.push(request.commandId);
      const isNext = request.executionPage?.cursor !== undefined;
      if (isNext)
        expect(request.executionPage).toEqual(nextWorkjetSupervisorExecutionPageRequest(page));
      const nextEvent = { ...event, id: "native-event-two", sequence: 19 };
      return {
        _tag: "completed",
        response: {
          ...response,
          commandId: request.commandId,
          executionPage: isNext
            ? {
                ...page,
                events: [nextEvent],
                next_cursor: { after_sequence: 19, after_event_id: nextEvent.id },
                has_more: false,
              }
            : page,
        },
      };
    };
    const journal = {
      save: async (value: WorkjetSupervisorJournal) => {
        journals.push(value);
      },
    };
    const first = await readWorkjetSupervisorExecutionPage(
      saved,
      response.commandId,
      journal,
      {},
      port,
    );
    expect(first._tag).toBe("completed");
    const second = await readWorkjetSupervisorExecutionPage(
      saved,
      CommandId.make("observe-two"),
      journal,
      nextWorkjetSupervisorExecutionPageRequest(page),
      port,
    );
    expect(second._tag).toBe("completed");
    expect(requests).toEqual(["observe-one", "observe-two"]);
    expect(
      journals.map((value) => [value.turn?.commandId, value.turn?.taskId, value.turn?.attempt]),
    ).toEqual([
      ["native-command", "native-task", 1],
      ["native-command", "native-task", 1],
    ]);
  });
  it("reports an older installed shell's missing observer explicitly", async () => {
    const { executionContract: _contract, executionPage: _page, ...legacy } = response;
    const result = await readWorkjetSupervisorExecutionPage(
      saved,
      response.commandId,
      {
        save: async () => {
          throw new Error("No valid observer receipt to persist.");
        },
      },
      {},
      async () => ({ _tag: "completed", response: legacy }),
    );
    expect(result).toEqual({ _tag: "failed", code: "unsupported" });
  });
  it("rejects foreign attempt pages and unsafe tool output without persisting them", async () => {
    for (const executionPage of [
      { ...page, attempt: { attempt_id: "foreign" } },
      { ...page, events: [{ ...event, arguments: { secret: "private" } }] },
      { ...page, next_cursor: { after_sequence: 12, after_event_id: "foreign" } },
    ]) {
      const result = await readWorkjetSupervisorExecutionPage(
        saved,
        response.commandId,
        {
          save: async () => {
            throw new Error("Foreign facts must not persist.");
          },
        },
        { attempt_id: "native-attempt" },
        async () =>
          ({
            _tag: "completed",
            response: { ...response, executionPage },
          }) as unknown as CtoxWorkjetProjectControlResult,
      );
      expect(result).toEqual({ _tag: "failed", code: "guest_failed" });
    }
  });
  it("refuses observation before a confirmed submit and a cursor without its attempt", async () => {
    const port: WorkjetProjectControlPort = async () => {
      throw new Error("No native request allowed.");
    };
    const journal = {
      save: async () => {
        throw new Error("No journal update allowed.");
      },
    };
    expect(
      await readWorkjetSupervisorExecutionPage(
        { ...saved, turn: null, submission: "awaiting-receipt" },
        response.commandId,
        journal,
        {},
        port,
      ),
    ).toEqual({ _tag: "failed", code: "invalid_input" });
    expect(
      await readWorkjetSupervisorExecutionPage(
        saved,
        response.commandId,
        journal,
        { cursor: page.next_cursor },
        port,
      ),
    ).toEqual({ _tag: "failed", code: "invalid_input" });
  });
});
