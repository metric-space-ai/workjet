// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CtoxDiscoveryResult, type CtoxManagedInstance } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as EffectLayer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Session } from "electron";
import { vi } from "vite-plus/test";
import { DesktopEnvironment } from "./DesktopEnvironment.ts";
import { DesktopKeyRecovery, makeRecovery } from "./DesktopKeyRecovery.ts";
import {
  ElectronSafeStorage,
  ElectronSafeStorageDecryptError,
} from "../electron/ElectronSafeStorage.ts";
import * as Registry from "../ctox/CtoxInstanceRegistry.ts";
import * as Sessions from "../ctox/CtoxElectronSessions.ts";
import * as ManagedLaunch from "../ctox/CtoxManagedLaunch.ts";
import * as Auth from "../ctox/CtoxDevAuth.ts";
import * as Preferences from "../ctox/CtoxInstancePreferences.ts";
import { refresh } from "../ipc/methods/ctox.ts";

vi.mock("electron", () => ({}));
const decodeDiscovery = Schema.decodeUnknownEffect(CtoxDiscoveryResult);
const manualPairing = {
  displayName: "Manual fixture",
  instanceId: "office-1",
  syncRoom: "ctox-business-os:office-room",
  signalingUrls: ["wss://signal.example.com/room"],
  signalingAuthVersion: "ctox-role-bound-v1",
  browserToken: "raw-browser-token",
  browserTokenHash: "294dbc745bd2c516e81ae8a8bea452be757f78ae306a24f91c080885bd8bdf97", // gitleaks:allow
  nativeTokenHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  role: "admin",
  userId: "fixture-owner",
} as const;

for (const mode of ["ready", "signed_out", "partial_failure"] as const) {
  it.live(`repairs isolated CTOX key loss through refresh IPC: ${mode}`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "ctox-auto-repair-fixture-" });
        const stateDir = `${root}/userdata`;
        let key = "old";
        const storage = ElectronSafeStorage.of({
          isEncryptionAvailable: Effect.succeed(true),
          selectedStorageBackend: Effect.succeed(Option.none()),
          encryptString: (value) => Effect.sync(() => Buffer.from(`${key}:${value}`)),
          decryptString: (bytes) =>
            Effect.suspend(() => {
              const text = Buffer.from(bytes).toString();
              return text.startsWith(`${key}:`)
                ? Effect.succeed(text.slice(key.length + 1))
                : Effect.fail(
                    new ElectronSafeStorageDecryptError({ cause: "fixture key changed" }),
                  );
            }),
        });
        const environment = DesktopEnvironment.of({
          stateDir,
          homeDirectory: `${root}/empty-home`,
          platform: "darwin",
        } as DesktopEnvironment["Service"]);
        const openRegistry = (recovery?: DesktopKeyRecovery["Service"]) =>
          Registry.make({ localDaemon: { env: {} } }).pipe(
            Effect.provideService(DesktopEnvironment, environment),
            Effect.provideService(ElectronSafeStorage, storage),
            Effect.provide(
              recovery === undefined
                ? EffectLayer.empty
                : EffectLayer.succeed(DesktopKeyRecovery, recovery),
            ),
          );
        const first = yield* openRegistry();
        const manual = yield* first.importManualPairing(manualPairing);
        const oldKey = yield* first.deviceProofKey(
          { instanceId: "native-fixture", userId: "fixture-owner" },
          true,
        );
        const oldSecrets = yield* fs.readFileString(`${stateDir}/ctox/secrets.json`);
        const oldBindings = yield* fs.readFileString(`${stateDir}/ctox/instances.json`);
        const managed: CtoxManagedInstance[] = ["welsch", "thesen", "skf", "milton"].map(
          (name) => ({
            id: `managed:${name}`,
            source: "ctox_dev",
            displayName: name,
            status: "available",
            healthSummary: {
              dataPlane: "rxdb-webrtc",
              dataPlaneReady: false,
              httpDataProxy: false,
              nativePeerObserved: false,
            },
          }),
        );
        const preferences = Preferences.CtoxInstancePreferences.of({
          read: Effect.succeed(managed),
          remember: () => Effect.void,
          set: () => Effect.die("Never change user preferences during repair"),
        });
        key = "new";
        const openRecovery = () =>
          makeRecovery({ baseDir: root, stateDir, platform: "darwin" }).pipe(
            Effect.provideService(ElectronSafeStorage, storage),
          );
        const recovery = yield* openRecovery();
        const marker = yield* recovery.inspect;
        assert.deepEqual(marker?.unreadableStores, ["ctox"]);
        let signedIn = mode !== "signed_out";
        const exchanges: string[] = [];
        const accountSession = {
          fetch: async (url: string, init: RequestInit) => {
            assert.isTrue(signedIn);
            exchanges.push(url);
            if (
              mode === "partial_failure" &&
              url.endsWith("launch-token") &&
              String(init.body).includes('"skf"')
            )
              return { ok: false, status: 503, json: async () => ({ error: "fixture failure" }) };
            return {
              ok: true,
              status: 200,
              json: async () =>
                url.endsWith("launch-token")
                  ? { launchConfigUrl: "https://ctox.dev/api/desktop/launch/fixture" }
                  : {
                      launchUrl: "https://fixture.ctox.dev/",
                      pairingConfig: {
                        transport: "webrtc",
                        http_bridge_available: false,
                        instance_id: "native-fixture",
                        sync_room: "ctox-business-os:fixture",
                        signaling_browser_token: "new-fixture-token",
                      },
                    },
            };
          },
        } as unknown as Session;
        const registry = yield* openRegistry(recovery);
        const sessions = Sessions.CtoxElectronSessions.of({
          account: Effect.succeed(accountSession),
          instance: () =>
            Effect.andThen(
              registry
                .deviceProofKey({ instanceId: "native-fixture", userId: "fixture-owner" }, true)
                .pipe(Effect.orDie),
              Effect.succeed(accountSession),
            ),
          clearInstance: () => Effect.die("No storage deletion during recovery"),
        });
        const launch = yield* ManagedLaunch.make().pipe(
          Effect.provideService(Sessions.CtoxElectronSessions, sessions),
          Effect.provideService(DesktopKeyRecovery, recovery),
        );
        const auth = Auth.CtoxDevAuth.of({
          refresh: Effect.sync(() =>
            signedIn ? { _tag: "ready", instances: managed } : { _tag: "signed_out" },
          ),
          login: Effect.die("Automatic repair cannot open login"),
          logout: Effect.die("Automatic repair cannot log out"),
        });
        const callRefresh = (
          owner: DesktopKeyRecovery["Service"],
          targetRegistry: Registry.CtoxInstanceRegistry["Service"],
        ) =>
          refresh
            .handler(undefined)
            .pipe(
              Effect.flatMap(decodeDiscovery),
              Effect.provideService(DesktopKeyRecovery, owner),
              Effect.provideService(Auth.CtoxDevAuth, auth),
              Effect.provideService(Registry.CtoxInstanceRegistry, targetRegistry),
              Effect.provideService(Sessions.CtoxElectronSessions, sessions),
              Effect.provideService(ManagedLaunch.CtoxManagedLaunch, launch),
              Effect.provideService(Preferences.CtoxInstancePreferences, preferences),
            );
        if (!signedIn) {
          const waiting = yield* callRefresh(recovery, registry);
          assert.isTrue(waiting.keyRecovery?.pendingLogin);
          assert.equal(exchanges.length, 0);
          assert.deepEqual(
            waiting.keyRecovery?.instanceIssues
              ?.filter((entry) => entry.reason === "login_required")
              .map((entry) => entry.instanceId),
            managed.map((entry) => entry.id),
          );
          assert.isFalse(yield* fs.exists(`${stateDir}/ctox/secrets.json`));
          signedIn = true;
        }
        const repaired = yield* callRefresh(recovery, registry);
        assert.isFalse(repaired.keyRecovery?.pendingLogin);
        assert.deepEqual(
          repaired.keyRecovery?.repairedInstanceIds,
          managed
            .filter((entry) => mode !== "partial_failure" || entry.id !== "managed:skf")
            .map((entry) => entry.id),
        );
        assert.deepEqual(repaired.keyRecovery?.instanceIssues ?? [], [
          ...(mode === "partial_failure"
            ? [{ instanceId: "managed:skf", reason: "repair_failed" as const }]
            : []),
          { instanceId: manual.id, reason: "pairing_required" as const },
        ]);
        assert.equal(exchanges.length, mode === "partial_failure" ? 7 : 8);
        const newKey = yield* registry.deviceProofKey(
          { instanceId: "native-fixture", userId: "fixture-owner" },
          false,
        );
        assert.notEqual(newKey.thumbprint, oldKey.thumbprint);
        assert.include(
          yield* fs.readFileString(`${stateDir}/ctox/secrets.json`),
          Buffer.from("new:").toString("base64").slice(0, 4),
        );
        yield* callRefresh(recovery, registry);
        const restarted = yield* openRecovery();
        const restartedRegistry = yield* openRegistry(restarted);
        yield* callRefresh(restarted, restartedRegistry);
        assert.equal((yield* restarted.inspect)?.generation, marker?.generation);
        assert.equal(exchanges.length, mode === "partial_failure" ? 7 : 8);
        const config = yield* launch.launch(managed[0]!);
        assert.include(config.launchUrl, "ctox_config=");
        if (mode === "partial_failure") {
          const beforeBlockedLaunch = exchanges.length;
          yield* launch
            .launch(managed[2]!)
            .pipe(Effect.provideService(DesktopKeyRecovery, restarted), Effect.flip);
          assert.equal(
            exchanges.length,
            beforeBlockedLaunch,
            "A failed generation must not produce a launch retry storm",
          );
        }
        assert.equal(
          yield* fs.readFileString(
            `${stateDir}/ctox/secrets.json.recovery-${marker?.generation}.bak`,
          ),
          oldSecrets,
        );
        assert.equal(
          yield* fs.readFileString(
            `${stateDir}/ctox/instances.json.recovery-${marker?.generation}.bak`,
          ),
          oldBindings,
        );
        assert.equal(yield* fs.readFileString(`${stateDir}/ctox/instances.json`), oldBindings);
        // Explicit manual re-pairing can keep its public ID after the automatic managed repair.
        const replaced = yield* registry.importManualPairing({
          ...manualPairing,
          replacesInstanceId: manual.id,
        });
        assert.equal(replaced.id, manual.id);
        assert.equal((yield* registry.resolvePairedLaunch(manual.id)).descriptor.id, manual.id);
        assert.equal(
          (yield* fs.readDirectory(`${stateDir}/ctox`)).filter((name) => name.endsWith(".bak"))
            .length,
          2,
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}
