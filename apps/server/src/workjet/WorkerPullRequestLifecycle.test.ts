// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ChangeRequest,
  type OrchestrationCommand,
  type OrchestrationThread,
} from "@workjet/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { WorkerPullRequestStore, layer as storeLayer } from "./WorkerPullRequestStore.ts";
import { make } from "./WorkerPullRequestLifecycle.ts";

const id = ThreadId.make("leaf-a");
const branch = `workjet/worker/${id}`;
const request: ChangeRequest = {
  provider: "github",
  number: 7,
  title: "One bounded change",
  url: "https://github.com/owner/repo/pull/7",
  baseRefName: "main",
  headRefName: branch,
  headCommitOid: "a".repeat(40),
  state: "open",
  updatedAt: Option.none(),
  isCrossRepository: false,
};
const database = <A, E>(
  effect: Effect.Effect<A, E, WorkerPullRequestStore | SqlClient.SqlClient>,
) =>
  effect.pipe(Effect.provide(storeLayer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()))));

function harness() {
  const commands: OrchestrationCommand[] = [];
  const parent = ThreadId.make("parent");
  const projectId = ProjectId.make("project");
  let thread = {
    id,
    title: "Worker",
    modelSelection: { model: "gpt-6.1-sol" },
    projectId,
    branch,
    worktreePath: "/safe/worktrees/leaf-a",
    deletedAt: null,
    archivedAt: null,
    createdAt: "2026-10-07T10:00:00.000Z",
    updatedAt: "2026-10-07T10:00:00.000Z",
    workjetConfig: {
      schemaVersion: 2,
      role: "worker",
      parent: { environmentId: EnvironmentId.make("local"), threadId: parent },
      managedInstructions: "",
      enabledCapabilityIds: [],
      capabilityBindings: [],
      ctoxSession: null,
      team: {
        role: "worker",
        projectId,
        threadId: id,
        parentThreadId: parent,
        packageId: "run-a",
        goal: "One bounded PR",
        createdAt: "2026-10-07T10:00:00.000Z",
      },
    },
  } as unknown as OrchestrationThread;
  let candidates: ReadonlyArray<ChangeRequest> = [request];
  let terminated = true;
  let stopMissing = false;
  let liveSession = false;
  let terminalClosed = true;
  let stops = 0;
  let nativeHead = "a".repeat(40);
  let archiveUnavailable = false;
  let bindingUnavailable = false;
  let projectionPaused = false;
  let projectedThread = thread;
  const parentThread = {
    ...thread,
    id: parent,
    branch: null,
    worktreePath: null,
    workjetConfig: {
      ...thread.workjetConfig,
      role: "standard",
      parent: null,
      team: { role: "supervisor", threadId: parent, projectId },
    },
  } as unknown as OrchestrationThread;
  const service = make.pipe(
    Effect.provideService(ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("local")),
    } as ServerEnvironment["Service"]),
    Effect.provideService(ProjectionSnapshotQuery, {
      getCommandReadModel: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [],
          threads: [projectionPaused ? projectedThread : thread, parentThread],
          updatedAt: thread.updatedAt,
        }),
    } as unknown as ProjectionSnapshotQuery["Service"]),
    Effect.provideService(OrchestrationEngineService, {
      runWorkerRetirementIfSubmitted: (_id: ThreadId, stop: Effect.Effect<boolean>) => stop,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          if (command.type === "thread.workjet-config.set" && bindingUnavailable)
            throw new Error("Native PR projection unavailable");
          if (command.type === "thread.archive" && archiveUnavailable)
            throw new Error("Native archive acknowledgement unavailable");
          commands.push(command);
          if (command.type === "thread.workjet-config.set")
            thread = { ...thread, workjetConfig: command.workjetConfig };
          if (command.type === "thread.meta.update" && command.title)
            thread = { ...thread, title: command.title };
          if (command.type === "thread.archive")
            thread = { ...thread, archivedAt: thread.updatedAt };
          return { sequence: commands.length };
        }),
    } as unknown as OrchestrationEngineService["Service"]),
    Effect.provideService(SourceControlProviderRegistry, {
      resolve: () =>
        Effect.succeed({ kind: "github", listChangeRequests: () => Effect.succeed(candidates) }),
    } as unknown as SourceControlProviderRegistry["Service"]),
    Effect.provideService(GitVcsDriver, {
      statusDetailsLocal: () => Effect.succeed({ isRepo: true, branch }),
      resolveCommit: () => Effect.succeed({ commitSha: nativeHead }),
    } as unknown as GitVcsDriver["Service"]),
    Effect.provideService(ProviderService, {
      listSessions: () => Effect.succeed(liveSession ? [{ threadId: id }] : []),
      stopSession: () =>
        Effect.sync(() => {
          stops += 1;
          return stopMissing ? undefined : { terminated, method: "cooperative", pids: [] };
        }),
    } as unknown as ProviderService["Service"]),
    Effect.provideService(TerminalManager, {
      closeForCleanup: () => Effect.succeed(terminalClosed),
    } as unknown as TerminalManager["Service"]),
  );
  return {
    service,
    commands,
    thread: () => thread,
    stops: () => stops,
    setHead: (value: string) => {
      nativeHead = value;
    },
    setArchiveUnavailable: (value: boolean) => {
      archiveUnavailable = value;
    },
    setBindingUnavailable: (value: boolean) => {
      bindingUnavailable = value;
    },
    setProjectionPaused: (value: boolean) => {
      if (value) projectedThread = thread;
      projectionPaused = value;
    },
    setCandidates: (value: ReadonlyArray<ChangeRequest>) => {
      candidates = value;
    },
    setAbsentStop: (active: boolean) => {
      stopMissing = true;
      liveSession = active;
    },
    setStopped: (value: boolean) => {
      terminated = value;
    },
    setTerminalClosed: (value: boolean) => {
      terminalClosed = value;
    },
  };
}

describe("native worker PR reconciler", () => {
  it.effect(
    "reconciles a just-finished worker immediately without waiting for the polling cycle",
    () =>
      database(
        Effect.gen(function* () {
          yield* runMigrations();
          const h = harness();
          const service = yield* h.service;
          yield* service.reconcileThread(id);
          assert.equal(h.thread().archivedAt, h.thread().updatedAt);
          const result = h.commands.find(
            (command) => command.type === "thread.message.assistant.delta",
          );
          assert.isDefined(result);
          if (result?.type === "thread.message.assistant.delta") {
            assert.equal(result.threadId, ThreadId.make("parent"));
            assert.include(result.delta, request.url);
          }
        }),
      ),
  );
  it.effect("recovers an absent stopped session but refuses an unconfirmed live session", () =>
    database(
      Effect.gen(function* () {
        yield* runMigrations();
        const h = harness();
        h.setAbsentStop(true);
        const service = yield* h.service;
        yield* service.runCycle;
        assert.equal(h.thread().archivedAt, null);
        h.setAbsentStop(false);
        yield* service.runCycle;
        assert.equal(h.thread().archivedAt, h.thread().updatedAt);
      }),
    ),
  );
  it.effect("waits for committed binding and title rather than using the stale thread", () =>
    database(
      Effect.gen(function* () {
        yield* runMigrations();
        const h = harness();
        h.setProjectionPaused(true);
        const service = yield* h.service;
        yield* service.runCycle;
        assert.equal(h.commands.length, 2);
        assert.equal(h.stops(), 0);
        h.setProjectionPaused(false);
        h.setCandidates([]);
        yield* service.runCycle;
        assert.equal(h.thread().archivedAt, h.thread().updatedAt);
      }),
    ),
  );
  for (const state of ["open", "merged", "closed"] as const) {
    it.effect(`archives a verified ${state} submission in its binding cycle`, () =>
      database(
        Effect.gen(function* () {
          yield* runMigrations();
          const h = harness();
          h.setCandidates([{ ...request, state }]);
          const service = yield* h.service;
          yield* service.runCycle;
          assert.deepEqual(
            h.commands.map((command) => command.type),
            [
              "thread.workjet-config.set",
              "thread.meta.update",
              "thread.message.assistant.delta",
              "thread.message.assistant.complete",
              "thread.archive",
            ],
          );
          assert.equal(h.thread().title, "#7: gpt-6.1-sol");
          assert.equal(h.thread().deletedAt, null);
          assert.equal(h.thread().worktreePath, "/safe/worktrees/leaf-a");
          const store = yield* WorkerPullRequestStore;
          assert.equal(Option.getOrThrow(yield* store.get(id)).executionStopped, 1);
          yield* service.runCycle;
          assert.equal(h.commands.length, 5);
          assert.equal(h.stops(), 1);
        }),
      ),
    );
    it.effect(`recovers the ${state} receipt after lost binding acknowledgement`, () =>
      database(
        Effect.gen(function* () {
          yield* runMigrations();
          const h = harness();
          h.setCandidates([{ ...request, state }]);
          h.setBindingUnavailable(true);
          const service = yield* h.service;
          yield* service.runCycle;
          const store = yield* WorkerPullRequestStore;
          assert.equal(Option.getOrThrow(yield* store.get(id)).state, state);
          assert.equal(h.commands.length, 0);
          h.setBindingUnavailable(false);
          h.setCandidates([]);
          h.setHead("b".repeat(40));
          const restarted = yield* h.service;
          yield* restarted.runCycle;
          assert.equal(h.thread().archivedAt, h.thread().updatedAt);
          assert.equal(h.thread().title, "#7: gpt-6.1-sol");
        }),
      ),
    );
  }
  it.effect("retries stopped open submissions without another provider lookup", () =>
    database(
      Effect.gen(function* () {
        yield* runMigrations();
        const h = harness();
        h.setArchiveUnavailable(true);
        const service = yield* h.service;
        yield* service.runCycle;
        const store = yield* WorkerPullRequestStore;
        assert.equal(Option.getOrThrow(yield* store.get(id)).executionStopped, 1);
        assert.equal(h.thread().archivedAt, null);
        h.setStopped(false);
        h.setCandidates([]);
        h.setArchiveUnavailable(false);
        const restarted = yield* h.service;
        yield* restarted.runCycle;
        assert.equal(h.stops(), 1);
        assert.equal(h.thread().archivedAt, h.thread().updatedAt);
      }),
    ),
  );
  it.effect("rejects missing, ambiguous, forked and nonmatching native submissions", () =>
    database(
      Effect.gen(function* () {
        yield* runMigrations();
        const h = harness();
        const service = yield* h.service;
        for (const candidates of [
          [],
          [request, { ...request, number: 8 }],
          [{ ...request, isCrossRepository: true }],
          [{ ...request, headCommitOid: "b".repeat(40) }],
          [{ ...request, headRefName: "foreign" }],
        ]) {
          h.setCandidates(candidates);
          yield* service.runCycle;
        }
        assert.equal(h.commands.length, 0);
        assert.equal(h.stops(), 0);
      }),
    ),
  );
  it.effect("retires the exact owned checkout directly after a UI PR action", () =>
    database(
      Effect.gen(function* () {
        yield* runMigrations();
        const h = harness();
        const service = yield* h.service;
        yield* service.reconcileWorktree("/another/checkout");
        assert.equal(h.stops(), 0);
        assert.equal(h.commands.length, 0);
        yield* service.reconcileWorktree(h.thread().worktreePath!);
        assert.equal(h.thread().title, "#7: gpt-6.1-sol");
        assert.equal(h.thread().archivedAt, h.thread().updatedAt);
        const receipt = Option.getOrThrow(yield* (yield* WorkerPullRequestStore).get(id));
        assert.equal(receipt.executionStopped, 1);
        assert.equal(receipt.state, "open");
      }),
    ),
  );
  it.effect("keeps submitted work visible until provider and terminals stop", () =>
    database(
      Effect.gen(function* () {
        yield* runMigrations();
        const h = harness();
        h.setStopped(false);
        const service = yield* h.service;
        yield* service.runCycle;
        const store = yield* WorkerPullRequestStore;
        assert.equal(Option.getOrThrow(yield* store.get(id)).executionStopped, 0);
        h.setStopped(true);
        h.setTerminalClosed(false);
        yield* service.runCycle;
        assert.equal(h.thread().archivedAt, null);
        h.setTerminalClosed(true);
        yield* service.runCycle;
        assert.equal(h.thread().archivedAt, h.thread().updatedAt);
        assert.equal(Option.getOrThrow(yield* store.get(id)).executionStopped, 1);
      }),
    ),
  );
});
