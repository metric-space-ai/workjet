import {
  CommandId,
  EnvironmentId,
  DEFAULT_WORKJET_THREAD_CONFIG,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationCommand,
} from "@workjet/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-08-25T12:00:00.000Z";
const COPY_AT = "2026-08-25T12:03:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const MESSAGE_ID = MessageId.make("message-1");
const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [
    {
      id: ProjectId.make("project-1"),
      title: "Destination",
      workspaceRoot: "/destination",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: THREAD_ID,
      projectId: ProjectId.make("project-1"),
      title: "Imported",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: NOW,
};

const bootstrapCommand: Extract<OrchestrationCommand, { type: "thread.history.import" }> = {
  type: "thread.history.import",
  commandId: CommandId.make("bootstrap-copy"),
  threadId: THREAD_ID,
  messages: [
    { messageId: MESSAGE_ID, role: "user", text: "Copied", createdAt: NOW },
    { messageId: MessageId.make("reply-1"), role: "assistant", text: "Preserved", createdAt: NOW },
  ],
  bootstrap: {
    createThread: {
      projectId: ProjectId.make("project-1"),
      title: "Imported",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
      branch: null,
      worktreePath: null,
      createdAt: NOW,
    },
  },
  createdAt: NOW,
};
const freshReadModel: OrchestrationReadModel = {
  ...readModel,
  threads: [],
  projects: [
    {
      id: ProjectId.make("project-1"),
      title: "Destination",
      workspaceRoot: "/destination",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    },
  ],
};
it.layer(NodeServices.layer)("static history import decider", (it) => {
  it.effect("switching back appends only the completed common transcript's new messages", () =>
    Effect.gen(function* () {
      const existing = bootstrapCommand.messages.slice(0, 1).map((message) => ({
        id: message.messageId,
        role: message.role,
        text: message.text,
        attachments: [],
        turnId: null,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      }));
      const result = yield* decideOrchestrationCommand({
        readModel: { ...readModel, threads: [{ ...readModel.threads[0]!, messages: existing }] },
        command: {
          type: "thread.continuation.import",
          commandId: CommandId.make("switch-back"),
          threadId: THREAD_ID,
          createThread: bootstrapCommand.bootstrap!.createThread,
          sourceEnvironmentId: EnvironmentId.make("source-computer"),
          sourceLabel: "Source computer",
          messages: bootstrapCommand.messages,
          createdAt: NOW,
        },
      });
      const events = Array.isArray(result) ? result : [result];
      expect(
        events
          .filter((event) => event.type === "thread.message-sent")
          .map((event) => event.payload.messageId),
      ).toEqual([MessageId.make("reply-1")]);
      expect(events.at(-1)).toMatchObject({
        payload: {
          activity: {
            payload: {
              historyContinuation: {
                messageIds: bootstrapCommand.messages.map((message) => message.messageId),
              },
            },
          },
        },
      });
    }),
  );

  it.effect(
    "rejects a busy destination, a missing checkout, and a newer destination transcript",
    () =>
      Effect.gen(function* () {
        const command = {
          type: "thread.continuation.import" as const,
          commandId: CommandId.make("unsafe-switch"),
          threadId: THREAD_ID,
          createThread: bootstrapCommand.bootstrap!.createThread,
          sourceEnvironmentId: EnvironmentId.make("source-computer"),
          sourceLabel: "Source computer",
          messages: bootstrapCommand.messages,
          createdAt: NOW,
        };
        const thread = readModel.threads[0]!;
        const busy = {
          ...thread,
          session: {
            threadId: THREAD_ID,
            status: "running" as const,
            providerName: "codex" as const,
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "approval-required" as const,
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
        };
        const cases = [
          { model: { ...readModel, threads: [busy] }, reason: "Finish the destination turn" },
          {
            model: {
              ...freshReadModel,
              projects: [{ ...freshReadModel.projects[0]!, workspaceRoot: null }],
            },
            reason: "needs its own checkout",
          },
          {
            model: {
              ...readModel,
              threads: [
                {
                  ...thread,
                  messages: Array.from({ length: 3 }, (_, index) => ({
                    id: MessageId.make(`newer-${index}`),
                    role: "user" as const,
                    text: "Destination message",
                    attachments: [],
                    turnId: null,
                    streaming: false,
                    createdAt: NOW,
                    updatedAt: NOW,
                  })),
                },
              ],
            },
            reason: "newer conversation history",
          },
        ];
        for (const { model, reason } of cases) {
          const failure = yield* decideOrchestrationCommand({ readModel: model, command }).pipe(
            Effect.flip,
          );
          expect(failure).toMatchObject({
            _tag: "OrchestrationCommandInvariantError",
            detail: expect.stringContaining(reason),
          });
        }
      }),
  );

  it.effect("copies a complete transcript atomically across multiple import batches", () =>
    Effect.gen(function* () {
      const messages = Array.from({ length: 450 }, (_, index) => ({
        messageId: MessageId.make(`copied-${index}`),
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `Recorded decision ${index}`,
        createdAt: NOW,
      }));
      const result = yield* decideOrchestrationCommand({
        readModel: freshReadModel,
        command: {
          type: "thread.continuation.import",
          commandId: CommandId.make("computer-copy"),
          threadId: THREAD_ID,
          createThread: bootstrapCommand.bootstrap!.createThread,
          sourceEnvironmentId: EnvironmentId.make("source-computer"),
          sourceLabel: "Source computer",
          messages,
          createdAt: NOW,
        },
      });
      const events = Array.isArray(result) ? result : [result];
      expect(
        events
          .filter((event) => event.type === "thread.message-sent")
          .map((event) => event.payload.messageId),
      ).toEqual(messages.map((message) => message.messageId));
      expect(events.at(-1)).toMatchObject({
        type: "thread.activity-appended",
        payload: {
          activity: {
            kind: "provider.history.transfer",
            payload: {
              historyContinuation: {
                pending: true,
                messageIds: messages.map((message) => message.messageId),
              },
            },
          },
        },
      });
      expect(
        events.some(
          (event) =>
            event.type === "thread.turn-start-requested" || event.type === "thread.session-set",
        ),
      ).toBe(false);
    }),
  );

  it.effect("rejects conflicting destination history without emitting replacement events", () =>
    Effect.gen(function* () {
      const target = {
        ...readModel,
        threads: [
          {
            ...readModel.threads[0]!,
            messages: [
              {
                id: MESSAGE_ID,
                role: "user" as const,
                text: "Newer destination decision",
                attachments: [],
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          },
        ],
      };
      const failure = yield* decideOrchestrationCommand({
        readModel: target,
        command: {
          type: "thread.continuation.import",
          commandId: CommandId.make("conflicting-copy"),
          threadId: THREAD_ID,
          createThread: bootstrapCommand.bootstrap!.createThread,
          sourceEnvironmentId: EnvironmentId.make("source-computer"),
          sourceLabel: "Source computer",
          messages: bootstrapCommand.messages,
          createdAt: NOW,
        },
      }).pipe(Effect.flip);
      expect(failure).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        detail: expect.stringContaining("conflicting conversation history"),
      });
      expect(target.threads[0]!.messages[0]!.text).toBe("Newer destination decision");
    }),
  );

  it.effect("emits messages without starting a provider turn or session", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.history.import",
          commandId: CommandId.make("command-1"),
          threadId: THREAD_ID,
          messages: [{ messageId: MESSAGE_ID, role: "user", text: "Copied", createdAt: NOW }],
          createdAt: NOW,
        },
        readModel,
      });
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(Array.isArray(result) ? result.map(({ type }) => type) : []).toEqual([
        "thread.message-sent",
      ]);
    }),
  );

  it.effect("rejects a duplicate message id", () =>
    Effect.gen(function* () {
      const duplicateReadModel: OrchestrationReadModel = {
        ...readModel,
        threads: [
          {
            ...readModel.threads[0]!,
            messages: [
              {
                id: MESSAGE_ID,
                role: "user",
                text: "Copied",
                attachments: [],
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          },
        ],
      };
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.history.import",
          commandId: CommandId.make("command-2"),
          threadId: THREAD_ID,
          messages: [{ messageId: MESSAGE_ID, role: "user", text: "Copied", createdAt: NOW }],
          createdAt: NOW,
        },
        readModel: duplicateReadModel,
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
  it.effect("creates a new thread and its messages together without a provider turn", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: bootstrapCommand,
        readModel: freshReadModel,
      });
      expect(Array.isArray(result) ? result.map(({ type }) => type) : []).toEqual([
        "thread.created",
        "thread.message-sent",
        "thread.message-sent",
      ]);
      expect(Array.isArray(result) ? result[0]?.payload : undefined).toMatchObject({
        threadId: THREAD_ID,
        projectId: "project-1",
        title: "Imported",
        runtimeMode: "approval-required",
      });
      expect(
        Array.isArray(result) ? result.slice(1).map(({ payload }) => payload) : [],
      ).toMatchObject([
        { role: "user", text: "Copied", turnId: null, streaming: false },
        { role: "assistant", text: "Preserved", turnId: null, streaming: false },
      ]);
    }),
  );
  it.effect("keeps tied and decreasing archive timestamps in source order", () =>
    Effect.gen(function* () {
      const command = {
        ...bootstrapCommand,
        messages: [
          ...bootstrapCommand.messages,
          {
            messageId: MessageId.make("older-clock-message"),
            role: "user" as const,
            text: "Clock moved backwards",
            createdAt: "2026-08-25T11:59:59.000Z",
          },
          {
            messageId: MessageId.make("later-clock-message"),
            role: "assistant" as const,
            text: "Later reply",
            createdAt: "2026-08-25T12:00:00.010Z",
          },
        ],
      };
      const result = yield* decideOrchestrationCommand({
        command,
        readModel: freshReadModel,
      });
      const messages = Array.isArray(result)
        ? result.filter((event) => event.type === "thread.message-sent")
        : [];
      expect(messages.map(({ payload }) => payload.createdAt)).toEqual([
        NOW,
        "2026-08-25T12:00:00.001Z",
        "2026-08-25T12:00:00.002Z",
        "2026-08-25T12:00:00.010Z",
      ]);
      expect(messages.map(({ occurredAt }) => occurredAt)).toEqual(
        messages.map(({ payload }) => payload.createdAt),
      );
      expect(
        messages.map(({ payload: { messageId, role, text } }) => ({ messageId, role, text })),
      ).toEqual(command.messages.map(({ messageId, role, text }) => ({ messageId, role, text })));
      expect(command.messages[1]?.createdAt).toBe(NOW);
    }),
  );
  it.effect("appends archive batches after saved messages and local continuations", () =>
    Effect.gen(function* () {
      const saved = {
        ...readModel,
        threads: [
          {
            ...readModel.threads[0]!,
            messages: [
              {
                id: MessageId.make("native-continuation"),
                role: "assistant" as const,
                text: "Native reply",
                attachments: [],
                turnId: null,
                streaming: false,
                createdAt: "2026-08-25T12:00:00.010Z",
                updatedAt: "2026-08-25T12:00:00.010Z",
              },
              {
                id: MessageId.make("prior-archive-batch"),
                role: "user" as const,
                text: "Prior copied batch",
                attachments: [],
                turnId: null,
                streaming: false,
                createdAt: NOW,
                updatedAt: NOW,
              },
            ],
          },
        ],
      };
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.history.import",
          commandId: CommandId.make("next-archive-batch"),
          threadId: THREAD_ID,
          messages: bootstrapCommand.messages,
          createdAt: NOW,
        },
        readModel: saved,
      });
      const messages = Array.isArray(result)
        ? result.filter((event) => event.type === "thread.message-sent")
        : [];
      expect(messages.map(({ payload }) => payload.createdAt)).toEqual([
        "2026-08-25T12:00:00.011Z",
        "2026-08-25T12:00:00.012Z",
      ]);
      expect(messages.map(({ payload }) => payload.messageId)).toEqual(
        bootstrapCommand.messages.map(({ messageId }) => messageId),
      );
      expect(saved.threads[0]?.messages.map(({ text }) => text)).toEqual([
        "Native reply",
        "Prior copied batch",
      ]);
    }),
  );
  it.effect("rejects missing or deleted destinations before creating a copy", () =>
    Effect.gen(function* () {
      for (const projects of [[], [{ ...freshReadModel.projects[0]!, deletedAt: NOW }]]) {
        const error = yield* decideOrchestrationCommand({
          command: bootstrapCommand,
          readModel: { ...freshReadModel, projects },
        }).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
      }
    }),
  );
  it.effect("rejects append chunks after the destination thread or project disappears", () =>
    Effect.gen(function* () {
      const appendCommand: Extract<OrchestrationCommand, { type: "thread.history.import" }> = {
        type: "thread.history.import",
        commandId: CommandId.make("append-after-delete"),
        threadId: THREAD_ID,
        messages: bootstrapCommand.messages,
        createdAt: NOW,
      };
      for (const changed of [
        { ...readModel, projects: [] },
        { ...readModel, projects: [{ ...readModel.projects[0]!, deletedAt: NOW }] },
        { ...readModel, threads: [{ ...readModel.threads[0]!, deletedAt: NOW }] },
      ]) {
        const error = yield* decideOrchestrationCommand({
          command: appendCommand,
          readModel: changed,
        }).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
      }
    }),
  );
  it.effect("does not bootstrap over an existing thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: bootstrapCommand,
        readModel: { ...freshReadModel, threads: readModel.threads },
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
  it.effect("rejects duplicate ids within a fresh copy before emitting its thread", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          ...bootstrapCommand,
          messages: [bootstrapCommand.messages[0]!, bootstrapCommand.messages[0]!],
        },
        readModel: freshReadModel,
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
