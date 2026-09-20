import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import {
  CommandId,
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@workjet/contracts";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-09-19T10:00:00.000Z";
const projectId = ProjectId.make("team-project");
const create = {
  type: "project.create",
  commandId: CommandId.make("create-project"),
  projectId,
  title: "Team project",
  workspaceRoot: "/fixture/project",
  createdAt: now,
} as const;
const apply = Effect.fn("test.applyTeamCommand")(function* (
  model: OrchestrationReadModel,
  command: OrchestrationCommand,
) {
  const result = yield* decideOrchestrationCommand({
    readModel: model,
    command,
    environmentId: EnvironmentId.make("local"),
  });
  const events = (Array.isArray(result) ? result : [result]) as ReadonlyArray<
    Omit<OrchestrationEvent, "sequence">
  >;
  let state = model;
  let sequence = model.snapshotSequence;
  for (const event of events)
    state = yield* projectEvent(state, { ...event, sequence: ++sequence } as OrchestrationEvent);
  return { state, events };
});

describe("durable project teams", () => {
  it.effect(
    "creates one supervisor in the project transaction and restores it from the same events",
    () =>
      Effect.gen(function* () {
        const first = yield* apply(createEmptyReadModel(now), create);
        expect(first.events.map((event) => event.type)).toEqual([
          "project.created",
          "thread.created",
        ]);
        expect(first.state.threads).toHaveLength(1);
        const supervisor = first.state.threads[0]!;
        expect(
          supervisor.workjetConfig.schemaVersion === 2 && supervisor.workjetConfig.team?.role,
        ).toBe("supervisor");
        let restarted = createEmptyReadModel(now);
        let sequence = 0;
        for (const event of first.events)
          restarted = yield* projectEvent(restarted, {
            ...event,
            sequence: ++sequence,
          } as OrchestrationEvent);
        expect(restarted.threads[0]?.id).toBe(supervisor.id);
        const duplicate = yield* Effect.exit(
          apply(restarted, { ...create, commandId: CommandId.make("another-client") }),
        );
        expect(duplicate._tag).toBe("Failure");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rejects a second supervisor and removal of durable ownership but retains manual threads",
    () =>
      Effect.gen(function* () {
        const { state } = yield* apply(createEmptyReadModel(now), create);
        const supervisor = state.threads[0]!;
        const duplicateId = ThreadId.make("duplicate-supervisor");
        const supervisorTeam =
          supervisor.workjetConfig.schemaVersion === 2 ? supervisor.workjetConfig.team : undefined;
        if (!supervisorTeam) throw new Error("Fixture supervisor missing");
        const command = {
          type: "thread.create",
          commandId: CommandId.make("duplicate"),
          threadId: duplicateId,
          projectId,
          title: "Duplicate",
          modelSelection: supervisor.modelSelection,
          runtimeMode: supervisor.runtimeMode,
          interactionMode: supervisor.interactionMode,
          workjetConfig: {
            ...DEFAULT_WORKJET_THREAD_CONFIG,
            role: "orchestrator",
            team: { ...supervisorTeam, threadId: duplicateId },
          },
          branch: null,
          worktreePath: null,
          createdAt: now,
        } as const;
        expect((yield* Effect.exit(apply(state, command)))._tag).toBe("Failure");
        expect(
          (yield* Effect.exit(
            apply(state, {
              type: "thread.workjet-config.set",
              commandId: CommandId.make("remove-role"),
              threadId: supervisor.id,
              workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
              createdAt: now,
            }),
          ))._tag,
        ).toBe("Failure");
        const manual = yield* apply(state, {
          ...command,
          workjetConfig: DEFAULT_WORKJET_THREAD_CONFIG,
        });
        expect(manual.state.threads).toHaveLength(2);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("rejects foreign-environment workers and retains the project contact", () =>
    Effect.gen(function* () {
      const initial = yield* apply(createEmptyReadModel(now), create);
      const supervisor = initial.state.threads[0]!;
      const specialistId = ThreadId.make("specialist");
      const specialist = {
        type: "thread.create",
        commandId: CommandId.make("specialist-create"),
        threadId: specialistId,
        projectId,
        title: "Backend",
        modelSelection: supervisor.modelSelection,
        runtimeMode: supervisor.runtimeMode,
        interactionMode: supervisor.interactionMode,
        workjetConfig: {
          ...DEFAULT_WORKJET_THREAD_CONFIG,
          role: "orchestrator",
          team: {
            projectId,
            threadId: specialistId,
            role: "specialist",
            parentThreadId: supervisor.id,
            domain: "Backend",
            goal: "Own backend correctness",
            createdAt: now,
          },
        },
        branch: null,
        worktreePath: null,
        createdAt: now,
      } as const;
      const withSpecialist = yield* apply(initial.state, specialist);
      const workerId = ThreadId.make("worker");
      const worker = {
        ...specialist,
        commandId: CommandId.make("worker-create"),
        threadId: workerId,
        workjetConfig: {
          ...DEFAULT_WORKJET_THREAD_CONFIG,
          role: "worker",
          parent: { environmentId: EnvironmentId.make("foreign"), threadId: specialistId },
          team: {
            projectId,
            threadId: workerId,
            role: "worker",
            parentThreadId: specialistId,
            packageId: "package",
            goal: "Implement recovery",
            createdAt: now,
          },
        },
      } as const;
      expect((yield* Effect.exit(apply(withSpecialist.state, worker)))._tag).toBe("Failure");
      const localWorker = yield* apply(withSpecialist.state, {
        ...worker,
        workjetConfig: {
          ...worker.workjetConfig,
          parent: { ...worker.workjetConfig.parent, environmentId: EnvironmentId.make("local") },
        },
      });
      expect(localWorker.state.threads).toHaveLength(3);
      const archivedWorker = yield* apply(localWorker.state, {
        type: "thread.archive",
        commandId: CommandId.make("archive-worker"),
        threadId: workerId,
      });
      const archivedParent = yield* apply(archivedWorker.state, {
        type: "thread.archive",
        commandId: CommandId.make("archive-specialist"),
        threadId: specialistId,
      });
      expect(
        (yield* Effect.exit(
          apply(archivedParent.state, {
            type: "thread.unarchive",
            commandId: CommandId.make("unarchive-worker"),
            threadId: workerId,
          }),
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* Effect.exit(
          apply(localWorker.state, {
            type: "thread.archive",
            commandId: CommandId.make("archive-supervisor"),
            threadId: supervisor.id,
          }),
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* Effect.exit(
          apply(localWorker.state, {
            type: "thread.delete",
            commandId: CommandId.make("delete-specialist"),
            threadId: specialistId,
          }),
        ))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
