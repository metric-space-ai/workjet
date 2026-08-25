import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  WorkjetCrossModeError,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { WorkjetCrossModeThreadPort } from "./WorkjetCrossModeRpc.ts";

/**
 * The LIVE {@link WorkjetCrossModeThreadPort}: thread creation and the durable
 * activity trace, over the orchestration engine.
 *
 * It is deliberately a thin adapter with no policy of its own. Every decision
 * about WHEN a thread is created, when it is deleted again, and what the
 * activity says lives in `WorkjetCrossModeRpc`, which is where it can be tested
 * without an engine. This file only knows how to say those things in commands.
 *
 * The thread it creates is an ORDINARY STANDALONE thread — `role: "standard"`,
 * no parent, no worktree, no branch checkout. It is not a `worker` of the host
 * thread: the host supplies project and runtime settings, not authority, and a
 * worker role would imply a parent that never dispatched it. This is exactly the
 * shape `WorkjetMailboxDelivery.acceptHandoff` creates for a continued handoff,
 * and for the same reasons.
 */
export interface WorkjetCrossModeThreadSources {
  readonly randomUUID: Effect.Effect<string>;
  readonly nowIso: Effect.Effect<string>;
}

export const makeWorkjetCrossModeThreadPortWithSources = Effect.fn(
  "WorkjetCrossModeThreads.makeWithSources",
)(function* (sources: WorkjetCrossModeThreadSources) {
  const engine = yield* OrchestrationEngineService;

  const commandId = (tag: string) =>
    sources.randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  const createLinkedThread: WorkjetCrossModeThreadPort["createLinkedThread"] = (input) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(yield* sources.randomUUID);
      const host = input.hostThread;

      const createExit = yield* Effect.exit(
        Effect.gen(function* () {
          yield* engine.dispatch({
            type: "thread.create",
            commandId: yield* commandId("workjet-crossmode-create"),
            threadId,
            projectId: host.projectId,
            title: input.title,
            modelSelection: host.modelSelection,
            runtimeMode: host.runtimeMode,
            interactionMode: host.interactionMode,
            workjetConfig: {
              schemaVersion: 2,
              role: "standard",
              parent: null,
              managedInstructions: "",
              enabledCapabilityIds: [],
              capabilityBindings: [],
            },
            branch: null,
            worktreePath: null,
            createdAt: input.createdAt,
          } as const satisfies OrchestrationCommand);
        }),
      );
      if (createExit._tag === "Failure") {
        return yield* new WorkjetCrossModeError({ reason: "cross-mode-unavailable" });
      }

      // The scoped context IS the first user message: the linked thread starts
      // from the bounded brief the operator wrote, with the host's harness and
      // model. Nothing of the Business OS record travels with it.
      const turnExit = yield* Effect.exit(
        Effect.gen(function* () {
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: yield* commandId("workjet-crossmode-turn"),
            threadId,
            message: {
              messageId: MessageId.make(yield* sources.randomUUID),
              role: "user",
              text: input.seedMessage,
              attachments: [],
            },
            runtimeMode: host.runtimeMode,
            interactionMode: host.interactionMode,
            createdAt: input.createdAt,
          } as const satisfies OrchestrationCommand);
        }),
      );
      if (turnExit._tag === "Failure") {
        yield* deleteThread(threadId);
        return yield* new WorkjetCrossModeError({ reason: "cross-mode-unavailable" });
      }

      return threadId;
    });

  const deleteThread: WorkjetCrossModeThreadPort["deleteThread"] = (threadId) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.delete",
        commandId: yield* commandId("workjet-crossmode-delete"),
        threadId,
      } as const satisfies OrchestrationCommand);
    }).pipe(Effect.ignore);

  const appendActivity: WorkjetCrossModeThreadPort["appendActivity"] = (input) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: yield* commandId("workjet-crossmode-activity"),
        threadId: input.threadId,
        activity: {
          id: EventId.make(yield* sources.randomUUID),
          tone: "info",
          kind: input.kind,
          summary: input.summary,
          payload: input.payload,
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      } as const satisfies OrchestrationCommand);
    }).pipe(Effect.ignore);

  return { createLinkedThread, deleteThread, appendActivity } satisfies WorkjetCrossModeThreadPort;
});

export const makeWorkjetCrossModeThreadPort = Effect.fn("WorkjetCrossModeThreads.make")(
  function* () {
    const crypto = yield* Crypto.Crypto;
    return yield* makeWorkjetCrossModeThreadPortWithSources({
      randomUUID: crypto.randomUUIDv4.pipe(Effect.orDie),
      nowIso: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    });
  },
);
