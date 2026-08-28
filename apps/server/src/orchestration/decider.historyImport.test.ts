import {
  CommandId,
  DEFAULT_WORKJET_THREAD_CONFIG,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
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
});
