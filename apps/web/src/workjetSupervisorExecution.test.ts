import {
  CommandId,
  DEFAULT_MODEL,
  ProjectId,
  nextWorkjetSupervisorExecutionPageRequest,
  type CtoxWorkjetProjectControlResult,
  type WorkjetSupervisorJournal,
} from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  readWorkjetSupervisorExecutionPage,
  readWorkjetSupervisorPublicExecutionPage,
} from "./workjetSupervisorExecution";
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

describe("native public reply reader", () => {
  it("forwards the opt-in and preserves actual text without another submit", async () => {
    const result = await readWorkjetSupervisorPublicExecutionPage(
      saved,
      response.commandId,
      { save: async () => {} },
      { include_public_text: true },
      async (instanceId, request) => {
        expect(instanceId).toBe(saved.intent.instanceId);
        expect(request.action).toBe("project.supervisor.turn.watch");
        if (request.action !== "project.supervisor.turn.watch")
          throw new Error("No submit allowed");
        expect(request.executionPage?.include_public_text).toBe(true);
        return {
          _tag: "completed",
          response: {
            ...response,
            commandId: request.commandId,
            executionPage: {
              ...page,
              public_text_supported: true,
              events: [
                {
                  ...event,
                  kind: "worker.assistant_text",
                  public_text: {
                    turn_id: "turn",
                    item_id: "item",
                    phase: "final_answer",
                    offset: 0,
                    text: "Actual public text",
                    completed: false,
                    truncated: false,
                  },
                },
              ],
            },
          },
        };
      },
    );
    expect(result._tag).toBe("completed");
  });
  it("uses a new observation identity for the bounded legacy read, retaining the exact task", async () => {
    const seen: string[] = [];
    const result = await readWorkjetSupervisorPublicExecutionPage(
      saved,
      response.commandId,
      { save: async () => {} },
      { include_public_text: true },
      async (_instanceId, request) => {
        if (request.action !== "project.supervisor.turn.watch")
          throw new Error("No submit allowed");
        expect(request.targetCommandId).toBe(saved.turn!.commandId);
        seen.push(request.commandId);
        if (request.executionPage?.include_public_text)
          return { _tag: "failed", code: "unsupported" };
        expect(request.executionPage).toEqual({});
        return { _tag: "completed", response: { ...response, commandId: request.commandId } };
      },
    );
    expect(result._tag).toBe("completed");
    expect(seen).toEqual(["observe-one", "observe-one:legacy"]);
    if (result._tag === "completed" && result.response.action === "project.supervisor.turn.watch")
      expect(result.response.executionPage?.public_text_supported).toBeUndefined();
  });
  it("does not retry authorization failures or use a different instance", async () => {
    let calls = 0;
    const result = await readWorkjetSupervisorPublicExecutionPage(
      saved,
      response.commandId,
      { save: async () => {} },
      { include_public_text: true },
      async (instanceId) => {
        calls++;
        expect(instanceId).toBe(saved.intent.instanceId);
        return { _tag: "failed", code: "authentication_required" };
      },
    );
    expect(calls).toBe(1);
    expect(result).toEqual({ _tag: "failed", code: "authentication_required" });
  });
});

describe("selected native message reader", () => {
  it("opts into native Messages text and retains the actual command/task/attempt", async () => {
    const journals: WorkjetSupervisorJournal[] = [];
    const result = await readWorkjetSupervisorPublicExecutionPage(
      saved,
      response.commandId,
      {
        save: async (journal) => {
          journals.push(journal);
        },
      },
      undefined,
      async (instanceId, request) => {
        expect(instanceId).toBe(saved.intent.instanceId);
        if (request.action !== "project.supervisor.turn.watch")
          throw new Error("No submit allowed");
        expect(request.targetCommandId).toBe(saved.turn!.commandId);
        expect(request.executionPage).toEqual({
          include_public_text: true,
          include_native_message_text: true,
        });
        return {
          _tag: "completed",
          response: {
            ...response,
            commandId: request.commandId,
            executionPage: {
              ...page,
              native_message_text_supported: true,
              events: [
                {
                  ...event,
                  kind: "worker.native_message_text",
                  native_message_text: {
                    execution_key: "native-execution",
                    model_operation_id: "native-operation",
                    native_message_id: "upstream-message",
                    upstream_request_id: "upstream-request",
                    model: DEFAULT_MODEL,
                    offset: 0,
                    text: "Partial native text",
                    completed: true,
                  },
                },
              ],
            },
          },
        };
      },
    );
    expect(result._tag).toBe("completed");
    expect(journals).toHaveLength(1);
    expect(journals[0]?.turn).toEqual(saved.turn); // message_stop cannot close the running task.
    if (result._tag === "completed" && result.response.action === response.action)
      expect(result.response.executionPage?.events[0]?.native_message_text?.native_message_id).toBe(
        "upstream-message",
      );
  });
  it("removes only unsupported text opt-ins during bounded same-attempt compatibility reads", async () => {
    const seen: string[] = [];
    const requestedAttempt = "native-attempt";
    const cursor = page.next_cursor;
    const result = await readWorkjetSupervisorPublicExecutionPage(
      saved,
      response.commandId,
      { save: async () => {} },
      {
        include_native_message_text: true,
        include_public_text: true,
        attempt_id: requestedAttempt,
        cursor,
      },
      async (instanceId, request) => {
        expect(instanceId).toBe(saved.intent.instanceId);
        if (request.action !== "project.supervisor.turn.watch")
          throw new Error("No submit allowed");
        expect(request.targetCommandId).toBe(saved.turn!.commandId);
        expect(request.executionPage?.attempt_id).toBe(requestedAttempt);
        expect(request.executionPage?.cursor).toEqual(cursor);
        seen.push(request.commandId);
        if (
          request.executionPage?.include_native_message_text ||
          request.executionPage?.include_public_text
        )
          return { _tag: "failed", code: "unsupported" };
        return {
          _tag: "completed",
          response: {
            ...response,
            commandId: request.commandId,
            executionPage: {
              ...page,
              events: [{ ...event, id: "next-event", sequence: 13 }],
              next_cursor: { after_sequence: 13, after_event_id: "next-event" },
            },
          },
        };
      },
    );
    expect(result._tag).toBe("completed");
    expect(seen).toEqual(["observe-one", "observe-one:public", "observe-one:public:legacy"]);
    if (result._tag === "completed" && result.response.action === response.action)
      expect(result.response.executionPage?.native_message_text_supported).toBeUndefined();
  });
  it("does not retry native text reads denied by actual authority", async () => {
    let calls = 0;
    const result = await readWorkjetSupervisorPublicExecutionPage(
      saved,
      response.commandId,
      { save: async () => {} },
      undefined,
      async () => {
        calls++;
        return { _tag: "failed", code: "authentication_required" };
      },
    );
    expect(calls).toBe(1);
    expect(result).toEqual({ _tag: "failed", code: "authentication_required" });
  });
});
