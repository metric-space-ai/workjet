import {
  CommandId, DEFAULT_MODEL, DEFAULT_WORKJET_THREAD_CONFIG, EnvironmentId, ProjectId,
  ProviderInstanceId, ThreadId, WorkjetSupervisorJournal,
  type OrchestrationCommand, type OrchestrationReadModel, type OrchestrationThread,
  type WorkjetThreadConfig,
} from "@workjet/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";
import { initialWorkerGoal } from "../workjet/workerGoal.ts";

const NOW = "2026-10-10T20:00:00.000Z";
const projectId = ProjectId.make("worker-isolation-fixture");
const supervisorId = ThreadId.make("11111111-1111-4111-8111-111111111111");
const workerId = ThreadId.make("22222222-2222-4222-8222-222222222222");
const environmentId = EnvironmentId.make("worker-isolation-environment");
const journal = (id: ThreadId, commandId = "saved-submit"): WorkjetSupervisorJournal =>
  Schema.decodeUnknownSync(WorkjetSupervisorJournal)({
    intent: { instanceId: "fixture.ctox.dev", projectId, threadId: id, commandId, goal: "Saved work", createdAt: NOW },
    submission: "confirmed",
    turn: {
      commandId, taskId: "saved-task", threadId: id, threadKey: `business-os/threads/${id}`,
      executionPhase: "running", status: "running", queueStatus: "leased", attempt: 1,
      terminal: false, result: null, resultTruncated: false, errorCode: null, errorMessage: null,
    },
    inputs: [{
      intent: { instanceId: "fixture.ctox.dev", projectId, threadId: id, targetCommandId: commandId, commandId: "saved-input", body: "Continue", createdAt: NOW },
      receipt: null, submission: "awaiting-receipt",
    }],
  });
const config: WorkjetThreadConfig = {
  ...DEFAULT_WORKJET_THREAD_CONFIG, schemaVersion: 2,
  team: { projectId, threadId: workerId, role: "specialist", parentThreadId: supervisorId, domain: "engine", goal: "Worker objective", createdAt: NOW },
};
const thread = (id: ThreadId, workjetConfig: WorkjetThreadConfig): OrchestrationThread => ({
  id, projectId, title: "Fixture", modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL },
  runtimeMode: "full-access", interactionMode: "default", workjetConfig,
  branch: null, worktreePath: null, latestTurn: null, createdAt: NOW, updatedAt: NOW,
  archivedAt: null, settledOverride: null, settledAt: null, snoozedUntil: null, snoozedAt: null, deletedAt: null,
  messages: [], proposedPlans: [], activities: [], checkpoints: [], session: null,
});
const supervisor = thread(supervisorId, {
  ...DEFAULT_WORKJET_THREAD_CONFIG, schemaVersion: 2,
  team: { projectId, threadId: supervisorId, role: "supervisor", parentThreadId: null, goal: "Coordinate", createdAt: NOW },
  ctoxSupervisorTurn: journal(supervisorId),
  ctoxSupervisorPreviousTurns: [journal(supervisorId, "saved-previous")],
});
const model = (workjetConfig: WorkjetThreadConfig): OrchestrationReadModel => ({
  snapshotSequence: 1, updatedAt: NOW,
  projects: [{ id: projectId, title: "Fixture", workspaceRoot: "/fixture/project", defaultModelSelection: null, defaultThreadEnvMode: null, faviconPath: null, scripts: [], createdAt: NOW, updatedAt: NOW, deletedAt: null }],
  threads: [supervisor, thread(workerId, workjetConfig)],
});
const contaminated: WorkjetThreadConfig = {
  ...config, ctoxSupervisorTurn: journal(supervisorId),
  ctoxSupervisorPreviousTurns: [journal(supervisorId, "saved-previous")],
  goal: { ...initialWorkerGoal("Owner objective", NOW), status: "paused", reason: "Owner stopped" },
};
const set = (workjetConfig: WorkjetThreadConfig): OrchestrationCommand => ({
  type: "thread.workjet-config.set", commandId: CommandId.make("config-save"), threadId: workerId, workjetConfig, createdAt: NOW,
});
const apply = Effect.fn("test.applyWorkerConfig")(function* (readModel: OrchestrationReadModel, command: OrchestrationCommand) {
  const planned = yield* decideOrchestrationCommand({ readModel, command, environmentId });
  for (const event of Array.isArray(planned) ? planned : [planned])
    readModel = yield* projectEvent(readModel, { ...event, sequence: readModel.snapshotSequence + 1 });
  return readModel.threads.find((item) => item.id === workerId)!.workjetConfig;
});

it.layer(NodeServices.layer)("worker native state isolation", (it) => {
  for (const role of ["specialist", "worker"] as const)
    it.effect(`drops inherited supervisor journals at ${role} creation, even from an older client`, () =>
      Effect.gen(function* () {
        const copied: WorkjetThreadConfig = role === "worker" ? {
          ...contaminated, role: "worker", parent: { environmentId, threadId: supervisorId },
          team: { role: "worker", projectId, threadId: workerId, parentThreadId: supervisorId, packageId: "one-shot", goal: "One PR", createdAt: NOW },
        } : { ...contaminated, role: "standard", parent: null };
        const readModel = model(config);
        const next = yield* apply({ ...readModel, threads: [supervisor] }, {
          type: "thread.create", commandId: CommandId.make(`create-${role}`), threadId: workerId,
          projectId, title: "Worker", modelSelection: supervisor.modelSelection, runtimeMode: "full-access",
          interactionMode: "default", workjetConfig: copied, branch: null, worktreePath: null, createdAt: NOW,
        });
        expect(next).not.toHaveProperty("ctoxSupervisorTurn");
        expect(next).not.toHaveProperty("ctoxSupervisorPreviousTurns");
        expect(supervisor.workjetConfig).toHaveProperty("ctoxSupervisorTurn");
      }),
    );

  it.effect("heals an unchanged persisted foreign journal during a settings save while retaining the Owner goal", () =>
    Effect.gen(function* () {
      const next = yield* apply(model(contaminated), set({ ...contaminated, managedInstructions: "New model settings" }));
      expect(next).not.toHaveProperty("ctoxSupervisorTurn");
      expect(next).not.toHaveProperty("ctoxSupervisorPreviousTurns");
      expect(next).toMatchObject({ managedInstructions: "New model settings", goal: contaminated.goal });
    }),
  );
  it.effect("does not resurrect omitted foreign state through replace-all retention", () =>
    Effect.gen(function* () {
      const next = yield* apply(model(contaminated), set(config));
      expect(next).not.toHaveProperty("ctoxSupervisorTurn");
      expect(next).not.toHaveProperty("ctoxSupervisorPreviousTurns");
    }),
  );
  it.effect("still rejects a newly supplied foreign turn on a clean Worker", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({ readModel: model(config), command: set(contaminated), environmentId }).pipe(Effect.flip);
      expect(error.message).toContain("this Code thread");
    }),
  );
  it.effect("rejects changes to inherited foreign state instead of accepting a new foreign turn", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({ readModel: model(contaminated), command: set({ ...contaminated, ctoxSupervisorTurn: journal(supervisorId, "forged-submit") }), environmentId }).pipe(Effect.flip);
      expect(error.message).toContain("this Code thread");
    }),
  );
  it.effect("rejects a new foreign journal injected through history alone", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({ readModel: model(config), command: set({ ...config, ctoxSupervisorPreviousTurns: [journal(supervisorId)] }), environmentId }).pipe(Effect.flip);
      expect(error.message).toContain("original Supervisor receipt");
    }),
  );
  it.effect("retains owned current and historical receipts when removing only foreign history", () =>
    Effect.gen(function* () {
      const owned = journal(workerId);
      const history = journal(workerId, "owned-previous");
      const saved: WorkjetThreadConfig = { ...config, ctoxSupervisorTurn: owned, ctoxSupervisorPreviousTurns: [history, journal(supervisorId)] };
      const next = yield* apply(model(saved), set(config));
      expect(next).toMatchObject({ ctoxSupervisorTurn: owned, ctoxSupervisorPreviousTurns: [history] });
    }),
  );
  it.effect("heals inherited journals when the Owner changes a persistent goal", () =>
    Effect.gen(function* () {
      const next = yield* apply(model(contaminated), {
        type: "thread.goal.set", commandId: CommandId.make("goal-update"), threadId: workerId,
        objective: "Updated Owner goal", status: "paused", expectedRevision: 0, createdAt: NOW,
      });
      expect(next).not.toHaveProperty("ctoxSupervisorTurn");
      expect(next).not.toHaveProperty("ctoxSupervisorPreviousTurns");
      expect(next).toMatchObject({ goal: { objective: "Updated Owner goal", status: "paused" } });
    }),
  );
});
