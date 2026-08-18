// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

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
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

describe("mergeRailApps", () => {
  it("orders docked apps first and marks the active module open", () => {
    const apps = mergeRailApps({
      docked: ["crm", "ledger"],
      cached: [{ id: "crm", title: "CRM", lastSeenAt: NOW - 1_000 }],
      live: {
        apps: [
          { id: "notes", title: "Notes" },
          { id: "ledger", title: "Ledger" },
        ],
        activeModuleId: "ledger",
        openModuleIds: ["ledger"],
      },
      nowEpochMs: NOW,
    });
    assert.deepEqual(apps, [
      { id: "crm", title: "CRM", docked: true, open: false, lastSeenAt: NOW },
      { id: "ledger", title: "Ledger", docked: true, open: true, lastSeenAt: NOW },
      { id: "notes", title: "Notes", docked: false, open: false, lastSeenAt: NOW },
    ]);
  });

  it("lists every installed app and marks the open ones", () => {
    const rows = mergeRailApps({
      docked: [],
      cached: [],
      live: {
        apps: [
          { id: "notes", title: "Notes" },
          { id: "mail", title: "Mail" },
        ],
        activeModuleId: null,
        openModuleIds: ["notes"],
      },
      nowEpochMs: NOW,
    });
    assert.deepEqual(rows, [
      { id: "notes", title: "Notes", docked: false, open: true, lastSeenAt: NOW },
      { id: "mail", title: "Mail", docked: false, open: false, lastSeenAt: NOW },
    ]);
  });

  it("renders the full cached app list when the instance is disconnected", () => {
    const apps = mergeRailApps({
      docked: ["crm"],
      cached: [
        { id: "crm", title: "CRM", lastSeenAt: NOW - 60_000 },
        { id: "mail", title: "Mail", lastSeenAt: NOW - 90_000 },
      ],
      nowEpochMs: NOW,
    });
    assert.deepEqual(apps, [
      { id: "crm", title: "CRM", docked: true, open: false, lastSeenAt: NOW - 60_000 },
      { id: "mail", title: "Mail", docked: false, open: false, lastSeenAt: NOW - 90_000 },
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
  const keyA = { identity: "ctox:instance-a", legacyInstanceId: "inst-a" } as const;

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
          yield* rail.setDocked(keyA, "crm", true);
          yield* rail.setDocked(keyA, "ledger", true);
          yield* rail.setDocked(keyA, "crm", false);
          yield* rail.recordLiveApps(keyA, [{ id: "notes", title: "Notes" }], NOW);
          const stateA = yield* rail.stateForInstance(keyA);
          assert.deepEqual(stateA.docked, ["ledger"]);
          assert.deepEqual(stateA.apps, [{ id: "notes", title: "Notes", lastSeenAt: NOW }]);
          const stateB = yield* rail.stateForInstance({ identity: "ctox:instance-b" });
          assert.deepEqual(stateB, { docked: [], apps: [] });
          yield* rail.removeInstance(keyA);
          const removed = yield* rail.stateForInstance(keyA);
          assert.deepEqual(removed, { docked: [], apps: [] });
        }),
      );
    }),
  );

  it.effect("keeps docked pins and cached apps across a remove and re-pair", () =>
    harness((rail) =>
      Effect.gen(function* () {
        yield* rail.setDocked({ ...keyA, legacyInstanceId: "paired:x:first" }, "crm", true);
        yield* rail.recordLiveApps(
          { ...keyA, legacyInstanceId: "paired:x:first" },
          [{ id: "crm", title: "CRM" }],
          NOW,
          "Office",
        );
        // Re-pairing the same CTOX instance yields a new registry id but the
        // same stable identity.
        const state = yield* rail.stateForInstance({
          ...keyA,
          legacyInstanceId: "paired:x:second",
        });
        assert.deepEqual(state.docked, ["crm"]);
        assert.deepEqual(state.apps, [{ id: "crm", title: "CRM", lastSeenAt: NOW }]);
        assert.equal(state.workspaceName, "Office");
      }),
    ),
  );

  it.effect("adopts a v1 record for the resolved identity and drops unresolved ones", () =>
    harness((rail) =>
      Effect.gen(function* () {
        yield* rail.setDocked({ identity: "seed" }, "seed-app", true);
        return rail;
      }),
    ).pipe(
      Effect.flatMap(({ result: rail, stateDir, fs, path }) =>
        Effect.gen(function* () {
          const railPath = path.join(stateDir, "ctox", "app-rail.json");
          yield* fs.writeFileString(
            railPath,
            `${encodeUnknownJson({
              version: 1,
              instances: [
                {
                  instanceId: "paired:x:first",
                  workspaceName: "Office",
                  docked: ["crm"],
                  apps: [{ id: "crm", title: "CRM", lastSeenAt: NOW }],
                },
                { instanceId: "paired:y:other", docked: ["ledger"], apps: [] },
              ],
            })}\n`,
          );

          const migrated = yield* rail.stateForInstance({
            identity: keyA.identity,
            legacyInstanceId: "paired:x:first",
          });
          assert.deepEqual(migrated.docked, ["crm"]);
          assert.deepEqual(migrated.apps, [{ id: "crm", title: "CRM", lastSeenAt: NOW }]);
          assert.equal(migrated.workspaceName, "Office");

          const stored = decodeUnknownJson(yield* fs.readFileString(railPath)) as {
            readonly version: number;
            readonly instances: readonly { readonly identity: string }[];
          };
          assert.equal(stored.version, 2);
          assert.deepEqual(
            stored.instances.map((record) => record.identity),
            [keyA.identity, "legacy:paired:y:other"],
          );

          // The adopted record now answers to the re-paired registry id.
          const rePaired = yield* rail.stateForInstance({
            identity: keyA.identity,
            legacyInstanceId: "paired:x:third",
          });
          assert.deepEqual(rePaired.docked, ["crm"]);
          // A v1 record whose identity was never resolved is not served
          // under a stable identity.
          const unresolved = yield* rail.stateForInstance({ identity: "ctox:unknown" });
          assert.deepEqual(unresolved, { docked: [], apps: [] });
        }),
      ),
      Effect.orDie,
    ),
  );

  it.effect("falls back to an empty rail when the store file is corrupt", () =>
    Effect.gen(function* () {
      yield* harness((rail) =>
        Effect.gen(function* () {
          yield* rail.setDocked(keyA, "crm", true);
          return rail;
        }),
      ).pipe(
        Effect.flatMap(({ result: rail, stateDir, fs, path }) =>
          Effect.gen(function* () {
            const railPath = path.join(stateDir, "ctox", "app-rail.json");
            yield* fs.writeFileString(railPath, "{ not json");
            const state = yield* rail.stateForInstance(keyA);
            assert.deepEqual(state, { docked: [], apps: [] });
            // A later write repairs the store.
            yield* rail.setDocked(keyA, "crm", true);
            const repaired = yield* rail.stateForInstance(keyA);
            assert.deepEqual(repaired.docked, ["crm"]);
          }),
        ),
      );
    }),
  );
});
