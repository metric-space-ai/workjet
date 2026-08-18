// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  CtoxAppRail,
  CtoxAppRailError,
  make,
  mergeRailApps,
  refreshRailCache,
} from "./CtoxAppRail.ts";

type CtoxAppRailService = CtoxAppRail["Service"];

const NOW = 1_800_000_000_000;

describe("mergeRailApps", () => {
  it("keeps docked apps listed while closed and marks the active module open", () => {
    const apps = mergeRailApps({
      docked: ["crm", "ledger"],
      cached: [{ id: "crm", title: "CRM", lastSeenAt: NOW - 1_000 }],
      live: {
        apps: [{ id: "ledger", title: "Ledger" }],
        activeModuleId: "ledger",
        openModuleIds: ["ledger"],
      },
      nowEpochMs: NOW,
    });
    assert.deepEqual(apps, [
      { id: "crm", title: "CRM", docked: true, open: false, lastSeenAt: NOW - 1_000 },
      { id: "ledger", title: "Ledger", docked: true, open: true, lastSeenAt: NOW },
    ]);
  });

  it("shows an undocked app only while it is open", () => {
    const openRows = mergeRailApps({
      docked: [],
      cached: [],
      live: {
        apps: [{ id: "notes", title: "Notes" }],
        activeModuleId: null,
        openModuleIds: ["notes"],
      },
      nowEpochMs: NOW,
    });
    assert.deepEqual(openRows, [
      { id: "notes", title: "Notes", docked: false, open: true, lastSeenAt: NOW },
    ]);
    const closedRows = mergeRailApps({
      docked: [],
      cached: [{ id: "notes", title: "Notes", lastSeenAt: NOW - 5 }],
      live: { apps: [{ id: "notes", title: "Notes" }], activeModuleId: null, openModuleIds: [] },
      nowEpochMs: NOW,
    });
    assert.deepEqual(closedRows, []);
  });

  it("renders docked apps from cache when the instance is disconnected", () => {
    const apps = mergeRailApps({
      docked: ["crm"],
      cached: [{ id: "crm", title: "CRM", lastSeenAt: NOW - 60_000 }],
      nowEpochMs: NOW,
    });
    assert.deepEqual(apps, [
      { id: "crm", title: "CRM", docked: true, open: false, lastSeenAt: NOW - 60_000 },
    ]);
  });

  it("drops invalid and duplicate module ids", () => {
    const apps = mergeRailApps({
      docked: ["crm", "crm", "../escape", "b".repeat(70)],
      cached: [],
      nowEpochMs: NOW,
    });
    assert.deepEqual(
      apps.map((app) => app.id),
      ["crm"],
    );
  });
});

describe("refreshRailCache", () => {
  it("records live apps with timestamps and keeps prior titles", () => {
    const next = refreshRailCache({
      cached: [{ id: "crm", title: "Customer Relations", lastSeenAt: NOW - 10 }],
      live: [{ id: "crm" }, { id: "ledger", title: "Ledger" }],
      nowEpochMs: NOW,
    });
    assert.deepEqual(next, [
      { id: "crm", title: "Customer Relations", lastSeenAt: NOW },
      { id: "ledger", title: "Ledger", lastSeenAt: NOW },
    ]);
  });

  it("caps the cache at its maximum and keeps the most recent entries", () => {
    const cached = Array.from({ length: 128 }, (_, index) => ({
      id: `app-${index}`,
      lastSeenAt: index,
    }));
    const next = refreshRailCache({
      cached,
      live: [{ id: "fresh" }],
      nowEpochMs: NOW,
    });
    assert.equal(next.length, 128);
    assert.equal(next[0]?.id, "fresh");
    assert.isFalse(next.some((app) => app.id === "app-0"));
  });
});

describe("CtoxAppRail store", () => {
  const harness = <A>(body: (rail: CtoxAppRailService) => Effect.Effect<A, CtoxAppRailError>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "ctox-app-rail-" }),
      );
      const environment = DesktopEnvironment.DesktopEnvironment.of({
        stateDir,
        platform: "darwin",
      } as DesktopEnvironment.DesktopEnvironment["Service"]);
      const rail = yield* make().pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      );
      const result = yield* body(rail).pipe(Effect.orDie);
      return { result, stateDir, fs, path };
    }).pipe(Effect.provide(NodeServices.layer));

  it.effect("persists dock state and live app cache per instance", () =>
    Effect.gen(function* () {
      yield* harness((rail) =>
        Effect.gen(function* () {
          yield* rail.setDocked("inst-a", "crm", true);
          yield* rail.setDocked("inst-a", "ledger", true);
          yield* rail.setDocked("inst-a", "crm", false);
          yield* rail.recordLiveApps("inst-a", [{ id: "notes", title: "Notes" }], NOW);
          const stateA = yield* rail.stateForInstance("inst-a");
          assert.deepEqual(stateA.docked, ["ledger"]);
          assert.deepEqual(stateA.apps, [{ id: "notes", title: "Notes", lastSeenAt: NOW }]);
          const stateB = yield* rail.stateForInstance("inst-b");
          assert.deepEqual(stateB, { docked: [], apps: [] });
          yield* rail.removeInstance("inst-a");
          const removed = yield* rail.stateForInstance("inst-a");
          assert.deepEqual(removed, { docked: [], apps: [] });
        }),
      );
    }),
  );

  it.effect("falls back to an empty rail when the store file is corrupt", () =>
    Effect.gen(function* () {
      yield* harness((rail) =>
        Effect.gen(function* () {
          yield* rail.setDocked("inst-a", "crm", true);
          return rail;
        }),
      ).pipe(
        Effect.flatMap(({ result: rail, stateDir, fs, path }) =>
          Effect.gen(function* () {
            const railPath = path.join(stateDir, "ctox", "app-rail.json");
            yield* fs.writeFileString(railPath, "{ not json");
            const state = yield* rail.stateForInstance("inst-a");
            assert.deepEqual(state, { docked: [], apps: [] });
            // A later write repairs the store.
            yield* rail.setDocked("inst-a", "crm", true);
            const repaired = yield* rail.stateForInstance("inst-a");
            assert.deepEqual(repaired.docked, ["crm"]);
          }),
        ),
      );
    }),
  );
});
