import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  DEFAULT_MEETING_PREPARATION_CONFIGURATION as defaults,
} from "@workjet/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  SqlitePersistenceMemory,
  makeSqlitePersistenceLive,
} from "../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../config.ts";
import {
  makePreparationRunner,
  makePreparationStore,
  PreparationError,
  preparationPrompt,
  type PreparationInput,
  type PreparationRecord,
} from "./MeetingPreparation.ts";

const input: PreparationInput = {
  projectId: ProjectId.make("project"),
  supervisorThreadId: ThreadId.make("supervisor"),
  meeting: { weekday: 1, time: "13:00", timezone: "Europe/Berlin" },
  configuration: defaults,
  now: Date.parse("2026-10-11T17:00:44Z"),
  brief: JSON.stringify({
    goal: "Deliver the project",
    kanban: [{ title: "Release", status: "done" }],
    mergedPullRequests: [{ number: 42 }],
    decisions: ["Owner chooses release date"],
    tokenBudget: { consumedTokens: 10 },
  }),
};
function fixture(store: Effect.Success<typeof makePreparationStore>) {
  const dispatches: PreparationRecord[] = [];
  const reports: PreparationRecord[] = [];
  let failWorker = false;
  const deps = {
    store,
    dispatch: (row: PreparationRecord) =>
      Effect.sync(() => {
        dispatches.push(row);
        return { workerThreadId: ThreadId.make(row.intentId) };
      }),
    outcome: () =>
      Effect.succeed(
        failWorker
          ? { status: "failed" as const, detail: "Worker timed out" }
          : { status: "running" as const },
      ),
    report: (row: PreparationRecord) =>
      Effect.sync(() => {
        reports.push(row);
      }),
  };
  return {
    deps,
    dispatches,
    reports,
    fail: () => {
      failWorker = true;
    },
  };
}
it.effect("starts once for parallel control rounds and a new runner over the persisted store", () =>
  Effect.gen(function* () {
    const store = yield* makePreparationStore;
    const f = fixture(store);
    const run = yield* makePreparationRunner(f.deps);
    yield* Effect.all([run(input), run({ ...input, now: input.now + 1800000 })], {
      concurrency: 2,
    });
    const restarted = yield* makePreparationRunner(f.deps);
    yield* restarted(input);
    expect(f.dispatches).toHaveLength(1);
    expect(f.reports).toHaveLength(1);
    expect(f.dispatches[0]?.task).toContain("Owner chooses release date");
    expect(f.dispatches[0]?.task).toContain("mergedPullRequests");
    expect(f.dispatches[0]?.task).toContain("tokenBudget");
    expect(f.dispatches[0]?.task).toContain("Presentation");
    expect(f.dispatches[0]?.task).toContain("reports/jour-fixe/2026-10-12-T1440.md");
  }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer))),
);
it.effect("retains the intent and original brief when the broker is pending across restart", () =>
  Effect.gen(function* () {
    const store = yield* makePreparationStore;
    const f = fixture(store);
    const seen: PreparationRecord[] = [];
    const pending = yield* makePreparationRunner({
      ...f.deps,
      dispatch: (row) => {
        seen.push(row);
        return Effect.fail(new PreparationError({ detail: "Computer pending", pending: true }));
      },
    });
    yield* pending(input);
    const resumed = yield* makePreparationRunner(f.deps);
    yield* resumed({ ...input, brief: "Changed live data" });
    expect(f.dispatches).toHaveLength(1);
    expect(f.dispatches[0]?.intentId).toBe(seen[0]?.intentId);
    expect(f.dispatches[0]?.task).toBe(seen[0]?.task);
    expect(f.reports.map((r) => r.status)).toEqual(["pending", "started"]);
  }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer))),
);
it.effect(
  "reports worker failure once to the supervisor and never starts a replacement implicitly",
  () =>
    Effect.gen(function* () {
      const store = yield* makePreparationStore;
      const f = fixture(store);
      const run = yield* makePreparationRunner(f.deps);
      yield* run(input);
      f.fail();
      yield* run(input);
      yield* run(input);
      expect(f.dispatches).toHaveLength(1);
      expect(f.reports.map((r) => r.status)).toEqual(["started", "failed"]);
      expect(f.reports[1]?.failure).toBe("Worker timed out");
      expect(f.reports[1]?.supervisorThreadId).toBe("supervisor");
    }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer))),
);
it.effect("reports a refused start once without retrying it after restart", () =>
  Effect.gen(function* () {
    const store = yield* makePreparationStore;
    const f = fixture(store);
    let calls = 0;
    const deps = {
      ...f.deps,
      dispatch: () => {
        calls++;
        return Effect.fail(new PreparationError({ detail: "Confinement unavailable" }));
      },
    };
    yield* (yield* makePreparationRunner(deps))(input);
    yield* (yield* makePreparationRunner(deps))(input);
    expect(calls).toBe(1);
    expect(f.reports[0]).toMatchObject({ status: "failed", failure: "Confinement unavailable" });
    expect(f.reports).toHaveLength(1);
  }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer))),
);
it.effect("disabled, missing and future meetings do not claim or start workers", () =>
  Effect.gen(function* () {
    const store = yield* makePreparationStore;
    const f = fixture(store);
    const run = yield* makePreparationRunner(f.deps);
    yield* run({ ...input, configuration: { ...defaults, enabled: false } });
    yield* run({ ...input, meeting: null });
    yield* run({ ...input, now: Date.parse("2026-10-11T10:00:00Z") });
    expect(f.dispatches).toEqual([]);
    expect(yield* store.list(input.projectId)).toEqual([]);
  }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer))),
);
it.effect("the second window and another project each have their own single intent", () =>
  Effect.gen(function* () {
    const store = yield* makePreparationStore;
    const f = fixture(store);
    const run = yield* makePreparationRunner(f.deps);
    yield* run(input);
    yield* run({ ...input, now: Date.parse("2026-10-12T09:00:00Z") });
    yield* run({ ...input, now: Date.parse("2026-10-12T10:59:00Z") });
    yield* run({ ...input, projectId: ProjectId.make("other-project") });
    expect(f.dispatches.map((r) => r.leadMinutes)).toEqual([1440, 120, 1440]);
    expect(new Set(f.dispatches.map((r) => r.intentId)).size).toBe(3);
  }).pipe(Effect.provide(Layer.mergeAll(SqlitePersistenceMemory, NodeServices.layer))),
);
it.layer(NodeServices.layer)("preparation SQLite restart", (it) => {
  it.effect("does not start again after closing and reopening the real database", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "workjet-preparation-" });
        const database = path.join(home, "state.sqlite");
        const persistence = () =>
          makeSqlitePersistenceLive(database).pipe(
            Layer.provide(ServerConfig.layerTest(process.cwd(), home)),
            Layer.provide(NodeServices.layer),
          );
        let starts = 0;
        for (let restart = 0; restart < 2; restart++) {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const store = yield* makePreparationStore;
              const f = fixture(store);
              const run = yield* makePreparationRunner({
                ...f.deps,
                dispatch: (row) => {
                  starts++;
                  return f.deps.dispatch(row);
                },
              });
              yield* run(input);
            }).pipe(Effect.provide(persistence())),
          );
        }
        expect(starts).toBe(1);
      }),
    ),
  );
});
it("brief supplies the artifact fallback and requires supervisor review", () => {
  const prompt = preparationPrompt(
    {
      meetingAt: "2026-10-12T11:00:00Z",
      previousMeetingAt: "2026-10-05T11:00:00Z",
      leadMinutes: 120,
    },
    input.brief,
  );
  expect(prompt).toContain("keine Rückfragen");
  expect(prompt).toContain("kein Merge");
  expect(prompt).toContain("Supervisor prüft");
  expect(prompt).toContain("vollständigen Bericht als Rückbericht");
});
