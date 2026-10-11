import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import {
  ElectronSafeStorage,
  ElectronSafeStorageDecryptError,
} from "../electron/ElectronSafeStorage.ts";
import { makeRecovery } from "./DesktopKeyRecovery.ts";
import { makeWithDirectory } from "../../../server/src/auth/ServerSecretStore.ts";
import { makeControlDeviceClient, DEVICE_SECRET_NAME } from "../ctox/CtoxControlDeviceClient.ts";
vi.mock("electron", () => ({ safeStorage: {} }));
const encodeFixture = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeServices.layer)("local key loss detection", (it) => {
  it.effect("migrates the all-failed #443 marker and admits one new generation per successful login", () => Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "key-recovery-login-migration-" });
    const stateDir = `${baseDir}/userdata`;
    const generation = "1-11111111-1111-4111-8111-111111111111";
    const ids = ["managed:welsch", "managed:thesen", "managed:skf", "managed:milton"];
    yield* fs.makeDirectory(`${stateDir}/ctox`, { recursive: true });
    const backup = `${stateDir}/ctox/secrets.json.recovery-${generation}.bak`;
    yield* fs.writeFileString(backup, "opaque old ciphertext fixture");
    yield* fs.writeFileString(`${stateDir}/key-recovery.json`, yield* encodeFixture({
      version: 1, generation, pendingLogin: false, unreadableStores: ["ctox"], ctoxRetired: true,
      managedRepairStarted: true, instanceRepairs: ids.map((instanceId) => ({ instanceId, state: "repair_failed" })),
    }));
    const storage = ElectronSafeStorage.of({ isEncryptionAvailable: Effect.succeed(true), selectedStorageBackend: Effect.succeed(Option.none()),
      encryptString: (text) => Effect.succeed(Buffer.from(text)), decryptString: () => Effect.die("No protected store should be opened in this marker-only fixture") });
    const open = () => makeRecovery({ baseDir, stateDir, platform: "darwin" }).pipe(Effect.provideService(ElectronSafeStorage, storage));
    const owner = yield* open();
    const migrated = yield* owner.inspect;
    assert.isTrue(migrated?.pendingLogin);
    assert.equal(migrated?.generation, generation);
    assert.deepEqual(migrated?.instanceRepairs?.map((entry) => entry.state), ids.map(() => "login_required"));
    assert.isFalse(yield* owner.beginManagedRepair!(ids));
    assert.isTrue(yield* owner.restartManagedRepairAfterLogin!("successful-login-one"));
    const renewed = yield* owner.inspect;
    assert.notEqual(renewed?.generation, generation);
    assert.isTrue(yield* owner.beginManagedRepair!(ids));
    yield* owner.recordInstanceRepair!(ids[0]!, "login_required");
    yield* owner.completeLogin;
    assert.isTrue((yield* owner.inspect)?.pendingLogin);
    assert.isFalse(yield* owner.restartManagedRepairAfterLogin!("successful-login-one"));
    const restarted = yield* open();
    assert.equal((yield* restarted.inspect)?.generation, renewed?.generation);
    assert.isFalse(yield* restarted.restartManagedRepairAfterLogin!("successful-login-one"));
    assert.isTrue(yield* restarted.restartManagedRepairAfterLogin!("successful-login-two"));
    assert.equal(yield* fs.readFileString(backup), "opaque old ciphertext fixture");
    assert.deepEqual(yield* fs.readDirectory(`${stateDir}/ctox`), [`secrets.json.recovery-${generation}.bak`]);
  }));
  it.effect("recovers CTOX alone without retiring valid login or public bindings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "key-recovery-ctox-only-" });
      const stateDir = `${baseDir}/userdata`;
      const userDataDir = `${baseDir}/electron`;
      let key = "old";
      const storage = ElectronSafeStorage.of({
        isEncryptionAvailable: Effect.succeed(true),
        selectedStorageBackend: Effect.succeed(Option.none()),
        encryptString: (value) => Effect.sync(() => Buffer.from(`${key}:${value}`)),
        decryptString: (bytes) =>
          Effect.suspend(() => {
            const value = Buffer.from(bytes).toString();
            return value.startsWith(`${key}:`)
              ? Effect.succeed(value.slice(key.length + 1))
              : Effect.fail(new ElectronSafeStorageDecryptError({ cause: "fixture key changed" }));
          }),
      });
      yield* fs.makeDirectory(`${stateDir}/ctox`, { recursive: true });
      const secrets = yield* encodeFixture({
        version: 1,
        records: [],
        deviceKeys: [
          {
            id: "fixture",
            ciphertext: Buffer.from(
              yield* storage.encryptString(
                '{"scope":{"instanceId":"native","userId":"owner"},"pkcs8":"fixture"}',
              ),
            ).toString("base64"),
          },
        ],
      });
      yield* fs.writeFileString(`${stateDir}/ctox/secrets.json`, secrets);
      const bindings = '{"version":1,"instances":[]}';
      yield* fs.writeFileString(`${stateDir}/ctox/instances.json`, bindings);
      yield* fs.writeFileString(`${stateDir}/clerk-tokens.json`, "valid sign-in fixture");
      const partition = "persist:workjet-ctox-control-plane";
      const directory = `${userDataDir}/Partitions/${partition.slice("persist:".length)}`;
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(`${directory}/Cookies`, "valid cookie fixture");
      key = "new";
      const open = () =>
        makeRecovery({ baseDir, stateDir, userDataDir, platform: "darwin" }).pipe(
          Effect.provideService(ElectronSafeStorage, storage),
        );
      const owner = yield* open();
      const state = yield* owner.inspect;
      assert.deepEqual(state?.unreadableStores, ["ctox"]);
      assert.isTrue(state?.pendingLogin);
      assert.isTrue(state?.ctoxRetired);
      assert.equal(
        yield* fs.readFileString(`${stateDir}/ctox/secrets.json.recovery-${state?.generation}.bak`),
        secrets,
      );
      assert.equal(
        yield* fs.readFileString(
          `${stateDir}/ctox/instances.json.recovery-${state?.generation}.bak`,
        ),
        bindings,
      );
      assert.equal(yield* fs.readFileString(`${stateDir}/ctox/instances.json`), bindings);
      assert.isFalse(yield* fs.exists(`${stateDir}/ctox/secrets.json`));
      yield* owner.retirePartition!(partition);
      assert.equal(yield* fs.readFileString(`${directory}/Cookies`), "valid cookie fixture");
      assert.equal(
        yield* fs.readFileString(`${stateDir}/clerk-tokens.json`),
        "valid sign-in fixture",
      );
      const claims = yield* Effect.all(
        [
          owner.beginManagedRepair!(["managed:fixture"]),
          owner.beginManagedRepair!(["managed:fixture"]),
        ],
        { concurrency: 2 },
      );
      assert.deepEqual(claims.sort(), [false, true]);
      assert.isFalse((yield* owner.inspect)?.pendingLogin);
      const restarted = yield* open();
      assert.equal((yield* restarted.inspect)?.generation, state?.generation);
      assert.deepEqual((yield* restarted.inspect)?.instanceRepairs, [
        { instanceId: "managed:fixture", state: "repair_failed" },
      ]);
      assert.isFalse(yield* restarted.beginManagedRepair!(["managed:fixture"]));
      assert.equal(
        (yield* fs.readDirectory(`${stateDir}/ctox`)).filter((name) => name.endsWith(".bak"))
          .length,
        2,
      );
    }),
  );
  it.effect(
    "does not reset for one corrupt store when catalog and device key remain readable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "key-recovery-single-store-" });
        const stateDir = `${baseDir}/userdata`;
        const storage = ElectronSafeStorage.of({
          isEncryptionAvailable: Effect.succeed(true),
          selectedStorageBackend: Effect.succeed(Option.none()),
          encryptString: (value) => Effect.succeed(Buffer.from(value)),
          decryptString: (value) => Effect.succeed(Buffer.from(value).toString()),
        });
        yield* fs.makeDirectory(`${baseDir}/runtime/desktop-auth`, { recursive: true });
        yield* fs.makeDirectory(`${stateDir}/ctox`, { recursive: true });
        yield* fs.writeFileString(`${baseDir}/runtime/desktop-auth/session.enc`, "corrupt session");
        yield* fs.writeFileString(
          `${stateDir}/connection-catalog.json`,
          yield* encodeFixture({
            version: 1,
            encryptedCatalog: Buffer.from(
              '{"schemaVersion":1,"targets":[],"profiles":[],"credentials":[],"remoteDpopTokens":[]}',
            ).toString("base64"),
          }),
        );
        yield* fs.writeFileString(
          `${stateDir}/ctox/secrets.json`,
          yield* encodeFixture({
            version: 1,
            records: [],
            deviceKeys: [
              {
                id: "device",
                ciphertext: Buffer.from(
                  '{"scope":{"instanceId":"native","userId":"user"},"pkcs8":"fixture-private-key"}',
                ).toString("base64"),
              },
            ],
          }),
        );
        const owner = yield* makeRecovery({ baseDir, stateDir }).pipe(
          Effect.provideService(ElectronSafeStorage, storage),
        );
        assert.isUndefined(yield* owner.inspect);
        assert.isFalse(yield* fs.exists(`${stateDir}/key-recovery.json`));
        assert.equal(
          yield* fs.readFileString(`${baseDir}/runtime/desktop-auth/session.enc`),
          "corrupt session",
        );
      }),
  );
  for (const garbage of [false, true]) {
    it.effect(`detects a changed key across two starts, including garbage=${garbage}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "key-recovery-" });
        const stateDir = `${baseDir}/userdata`;
        const deviceStore = yield* makeWithDirectory(`${stateDir}/secrets`);
        let deviceBytes: Uint8Array | undefined;
        const controlDevice = makeControlDeviceClient({
          baseUrl: "http://127.0.0.1:3107",
          now: () => Date.parse("2026-10-11T17:00:00Z"),
          read: async () => deviceBytes,
          write: async (bytes) => {
            deviceBytes = bytes;
          },
          fetch: async (_url) => {
            if (String(_url).endsWith("/challenge"))
              return new Response(
                JSON.stringify({
                  nonce: Buffer.alloc(32, 7).toString("base64url"),
                  expiresAt: "2026-10-11T17:01:00Z",
                }),
              );
            return new Response(
              JSON.stringify({
                authentication: "device-key",
                account: {
                  tenants: [
                    {
                      id: "11111111-1111-4111-8111-111111111111",
                      businessName: "Fixture instance",
                      status: "active",
                    },
                  ],
                },
              }),
            );
          },
        });
        yield* Effect.promise(() =>
          controlDevice.enroll(async (_url, init) => {
            const jwk = JSON.parse(String(init.body)).public_jwk;
            const thumbprint = (await import("node:crypto"))
              .createHash("sha256")
              .update(JSON.stringify(jwk))
              .digest("base64url");
            return new Response(
              JSON.stringify({
                device: { id: "fixture-device", thumbprint, created_at: "2026-10-11T17:00:00Z" },
              }),
              { status: 201 },
            );
          }),
        );
        assert.isDefined(deviceBytes);
        yield* deviceStore.set(DEVICE_SECRET_NAME, deviceBytes!);
        const storedDevice = yield* deviceStore.get(DEVICE_SECRET_NAME);
        const privateFile = yield* fs.stat(`${stateDir}/secrets/${DEVICE_SECRET_NAME}.bin`);
        assert.equal(privateFile.mode & 0o777, 0o600);
        assert.equal((yield* fs.stat(`${stateDir}/secrets`)).mode & 0o777, 0o700);
        let key = "first";
        let available = true;
        const storage = ElectronSafeStorage.of({
          isEncryptionAvailable: Effect.sync(() => available),
          selectedStorageBackend: Effect.succeed(Option.none()),
          encryptString: (value) => Effect.sync(() => Buffer.from(`${key}:${value}`)),
          decryptString: (bytes) =>
            Effect.suspend(() => {
              const value = Buffer.from(bytes).toString();
              if (value.startsWith(`${key}:`)) return Effect.succeed(value.slice(key.length + 1));
              return garbage
                ? Effect.succeed("wrong-key garbage")
                : Effect.fail(new ElectronSafeStorageDecryptError({ cause: "wrong key" }));
            }),
        });
        const open = () =>
          makeRecovery({ baseDir, stateDir }).pipe(
            Effect.provideService(ElectronSafeStorage, storage),
          );
        const session = yield* encodeFixture({
          version: 1,
          baseDir,
          environmentId: "environment",
          sessionId: "11111111-1111-4111-8111-111111111111",
          token: "fake-token",
          expiresAt: "2099-01-01T00:00:00Z",
        });
        yield* fs.makeDirectory(`${baseDir}/runtime/desktop-auth`, { recursive: true });
        yield* fs.makeDirectory(stateDir, { recursive: true });
        yield* fs.writeFile(
          `${baseDir}/runtime/desktop-auth/session.enc`,
          yield* storage.encryptString(session),
        );
        const first = yield* open();
        assert.isUndefined(yield* first.inspect);
        const catalog = yield* encodeFixture({
          schemaVersion: 1,
          targets: [],
          profiles: [],
          credentials: [],
          remoteDpopTokens: [],
        });
        yield* fs.writeFileString(
          `${stateDir}/connection-catalog.json`,
          yield* encodeFixture({
            version: 1,
            encryptedCatalog: Buffer.from(yield* storage.encryptString(catalog)).toString("base64"),
          }),
        );
        assert.isUndefined(yield* (yield* open()).inspect);
        key = "second";
        available = false;
        assert.isUndefined(yield* (yield* open()).inspect);
        available = true;
        const second = yield* open();
        const recovery = yield* second.inspect;
        assert.deepEqual(recovery?.unreadableStores, ["session", "catalog"]);
        assert.isTrue(recovery?.pendingLogin);
        assert.deepEqual(yield* second.inspect, recovery);
        assert.equal(
          yield* fs.readFileString(`${baseDir}/runtime/desktop-auth/session.enc`),
          `first:${session}`,
        );
        assert.notInclude(yield* fs.readFileString(`${stateDir}/key-recovery.json`), "fake-token");
        const persistedDevice = yield* deviceStore.get(DEVICE_SECRET_NAME);
        assert.deepEqual(persistedDevice, storedDevice);
        deviceBytes = Option.getOrUndefined(persistedDevice);
        const restored = yield* Effect.promise(() => controlDevice.recoverOnce());
        assert.isDefined(restored);
        const payload = yield* Effect.promise(() => restored!.clone().json());
        assert.equal(payload.authentication, "device-key");
      }),
    );
  }
});
