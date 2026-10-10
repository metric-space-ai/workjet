import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type WorkjetThreadConfig,
} from "@workjet/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WorkjetThreadGoal } from "@workjet/contracts";
import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";
import { initialWorkerGoal } from "../workjet/workerGoal.ts";

const goalJson = Schema.fromJsonString(WorkjetThreadGoal);
const decodeGoalJson = Schema.decodeUnknownEffect(goalJson);
const encodeGoalJson = Schema.encodeEffect(goalJson);
const decodeGoal = Schema.decodeUnknownEffect(WorkjetThreadGoal);

const NOW = "2026-10-09T21:00:00.000Z";
const id = ThreadId.make("persistent-parent");
const projectId = ProjectId.make("molecularity");
const config: WorkjetThreadConfig = {
  ...DEFAULT_WORKJET_THREAD_CONFIG,
  schemaVersion: 2,
  team: {
    projectId,
    threadId: id,
    role: "specialist",
    parentThreadId: ThreadId.make("supervisor"),
    domain: "harness",
    goal: "Deliver the verified weekly outcome.",
    createdAt: NOW,
  },
};
const snapshot: OrchestrationReadModel = {
  snapshotSequence: 0,
  updatedAt: NOW,
  projects: [],
  threads: [
    {
      id,
      projectId,
      title: "Harness",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL },
      runtimeMode: "full-access",
      interactionMode: "default",
      workjetConfig: config,
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
};
const withGoal = (status: "active" | "paused" | "blocked" | "complete" = "active") =>
  ({
    ...snapshot,
    threads: [
      {
        ...snapshot.threads[0]!,
        workjetConfig: {
          ...config,
          goal: {
            ...initialWorkerGoal("Deliver the verified weekly outcome.", NOW),
            status,
          },
        },
      },
    ],
  }) satisfies OrchestrationReadModel;
const control = (
  status: "active" | "paused" | "blocked" | "complete",
  reason?: string,
): Extract<OrchestrationCommand, { type: "thread.goal.set" }> => ({
  type: "thread.goal.set",
  commandId: CommandId.make("owner-control"),
  threadId: id,
  status,
  ...(reason ? { reason } : {}),
  createdAt: NOW,
});
const turn: OrchestrationCommand = {
  type: "thread.turn.start",
  commandId: CommandId.make("owner-message"),
  threadId: id,
  message: {
    messageId: MessageId.make("owner-message"),
    role: "user",
    text: "Begin the approved work.",
    attachments: [],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: NOW,
};
const apply = Effect.fn("test.applyGoalCommand")(function* (
  readModel: OrchestrationReadModel,
  command: OrchestrationCommand,
) {
  const planned = yield* decideOrchestrationCommand({ readModel, command });
  const events = Array.isArray(planned) ? planned : [planned];
  let result = readModel;
  for (const event of events)
    result = yield* projectEvent(result, { ...event, sequence: result.snapshotSequence + 1 });
  return result;
});

it.layer(NodeServices.layer)("persistent goal journal", (it) => {
  it.effect("defaults to active on a real parent turn, and survives projection/JSON reload", () =>
    Effect.gen(function* () {
      const result = yield* apply(snapshot, turn);
      const goal = result.threads[0]!.workjetConfig;
      expect(goal.schemaVersion === 2 && goal.goal?.status).toBe("active");
      if (goal.schemaVersion !== 2) throw new Error("unexpected old config");
      expect(yield* decodeGoalJson(yield* encodeGoalJson(goal.goal!))).toEqual(goal.goal);
      expect(goal.goal?.pendingContinuation).toBeNull();
    }),
  );
  it.effect("journals iteration mini-kanbans and rejects stale or duplicate cards", () =>
    Effect.gen(function* () {
      const model = withGoal();
      const kanban = {
        goalRevision: 0,
        iteration: 0,
        updatedAt: NOW,
        cards: [{ id: "verify", title: "Verify the outcome", status: "doing" as const }],
      };
      const command: OrchestrationCommand = {
        type: "thread.worker-kanban.set",
        commandId: CommandId.make("board"),
        threadId: id,
        kanban,
        createdAt: NOW,
      };
      const result = yield* apply(model, command);
      const config = result.threads[0]!.workjetConfig;
      if (config.schemaVersion !== 2 || !config.goal?.kanban?.slideDocument)
        throw new Error("missing durable kanban document");
      const { slideDocument, ...cards } = config.goal.kanban;
      expect(cards).toEqual(kanban);
      expect(slideDocument.schemaVersion).toBe("learnordie.slide.v1");
      expect(yield* decodeGoalJson(yield* encodeGoalJson(config.goal))).toEqual(config.goal);
      // Old card-only journal records remain readable.
      expect(yield* decodeGoal({ ...config.goal, kanban })).toEqual({ ...config.goal, kanban });
      // A caller cannot replace the canonical document or claim a verified outcome.
      const spoofed = yield* apply(model, {
        ...command,
        kanban: {
          ...kanban,
          slideDocument: {
            schemaVersion: "learnordie.slide.v1",
            documentJson: '{"claimed":"verified"}',
            sha256: "0".repeat(64),
          },
        },
      });
      const spoofedConfig = spoofed.threads[0]!.workjetConfig;
      expect(
        spoofedConfig.schemaVersion === 2 && spoofedConfig.goal?.kanban?.slideDocument,
      ).toEqual(slideDocument);
      for (const next of [
        { ...kanban, iteration: 1 },
        { ...kanban, goalRevision: 1 },
        { ...kanban, cards: [...kanban.cards, ...kanban.cards] },
      ])
        expect((yield* apply(model, { ...command, kanban: next }).pipe(Effect.result))._tag).toBe(
          "Failure",
        );
      expect((yield* apply(withGoal("paused"), command).pipe(Effect.result))._tag).toBe("Failure");
    }),
  );
  it.effect("keeps paused goals paused on ordinary Owner messages", () =>
    Effect.gen(function* () {
      const result = yield* apply(withGoal("paused"), turn);
      const config = result.threads[0]!.workjetConfig;
      expect(config.schemaVersion === 2 && config.goal?.status).toBe("paused");
    }),
  );
  it.effect("does not enable goals for supervisor or one-shot turns", () =>
    Effect.gen(function* () {
      const workerConfigs: WorkjetThreadConfig[] = [
        {
          ...DEFAULT_WORKJET_THREAD_CONFIG,
          schemaVersion: 2,
          team: {
            projectId,
            threadId: id,
            role: "supervisor",
            parentThreadId: null,
            goal: "Coordinate.",
            createdAt: NOW,
          },
        },
        {
          ...DEFAULT_WORKJET_THREAD_CONFIG,
          schemaVersion: 2,
          role: "worker",
          parent: {
            environmentId: EnvironmentId.make("goal-fixture"),
            threadId: ThreadId.make("parent"),
          },
          team: {
            projectId,
            threadId: id,
            role: "worker",
            parentThreadId: ThreadId.make("parent"),
            packageId: "one",
            goal: "Submit one PR.",
            createdAt: NOW,
          },
        },
      ];
      for (const workjetConfig of workerConfigs) {
        const result = yield* apply(
          {
            ...snapshot,
            threads: [
              {
                ...snapshot.threads[0]!,
                workjetConfig,
                ...(workjetConfig.schemaVersion === 2 && workjetConfig.team?.role === "worker"
                  ? { branch: `workjet/worker/${id}`, worktreePath: "/fixture/owned-worker" }
                  : {}),
              },
            ],
          },
          turn,
        );
        const projected = result.threads[0]!.workjetConfig;
        expect(projected.schemaVersion === 2 && projected.goal).toBeUndefined();
      }
    }),
  );
  it.effect("requires evidence for completion and a reason for blockers", () =>
    Effect.gen(function* () {
      for (const status of ["complete", "blocked"] as const) {
        const error = yield* decideOrchestrationCommand({
          readModel: withGoal(),
          command: control(status),
        }).pipe(Effect.flip);
        expect(error.message).toContain("Completion needs verified results");
        const result = yield* apply(
          withGoal(),
          control(status, "Verified result or exact external decision."),
        );
        const cfg = result.threads[0]!.workjetConfig;
        expect(cfg.schemaVersion === 2 && cfg.goal?.status).toBe(status);
      }
    }),
  );
  it.effect("atomically pauses the goal when the Owner interrupts or stops the session", () =>
    Effect.gen(function* () {
      for (const type of ["thread.turn.interrupt", "thread.session.stop"] as const) {
        const result = yield* apply(withGoal(), {
          type,
          commandId: CommandId.make(type),
          threadId: id,
          createdAt: NOW,
        });
        const cfg = result.threads[0]!.workjetConfig;
        expect(cfg.schemaVersion === 2 && cfg.goal?.status).toBe("paused");
        expect(cfg.schemaVersion === 2 && cfg.goal?.pendingContinuation).toBeNull();
      }
    }),
  );
  it.effect(
    "prepares one durable continuation per completed turn and rejects replay or Owner stop",
    () =>
      Effect.gen(function* () {
        const turnId = TurnId.make("completed-turn");
        const initial = withGoal();
        const completed = {
          ...initial,
          threads: [
            {
              ...initial.threads[0]!,
              latestTurn: {
                turnId,
                state: "completed" as const,
                requestedAt: NOW,
                startedAt: NOW,
                completedAt: NOW,
                assistantMessageId: null,
              },
            },
          ],
        };
        const advance: OrchestrationCommand = {
          type: "thread.goal.advance",
          commandId: CommandId.make("advance"),
          threadId: id,
          expectedRevision: 0,
          completedTurnId: turnId,
          createdAt: NOW,
        };
        const prepared = yield* apply(completed, advance);
        const cfg = prepared.threads[0]!.workjetConfig;
        if (cfg.schemaVersion !== 2 || !cfg.goal?.pendingContinuation)
          throw new Error("missing continuation");
        expect(cfg.goal.continuationCount).toBe(1);
        const replay = yield* decideOrchestrationCommand({
          readModel: prepared,
          command: { ...advance, expectedRevision: 1 },
        }).pipe(Effect.flip);
        expect(replay.message).toContain("Only a new successfully completed turn");
        const stopped = yield* apply(prepared, control("paused", "Owner stop."));
        const error = yield* decideOrchestrationCommand({
          readModel: stopped,
          command: {
            ...turn,
            commandId: cfg.goal.pendingContinuation.commandId,
            message: { ...turn.message, messageId: cfg.goal.pendingContinuation.messageId },
            goalRevision: 1,
          },
        }).pipe(Effect.flip);
        expect(error.message).toContain("stopped or superseded");
      }),
  );
  it.effect("rejects stale agent reports after an Owner stop", () =>
    Effect.gen(function* () {
      const stopped = yield* apply(withGoal(), control("paused", "Owner stop."));
      const error = yield* decideOrchestrationCommand({
        readModel: stopped,
        command: {
          ...control("complete", "Result verified."),
          expectedRevision: 0,
        },
      }).pipe(Effect.flip);
      expect(error.message).toContain("goal changed");
    }),
  );
});
