import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { type CtoxManagedInstance } from "@workjet/contracts";
import { HostProcessPlatform } from "@workjet/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import type { Session } from "electron";
import { vi } from "vite-plus/test";
import * as Credential from "../backend/DesktopLocalServiceCredential.ts";
import {
  makeSessionAccess,
  type LocalSessionDependencies,
} from "../backend/DesktopLocalServiceSession.ts";
import type { DesktopBackendStartConfig } from "../backend/DesktopBackendManager.ts";
import { ElectronSafeStorage } from "../electron/ElectronSafeStorage.ts";
import * as Saved from "../settings/DesktopSavedEnvironments.ts";
import * as Catalog from "./DesktopConnectionCatalogStore.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as Environment from "./DesktopEnvironment.ts";
import { DesktopKeyRecovery, makeRecovery } from "./DesktopKeyRecovery.ts";
import * as Registry from "../ctox/CtoxInstanceRegistry.ts";
import * as Sessions from "../ctox/CtoxElectronSessions.ts";
import * as ManagedLaunch from "../ctox/CtoxManagedLaunch.ts";
import { ctoxManagedSessionPartition } from "../ctox/CtoxManagedDiscovery.ts";
import { recoverManagedAfterLogin } from "../ctox/CtoxKeyRecovery.ts";
vi.mock("electron", () => ({ safeStorage: {}, session: {} }));
const decodeCredential = Schema.decodeUnknownEffect(Credential.LocalServiceCredential);

it.layer(NodeServices.layer)("changed safeStorage key at startup", (it) => {
  it.effect(
    "heals session and catalog, then reconnects managed CTOX with exactly one sign-in",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "workjet-key-loss-acceptance-" }),
        );
        let key = "first";
        const storage = ElectronSafeStorage.of({
          isEncryptionAvailable: Effect.succeed(true),
          selectedStorageBackend: Effect.succeed(Option.none()),
          encryptString: (value) => Effect.sync(() => Buffer.from(`${key}:${value}`)),
          // Wrong keys can return garbage rather than throw on Electron/macOS.
          decryptString: (bytes) =>
            Effect.sync(() => {
              const value = Buffer.from(bytes).toString();
              return value.startsWith(`${key}:`)
                ? value.slice(key.length + 1)
                : "garbage after key change";
            }),
        });
        const environmentLayer = Environment.layer({
          dirname: "/fixture/src",
          homeDirectory: root,
          platform: "darwin",
          processArch: "arm64",
          appVersion: "0.0.81",
          appPath: "/fixture",
          isPackaged: true,
          resourcesPath: "/fixture/resources",
          runningUnderArm64Translation: false,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ WORKJET_HOME: root })),
          ),
        );
        const dependencies = Layer.mergeAll(
          environmentLayer,
          Layer.succeed(ElectronSafeStorage, storage),
          Layer.succeed(HostProcessPlatform, "darwin"),
        );
        yield* Effect.gen(function* () {
          const environment = yield* Environment.DesktopEnvironment;
          const target = {
            version: 1 as const,
            baseDir: root,
            environmentId: "fixture-environment",
            runtimeInstanceId: "fixture-runtime",
            serverVersion: "0.0.81",
            origin: "http://127.0.0.1:3773",
          };
          const config: DesktopBackendStartConfig = {
            executablePath: "/fixture/node",
            entryPath: "/fixture/server.mjs",
            cwd: root,
            args: [],
            env: {},
            extendEnv: false,
            localSession: { baseDir: root, serverVersion: target.serverVersion },
            httpBaseUrl: new URL(target.origin),
            bootstrap: {
              mode: "desktop",
              port: 3773,
              noBrowser: true,
              workjetHome: root,
              host: "127.0.0.1",
              desktopBootstrapToken: "fixture",
              tailscaleServeEnabled: false,
              tailscaleServePort: 443,
            },
            bootstrapDelivery: "fd3",
            captureOutput: true,
            preflightFailure: Option.none(),
          };
          const credential = yield* decodeCredential({
            ...target,
            version: 1,
            sessionId: "11111111-1111-4111-8111-111111111111",
            token: "first-fixture-token",
            expiresAt: "2099-01-01T00:00:00Z",
          });
          const firstCredential = yield* Credential.make(target);
          yield* firstCredential.save(credential);
          const saved = yield* Saved.make;
          const firstCatalog = yield* Catalog.make.pipe(
            Effect.provideService(Saved.DesktopSavedEnvironments, saved),
          );
          yield* firstCatalog.set(
            '{"schemaVersion":1,"targets":[],"profiles":[],"credentials":[],"remoteDpopTokens":[]}',
          );
          const userDataDir = `${root}/electron`;
          const openRecovery = () =>
            makeRecovery({
              baseDir: root,
              stateDir: environment.stateDir,
              userDataDir,
              platform: "darwin",
            });
          assert.isUndefined(yield* (yield* openRecovery()).inspect);
          const catalogPath = `${environment.stateDir}/connection-catalog.json`;
          const oldCatalog = yield* fs.readFileString(catalogPath);
          const oldSession = yield* fs.readFile(firstCredential.filePath);
          const history = '{"project":"fixture-project","messages":["keep this history"]}';
          yield* fs.writeFileString(`${environment.stateDir}/project-history.json`, history);
          yield* fs.writeFileString(
            `${environment.stateDir}/clerk-tokens.json`,
            "first:opaque-fixture-clerk-tokens",
          );
          const managed: CtoxManagedInstance = {
            id: "managed:tenant-fixture",
            source: "ctox_dev",
            displayName: "Fixture tenant",
            status: "available",
            healthSummary: {
              dataPlane: "rxdb-webrtc",
              dataPlaneReady: false,
              httpDataProxy: false,
              nativePeerObserved: false,
            },
          };
          const partitions = [
            Sessions.CTOX_CONTROL_PLANE_PARTITION,
            ctoxManagedSessionPartition(managed),
          ];
          for (const partition of partitions) {
            const directory = `${userDataDir}/Partitions/${partition.slice("persist:".length)}`;
            yield* fs.makeDirectory(directory, { recursive: true });
            yield* fs.writeFileString(`${directory}/Cookies`, "first:opaque-fixture-cookie-file");
          }

          key = "second";
          const recovery = yield* openRecovery();
          const detected = yield* recovery.inspect;
          assert.deepEqual(detected?.unreadableStores, ["session", "catalog"]);
          const events: string[] = [];
          const newCredential = yield* Credential.make(target);
          const sessionDependencies: LocalSessionDependencies = {
            keyLossDetected: recovery.inspect.pipe(
              Effect.map((state) => state?.pendingLogin === true),
              Effect.orDie,
            ),
            confirmRecovery: () => Effect.die("A key loss must not ask for a checkbox."),
            discover: () => Effect.succeed(target),
            openStore: () => Effect.succeed(newCredential),
            listEnrollmentSessions: () => Effect.succeed([]),
            revoke: (_config, _target, sessionId) =>
              Effect.sync(() => {
                assert.equal(sessionId, credential.sessionId);
                events.push("revoke-old");
              }),
            issue: () =>
              Effect.sync(() => {
                events.push("issue-new");
                return {
                  ...credential,
                  token: Redacted.make("second-fixture-token"),
                  sessionId: "22222222-2222-4222-8222-222222222222" as typeof credential.sessionId,
                };
              }),
            validate: () => Effect.void,
          };
          const access = yield* makeSessionAccess(sessionDependencies);
          const prepared = yield* access.prepareWithRecovery(config);
          assert.notEqual(prepared.credential.sessionId, credential.sessionId);
          assert.deepEqual(events, ["revoke-old", "issue-new"]);
          const catalog = yield* Catalog.make.pipe(
            Effect.provideService(Saved.DesktopSavedEnvironments, saved),
            Effect.provideService(DesktopKeyRecovery, recovery),
          );
          assert.isTrue(Option.isSome(yield* catalog.get));
          const backups = (yield* fs.readDirectory(environment.stateDir)).filter((name) =>
            name.startsWith("connection-catalog.json.recovery-"),
          );
          assert.equal(backups.length, 1);
          assert.equal(
            yield* fs.readFileString(`${environment.stateDir}/${backups[0]}`),
            oldCatalog,
          );
          const retired = (yield* fs.readDirectory(`${root}/runtime`)).find((name) =>
            name.startsWith("desktop-auth-retired-"),
          );
          assert.isDefined(retired);
          assert.deepEqual(
            yield* fs.readFile(`${root}/runtime/${retired}/session.enc`),
            oldSession,
          );

          let signedIn = false;
          let userActions = 0;
          const exchanges: string[] = [];
          const accountSession = {
            fetch: async (url: string) => {
              assert.isTrue(signedIn, "Managed credentials require the simulated identity check.");
              exchanges.push(url);
              return {
                ok: true,
                status: 200,
                json: async () =>
                  url.endsWith("launch-token")
                    ? { launchConfigUrl: "https://ctox.dev/api/desktop/launch/fixture" }
                    : {
                        launchUrl: "https://tenant-fixture.ctox.dev/",
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
          const sessions = Sessions.CtoxElectronSessions.of({
            account: Effect.andThen(
              recovery.retirePartition!(Sessions.CTOX_CONTROL_PLANE_PARTITION).pipe(Effect.orDie),
              Effect.succeed(accountSession),
            ),
            instance: (instance) =>
              Effect.andThen(
                recovery.retirePartition!(ctoxManagedSessionPartition(instance)).pipe(Effect.orDie),
                Effect.succeed(accountSession),
              ),
            clearInstance: () => Effect.die("Recovery must preserve old storage."),
          });
          const launch = yield* ManagedLaunch.make().pipe(
            Effect.provideService(Sessions.CtoxElectronSessions, sessions),
          );
          const reconnect = (instance: CtoxManagedInstance) =>
            Effect.andThen(sessions.instance(instance), launch.launch(instance));
          yield* recoverManagedAfterLogin({
            discovery: { _tag: "signed_out" },
            recovery,
            reconnect,
          });
          assert.equal(exchanges.length, 0);
          assert.isTrue((yield* recovery.inspect)?.pendingLogin);
          // The single human action: complete ctox.dev's identity check.
          yield* sessions.account;
          userActions++;
          signedIn = true;
          yield* recoverManagedAfterLogin({
            discovery: { _tag: "ready", instances: [managed], sessionVerified: true },
            recovery,
            reconnect,
          });
          assert.equal(userActions, 1);
          assert.equal(exchanges.length, 2);
          assert.isFalse((yield* recovery.inspect)?.pendingLogin);
          assert.isTrue((yield* recovery.inspect)?.catalogReset);
          for (const partition of partitions) {
            const directory = `${userDataDir}/Partitions/${partition.slice("persist:".length)}`;
            assert.equal(
              yield* fs.readFileString(`${directory}.recovery-${detected?.generation}/Cookies`),
              "first:opaque-fixture-cookie-file",
            );
            yield* fs.makeDirectory(directory, { recursive: true });
            yield* fs.writeFileString(
              `${directory}/Cookies`,
              "second:authenticated-fixture-cookies",
            );
          }
          const restarted = yield* openRecovery();
          assert.isFalse((yield* restarted.inspect)?.pendingLogin);
          for (const partition of partitions) yield* restarted.retirePartition!(partition);
          assert.equal(
            yield* fs.readFileString(
              `${userDataDir}/Partitions/${partitions[0]?.slice("persist:".length)}/Cookies`,
            ),
            "second:authenticated-fixture-cookies",
          );
          assert.equal(
            yield* fs.readFileString(`${environment.stateDir}/project-history.json`),
            history,
          );
          assert.equal(
            yield* fs.readFileString(
              `${environment.stateDir}/clerk-tokens.json.recovery-${detected?.generation}.bak`,
            ),
            "first:opaque-fixture-clerk-tokens",
          );
          const registry = yield* Registry.make({ localDaemon: { env: {} } }).pipe(
            Effect.provideService(DesktopKeyRecovery, restarted),
          );
          const discovery = yield* registry.merge({ _tag: "ready", instances: [managed] });
          assert.equal(discovery._tag, "ready");
          assert.isFalse(discovery.keyRecovery?.pendingLogin);
        }).pipe(Effect.provide(dependencies));
      }),
  );
});
