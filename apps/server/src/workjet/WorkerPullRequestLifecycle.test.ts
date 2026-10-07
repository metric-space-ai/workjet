// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { EnvironmentId, ProjectId, ThreadId, type ChangeRequest, type OrchestrationCommand,
  type OrchestrationThread } from "@workjet/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
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
  provider: "github", number: 7, title: "One bounded change",
  url: "https://github.com/owner/repo/pull/7", baseRefName: "main", headRefName: branch,
  headCommitOid: "a".repeat(40), state: "open", updatedAt: Option.none(), isCrossRepository: false,
};
const database = <A, E>(effect: Effect.Effect<A, E, WorkerPullRequestStore | SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(storeLayer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory()))));

function harness() {
  const commands: OrchestrationCommand[] = [];
  const parent = ThreadId.make("parent");
  const projectId = ProjectId.make("project");
  let thread = {
    id, projectId, branch, worktreePath: "/safe/worktrees/leaf-a", deletedAt: null, archivedAt: null,
    createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z",
    workjetConfig: { schemaVersion: 2, role: "worker", parent: { environmentId: EnvironmentId.make("local"), threadId: parent },
      managedInstructions: "", enabledCapabilityIds: [], capabilityBindings: [], ctoxSession: null,
      team: { role: "worker", projectId, threadId: id, parentThreadId: parent, packageId: "run-a",
        goal: "One bounded PR", createdAt: "2026-10-07T10:00:00.000Z" } },
  } as unknown as OrchestrationThread;
  let candidates: ReadonlyArray<ChangeRequest> = [request];
  let terminated = true;
  let terminalClosed = true;
  let stops = 0;
  const service = make.pipe(
    Effect.provideService(ProjectionSnapshotQuery, {
      getCommandReadModel: () => Effect.succeed({ snapshotSequence: 0, projects: [],
        threads: [thread], updatedAt: thread.updatedAt }),
    } as unknown as ProjectionSnapshotQuery["Service"]),
    Effect.provideService(OrchestrationEngineService, {
      dispatch: (command: OrchestrationCommand) => Effect.sync(() => {
        commands.push(command);
        if (command.type === "thread.workjet-config.set") thread = { ...thread, workjetConfig: command.workjetConfig };
        if (command.type === "thread.archive") thread = { ...thread, archivedAt: thread.updatedAt };
        return { sequence: commands.length };
      }),
    } as unknown as OrchestrationEngineService["Service"]),
    Effect.provideService(SourceControlProviderRegistry, {
      resolve: () => Effect.succeed({ kind: "github", listChangeRequests: () => Effect.succeed(candidates) }),
    } as unknown as SourceControlProviderRegistry["Service"]),
    Effect.provideService(GitVcsDriver, {
      statusDetailsLocal: () => Effect.succeed({ isRepo: true, branch }),
      resolveCommit: () => Effect.succeed({ commitSha: "a".repeat(40) }),
    } as unknown as GitVcsDriver["Service"]),
    Effect.provideService(ProviderService, {
      stopSession: () => Effect.sync(() => { stops += 1; return { terminated, method: "cooperative", pids: [] }; }),
    } as unknown as ProviderService["Service"]),
    Effect.provideService(TerminalManager, {
      closeForCleanup: () => Effect.succeed(terminalClosed),
    } as unknown as TerminalManager["Service"]),
  );
  return { service, commands, thread: () => thread, stops: () => stops,
    setCandidates: (value: ReadonlyArray<ChangeRequest>) => { candidates = value; },
    setStopped: (value: boolean) => { terminated = value; },
    setTerminalClosed: (value: boolean) => { terminalClosed = value; } };
}

describe("native worker PR reconciler", () => {
  for (const state of ["merged", "closed"] as const) {
    it.effect(`binds the native PR then archives on ${state}, retaining source`, () => database(Effect.gen(function* () {
      yield* runMigrations();
      const h = harness();
      const service = yield* h.service;
      yield* service.runCycle;
      assert.equal(h.commands[0]?.type, "thread.workjet-config.set");
      assert.equal(h.stops(), 0);
      h.setCandidates([{ ...request, state }]);
      yield* service.runCycle;
      assert.equal(h.commands[1]?.type, "thread.archive");
      assert.equal(h.thread().deletedAt, null);
      assert.equal(h.thread().worktreePath, "/safe/worktrees/leaf-a");
      yield* service.runCycle;
      assert.equal(h.commands.length, 2);
    })));
  }
  it.effect("rejects ambiguous PRs, forked branches, wrong native head and another PR after binding", () => database(
    Effect.gen(function* () {
      yield* runMigrations();
      const h = harness();
      const service = yield* h.service;
      for (const candidates of [
        [], [request, { ...request, number: 8 }],
        [{ ...request, isCrossRepository: true }],
        [{ ...request, headCommitOid: "b".repeat(40) }],
        [{ ...request, headRefName: "foreign" }],
      ]) {
        h.setCandidates(candidates);
        yield* service.runCycle;
      }
      assert.equal(h.commands.length, 0);
      h.setCandidates([request]);
      yield* service.runCycle;
      h.setCandidates([{ ...request, number: 8, state: "closed" }]);
      yield* service.runCycle;
      assert.equal(h.commands.length, 1);
      assert.equal(h.stops(), 0);
    }),
  ));
  it.effect("keeps terminal work visible until provider and terminals have actually stopped", () => database(
    Effect.gen(function* () {
      yield* runMigrations();
      const h = harness();
      const service = yield* h.service;
      yield* service.runCycle;
      h.setCandidates([{ ...request, state: "closed" }]);
      h.setStopped(false);
      yield* service.runCycle;
      const store = yield* WorkerPullRequestStore;
      assert.equal(Option.getOrThrow(yield* store.get(id)).executionStopped, 0);
      h.setStopped(true);
      h.setTerminalClosed(false);
      yield* service.runCycle;
      assert.equal(h.commands.length, 1);
      h.setTerminalClosed(true);
      yield* service.runCycle;
      assert.equal(h.commands[1]?.type, "thread.archive");
      assert.equal(Option.getOrThrow(yield* store.get(id)).executionStopped, 1);
    }),
  ));
});
