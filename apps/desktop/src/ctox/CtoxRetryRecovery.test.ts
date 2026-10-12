import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import { makeRecovery, DesktopKeyRecovery } from "../app/DesktopKeyRecovery.ts";
import { ElectronSafeStorage } from "../electron/ElectronSafeStorage.ts";
import {
  recoverManagedAfterLogin,
  CtoxRepairScheduler,
  layer as schedulerLayer,
} from "./CtoxKeyRecovery.ts";
import { CtoxManagedLaunchError, CtoxManagedLaunch } from "./CtoxManagedLaunch.ts";
import { CtoxDevAuth } from "./CtoxDevAuth.ts";
import { CtoxElectronSessions } from "./CtoxElectronSessions.ts";
import type { CtoxManagedDiscoveryResult } from "@workjet/contracts";
import type { Session } from "electron";
vi.mock("electron", () => ({}));

const fixture = Effect.fn(function* (count = 1) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "ctox-retry-fixture-" });
  const stateDir = `${root}/userdata`;
  const ids = Array.from({ length: count }, (_, index) => `managed:fixture-${index}`);
  yield* fs.makeDirectory(stateDir, { recursive: true });
  const generation = "1-11111111-1111-4111-8111-111111111111";
  yield* fs.writeFileString(
    `${stateDir}/key-recovery.json`,
    JSON.stringify({
      version: 1,
      generation,
      unreadableStores: ["ctox"],
      ctoxRetired: true,
      pendingLogin: true,
    }),
  );
  yield* fs.makeDirectory(`${stateDir}/ctox`, { recursive: true });
  const backup = `${stateDir}/ctox/secrets.json.recovery-${generation}.bak`;
  yield* fs.writeFileString(backup, "opaque fixture ciphertext");
  const storage = ElectronSafeStorage.of({
    isEncryptionAvailable: Effect.succeed(true),
    selectedStorageBackend: Effect.succeed(Option.none()),
    encryptString: () => Effect.die("unused"),
    decryptString: () => Effect.die("no protected data in fixture"),
  });
  const open = () =>
    makeRecovery({ baseDir: root, stateDir, platform: "darwin" }).pipe(
      Effect.provideService(ElectronSafeStorage, storage),
    );
  const owner = yield* open();
  const discovery: CtoxManagedDiscoveryResult = {
    _tag: "ready",
    sessionVerified: true,
    instances: ids.map((id) => ({
      id,
      source: "ctox_dev",
      displayName: "Fixture",
      status: "available",
      domain: "fixture.ctox.dev",
      healthSummary: {
        dataPlane: "rxdb-webrtc",
        dataPlaneReady: true,
        httpDataProxy: false,
        nativePeerObserved: true,
      },
    })),
  };
  return { fs, stateDir, ids, owner, open, backup, discovery };
});

it.effect(
  "400 retries automatically once after its durable window, including parallel discoveries and restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* fixture();
        let calls = 0;
        let available = false;
        const reconnect = () =>
          Effect.suspend(() => {
            calls++;
            return available
              ? Effect.succeed({ launchOrigin: "https://fixture.ctox.dev" })
              : Effect.fail(
                  new CtoxManagedLaunchError({
                    operation: "launch-token",
                    reason: "retryable",
                    httpStatus: 400,
                  }),
                );
          });
        const run = (recovery = h.owner) =>
          recoverManagedAfterLogin({ recovery, discovery: h.discovery, reconnect });
        yield* run();
        const failed = yield* h.owner.inspect;
        assert.equal(failed?.attempt, 1);
        assert.equal(failed?.nextAt, 60_000);
        yield* TestClock.adjust("59 seconds");
        const restarted = yield* h.open();
        yield* run(restarted);
        assert.equal(calls, 1);
        assert.equal((yield* restarted.inspect)?.generation, failed?.generation);
        available = true;
        yield* TestClock.adjust("1 second");
        yield* Effect.all([run(restarted), run(restarted)], { concurrency: 2 });
        assert.equal(calls, 2);
        const healed = yield* restarted.inspect;
        assert.notEqual(healed?.generation, failed?.generation);
        assert.equal(healed?.attempt, 2);
        assert.equal(healed?.instanceRepairs?.[0]?.state, "repaired");
        yield* TestClock.adjust("2 hours");
        yield* run(restarted);
        assert.equal(calls, 2);
        assert.equal(yield* h.fs.readFileString(h.backup), "opaque fixture ciphertext");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "migrates all four unclassified version-2 failures without login and retains backups",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* fixture(4);
        const state = yield* h.owner.inspect;
        yield* h.fs.writeFileString(
          `${h.stateDir}/key-recovery.json`,
          JSON.stringify({
            ...state,
            pendingLogin: false,
            managedRepairStarted: true,
            managedRepairVersion: 2,
            instanceRepairs: h.ids.map((instanceId) => ({ instanceId, state: "repair_failed" })),
          }),
        );
        const migrated = yield* h.open();
        assert.deepEqual(
          (yield* migrated.inspect)?.instanceRepairs?.map((entry) => entry.state),
          h.ids.map(() => "retryable"),
        );
        assert.isFalse((yield* migrated.inspect)?.pendingLogin);
        assert.isTrue(yield* migrated.prepareManagedRetry!());
        const next = yield* migrated.inspect;
        assert.isTrue(yield* migrated.beginManagedRepair!(h.ids, next?.generation));
        for (const id of h.ids)
          yield* migrated.recordInstanceRepair!(id, "repaired", next?.generation);
        assert.deepEqual(
          (yield* migrated.inspect)?.instanceRepairs?.map((entry) => entry.state),
          h.ids.map(() => "repaired"),
        );
        assert.equal(yield* h.fs.readFileString(h.backup), "opaque fixture ciphertext");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "explicit reconnect retries only its definitive failure immediately and preserves other outcomes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* fixture(2);
        yield* h.owner.beginManagedRepair!(h.ids);
        yield* h.owner.recordInstanceRepair!(h.ids[0]!, "repair_failed", undefined, {
          failureClass: "repair_failed",
          operation: "launch-token",
          httpStatus: 404,
        });
        yield* h.owner.recordInstanceRepair!(h.ids[1]!, "repaired");
        const old = yield* h.owner.inspect;
        assert.isFalse(yield* h.owner.prepareManagedRetry!());
        assert.isTrue(yield* h.owner.prepareManagedRetry!(h.ids[0]!));
        let calls = 0;
        yield* recoverManagedAfterLogin({
          recovery: h.owner,
          discovery: h.discovery,
          reconnect: () =>
            Effect.sync(() => {
              calls++;
            }),
        });
        assert.equal(calls, 1);
        assert.notEqual((yield* h.owner.inspect)?.generation, old?.generation);
        assert.deepEqual(
          (yield* h.owner.inspect)?.instanceRepairs?.map((entry) => entry.state),
          ["repaired", "repaired"],
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "backs off for 1, 2, 5, 15, 30, 60 minutes and then hourly without duplicate attempts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* fixture();
        let calls = 0;
        const run = () =>
          recoverManagedAfterLogin({
            recovery: h.owner,
            discovery: h.discovery,
            reconnect: () =>
              Effect.suspend(() => {
                calls++;
                return Effect.fail(
                  new CtoxManagedLaunchError({
                    operation: "launch-token",
                    reason: "retryable",
                    httpStatus: 503,
                  }),
                );
              }),
          });
        yield* run();
        for (const minutes of [1, 2, 5, 15, 30, 60, 60]) {
          const before = calls;
          yield* TestClock.adjust(minutes * 60_000 - 1);
          yield* run();
          assert.equal(calls, before);
          yield* TestClock.adjust(1);
          yield* Effect.all([run(), run()], { concurrency: 2 });
          assert.equal(calls, before + 1);
        }
        assert.equal((yield* h.owner.inspect)?.attempt, 8);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "interrupted repair keeps the nextAt lease and device recovery is claimed once per generation across starts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* fixture();
        yield* h.owner.beginManagedRepair!(h.ids);
        assert.isTrue(yield* h.owner.claimDeviceRecovery!);
        const restarted = yield* h.open();
        assert.isFalse(yield* restarted.claimDeviceRecovery!);
        assert.equal((yield* restarted.inspect)?.instanceRepairs?.[0]?.state, "retryable");
        assert.isFalse(yield* restarted.prepareManagedRetry!());
        yield* TestClock.adjust("1 minute");
        assert.isTrue(yield* restarted.prepareManagedRetry!());
        assert.isTrue(yield* restarted.claimDeviceRecovery!);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "renderer-independent scheduler starts a due repair and is scoped to desktop lifetime",
  () => {
    let state: "retryable" | "repairing" | "repaired" = "retryable";
    let started = true;
    let generation = "0-11111111-1111-4111-8111-111111111111";
    let calls = 0;
    const recovery = DesktopKeyRecovery.of({
      inspect: Effect.sync(() => ({
        version: 1 as const,
        generation,
        unreadableStores: [],
        pendingLogin: false,
        managedRepairStarted: started,
        nextAt: 60_000,
        instanceRepairs: [{ instanceId: "managed:fixture", state }],
      })),
      completeLogin: Effect.void,
      prepareManagedRetry: () =>
        Effect.sync(() => {
          if (!started || state !== "retryable") return false;
          started = false;
          generation = "60000-22222222-2222-4222-8222-222222222222";
          return true;
        }),
      beginManagedRepair: () =>
        Effect.sync(() => {
          if (started) return false;
          started = true;
          state = "repairing";
          return true;
        }),
      recordInstanceRepair: () =>
        Effect.sync(() => {
          state = "repaired";
        }),
    });
    const dependencies = Layer.mergeAll(
      Layer.succeed(DesktopKeyRecovery, recovery),
      Layer.succeed(CtoxDevAuth, {
        refresh: Effect.succeed({
          _tag: "ready",
          sessionVerified: true,
          instances: [
            {
              id: "managed:fixture",
              source: "ctox_dev",
              status: "available",
              displayName: "Fixture",
              domain: "fixture.ctox.dev",
              healthSummary: {
                dataPlane: "rxdb-webrtc",
                dataPlaneReady: true,
                httpDataProxy: false,
                nativePeerObserved: true,
              },
            },
          ],
        } as const),
        login: Effect.die("no login"),
        logout: Effect.die("unused"),
      }),
      Layer.succeed(CtoxElectronSessions, {
        account: Effect.die("unused"),
        instance: () => Effect.succeed({} as Session),
        clearInstance: () => Effect.die("no deletion"),
      }),
      Layer.succeed(CtoxManagedLaunch, {
        launch: () =>
          Effect.sync(() => {
            calls++;
            return {
              launchUrl: "https://fixture.ctox.dev",
              launchOrigin: "https://fixture.ctox.dev",
            };
          }),
        resolveBusinessOsInstanceId: () => Effect.die("unused"),
      }),
    );
    return Effect.scoped(
      Effect.gen(function* () {
        yield* CtoxRepairScheduler;
        yield* TestClock.adjust("59 seconds");
        assert.equal(calls, 0);
        yield* TestClock.adjust("1 second");
        assert.equal(calls, 1);
        yield* TestClock.adjust("1 hour");
        assert.equal(calls, 1);
      }).pipe(Effect.provide(schedulerLayer.pipe(Layer.provide(dependencies)))),
    );
  },
);

it.effect(
  "discovery failures have durable windows and a real sign-in can restart an empty marker",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* fixture();
        const initial = yield* h.owner.inspect;
        yield* h.owner.deferManagedDiscovery!(initial!.generation, false);
        const delayed = yield* h.open();
        assert.isFalse((yield* delayed.inspect)?.pendingLogin);
        assert.isFalse(yield* delayed.prepareManagedRetry!());
        yield* TestClock.adjust("1 minute");
        assert.isTrue(yield* delayed.prepareManagedRetry!());
        const current = yield* delayed.inspect;
        yield* delayed.deferManagedDiscovery!(current!.generation, true);
        assert.isTrue((yield* delayed.inspect)?.pendingLogin);
        yield* TestClock.adjust("1 day");
        assert.isFalse(yield* delayed.prepareManagedRetry!());
        assert.isTrue(yield* delayed.restartManagedRepairAfterLogin!("successful-login"));
        let calls = 0;
        yield* recoverManagedAfterLogin({
          recovery: delayed,
          discovery: h.discovery,
          reconnect: () =>
            Effect.sync(() => {
              calls++;
            }),
        });
        assert.equal(calls, 1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
