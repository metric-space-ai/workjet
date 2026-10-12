// Retry fixtures use the virtual clock; no production sessions or Electron are started.
// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import type { Session } from "electron";
import { vi } from "vite-plus/test";
import { DesktopKeyRecovery, makeRecovery } from "../app/DesktopKeyRecovery.ts";
import {
  ElectronSafeStorage,
  ElectronSafeStorageDecryptError,
} from "../electron/ElectronSafeStorage.ts";
import { discoverCtoxManagedInstances } from "./CtoxManagedDiscovery.ts";
import { CtoxElectronSessions } from "./CtoxElectronSessions.ts";
import { make as makeLaunch } from "./CtoxManagedLaunch.ts";
import { recoverManagedAfterLogin } from "./CtoxKeyRecovery.ts";
vi.mock("electron", () => ({}));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const fixture = Effect.fn("test.recoveryLogin.fixture")(function* (failureStatus = 401) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "ctox-repair-login-" });
  const stateDir = `${root}/userdata`;
  yield* fs.makeDirectory(`${stateDir}/ctox`, { recursive: true });
  const secrets = encodeJson({
    version: 1,
    records: [{ id: "fixture", ciphertext: Buffer.from('old:{"version":2}').toString("base64") }],
  });
  yield* fs.writeFileString(`${stateDir}/ctox/secrets.json`, secrets);
  const storage = ElectronSafeStorage.of({
    isEncryptionAvailable: Effect.succeed(true),
    selectedStorageBackend: Effect.succeed(Option.none()),
    encryptString: (text) => Effect.succeed(Buffer.from(`new:${text}`)),
    decryptString: () =>
      Effect.fail(new ElectronSafeStorageDecryptError({ cause: "fixture changed key" })),
  });
  const owner = yield* makeRecovery({ baseDir: root, stateDir, platform: "darwin" }).pipe(
    Effect.provideService(ElectronSafeStorage, storage),
  );
  const initial = yield* owner.inspect;
  const begin = vi.fn(owner.beginManagedRepair!);
  const restart = vi.fn(owner.restartManagedRepairAfterLogin!);
  const recovery = DesktopKeyRecovery.of({
    ...owner,
    beginManagedRepair: begin,
    restartManagedRepairAfterLogin: restart,
  });
  const discovery = yield* Effect.promise(() =>
    discoverCtoxManagedInstances({
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          account: { tenants: [{ id: "fixture", businessName: "Fixture", status: "active" }] },
        }),
      }),
    }),
  );
  assert.equal(discovery._tag, "ready");
  if (discovery._tag !== "ready") return yield* Effect.die("fixture discovery failed");
  let authenticatedTokens = false;
  const requests: string[] = [];
  const session = {
    fetch: async (url: string) => {
      requests.push(url);
      const token = url.endsWith("/launch-token");
      if (token && !authenticatedTokens && failureStatus === -1) throw new DOMException("fixture timeout", "TimeoutError");
      if (token && !authenticatedTokens)
        return {
          ok: failureStatus === 200,
          status: failureStatus,
          json: async () => {
            if (failureStatus === 401) throw new Error("HTML sign-in response fixture");
            return { error: failureStatus === 200 ? "AUTH_REQUIRED" : "relation device_keys fixture missing" };
          },
        };
      return {
        ok: true,
        status: 200,
        json: async () =>
          token
            ? { launchConfigUrl: "https://ctox.dev/api/desktop/launch/fixture" }
            : {
                launchUrl: "https://fixture.ctox.dev/",
                pairingConfig: { transport: "webrtc", http_bridge_available: false },
              },
      };
    },
  } as unknown as Session;
  const launch = yield* makeLaunch().pipe(
    Effect.provideService(DesktopKeyRecovery, recovery),
    Effect.provideService(CtoxElectronSessions, {
      account: Effect.succeed(session),
      instance: () => Effect.succeed(session),
      clearInstance: () => Effect.die("Never delete fixture storage"),
    }),
  );
  return {
    fs,
    stateDir,
    initial,
    secrets,
    recovery,
    discovery,
    launch,
    requests,
    begin,
    restart,
    openRecovery: () => makeRecovery({ baseDir: root, stateDir, platform: "darwin" }).pipe(Effect.provideService(ElectronSafeStorage, storage)),
    authenticateTokens: () => {
      authenticatedTokens = true;
    },
  };
});

it.live("cache-only discovery cannot claim a repair or clear pendingLogin", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* fixture();
      yield* recoverManagedAfterLogin({
        discovery: { _tag: "ready", instances: h.discovery.instances },
        recovery: h.recovery,
        successfulLoginId: "not-a-verified-login",
        reconnect: h.launch.launch,
      });
      assert.equal(h.begin.mock.calls.length, 0);
      assert.equal(h.restart.mock.calls.length, 0);
      assert.equal(h.requests.length, 0);
      assert.isTrue((yield* h.recovery.inspect)?.pendingLogin);
      assert.isUndefined((yield* h.recovery.inspect)?.managedRepairStarted);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "an initial failed repair consumes its successful login ID without rearming on replay",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* fixture();
        const input = {
          discovery: h.discovery,
          recovery: h.recovery,
          reconnect: h.launch.launch,
          successfulLoginId: "initial-successful-login",
        };
        yield* recoverManagedAfterLogin(input);
        const generation = (yield* h.recovery.inspect)?.generation;
        yield* recoverManagedAfterLogin(input);
        assert.equal(h.requests.length, 1);
        assert.equal((yield* h.recovery.inspect)?.generation, generation);
        assert.isTrue((yield* h.recovery.inspect)?.pendingLogin);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

for (const status of [401, 403, 200, 400, 503, -1, 404]) {
  it.live(
    `classifies token status ${status} and permits exactly one new repair after verified login`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* fixture(status);
          const reconnect = h.launch.launch;
          yield* recoverManagedAfterLogin({
            discovery: h.discovery,
            recovery: h.recovery,
            reconnect,
          });
          const failed = yield* h.recovery.inspect;
          const reason = [400, 503, -1].includes(status) ? "retryable" : status === 404 ? "repair_failed" : "login_required";
          assert.deepEqual(failed?.instanceRepairs, [
            { instanceId: "managed:fixture", state: reason, failureClass: reason, operation: "launch-token", ...(status === -1 ? {} : { httpStatus: status }) },
          ]);
          assert.equal(failed?.pendingLogin, reason === "login_required");
          assert.equal(h.requests.length, 1);
          const blocked = yield* h.launch.launch(h.discovery.instances[0]!).pipe(Effect.flip);
          assert.equal(blocked.reason, reason);
          yield* recoverManagedAfterLogin({
            discovery: h.discovery,
            recovery: h.recovery,
            reconnect,
          });
          assert.equal(h.requests.length, 1);
          h.authenticateTokens();
          yield* recoverManagedAfterLogin({
            discovery: h.discovery,
            recovery: h.recovery,
            reconnect,
            successfulLoginId: "verified-login-one",
          });
          const healed = yield* h.recovery.inspect;
          assert.notEqual(healed?.generation, failed?.generation);
          assert.isFalse(healed?.pendingLogin);
          assert.deepEqual(healed?.instanceRepairs, [
            { instanceId: "managed:fixture", state: "repaired" },
          ]);
          assert.equal(h.requests.length, 3);
          yield* recoverManagedAfterLogin({
            discovery: h.discovery,
            recovery: h.recovery,
            reconnect,
            successfulLoginId: "verified-login-one",
          });
          assert.equal(h.requests.length, 3);
          const config = yield* h.launch.launch(h.discovery.instances[0]!);
          assert.equal(config.launchOrigin, "https://fixture.ctox.dev");
          assert.equal(
            yield* h.fs.readFileString(
              `${h.stateDir}/ctox/secrets.json.recovery-${h.initial?.generation}.bak`,
            ),
            h.secrets,
          );
          assert.equal(
            (yield* h.fs.readDirectory(`${h.stateDir}/ctox`)).filter((name) =>
              name.endsWith(".bak"),
            ).length,
            1,
          );
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect("a real 400 launch exchange heals on the next window without login", () =>
  Effect.scoped(Effect.gen(function* () {
    const h = yield* fixture(400);
    const run = () => recoverManagedAfterLogin({ discovery: h.discovery, recovery: h.recovery, reconnect: h.launch.launch });
    yield* run();
    assert.equal((yield* h.recovery.inspect)?.instanceRepairs?.[0]?.failureClass, "retryable");
    assert.equal((yield* h.recovery.inspect)?.instanceRepairs?.[0]?.httpStatus, 400);
    h.authenticateTokens();
    yield* TestClock.adjust("1 minute");
    yield* Effect.all([run(), run()], { concurrency: 2 });
    assert.equal(h.requests.length, 3);
    assert.equal((yield* h.recovery.inspect)?.instanceRepairs?.[0]?.state, "repaired");
    const config = yield* h.launch.launch(h.discovery.instances[0]!);
    assert.equal(config.launchOrigin, "https://fixture.ctox.dev");
  })).pipe(Effect.provide(NodeServices.layer)),
);
