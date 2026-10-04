import {
  CommandId,
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
const THREAD_ID = ThreadId.make("thread-1");
const MESSAGE_ID = MessageId.make("message-1");
const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
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
