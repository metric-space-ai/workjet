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
vi.mock("electron", () => ({ safeStorage: {} }));

it.layer(NodeServices.layer)("local key loss detection", (it) => {
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
          JSON.stringify({
            version: 1,
            encryptedCatalog: Buffer.from(
              '{"schemaVersion":1,"targets":[],"profiles":[],"credentials":[],"remoteDpopTokens":[]}',
            ).toString("base64"),
          }),
        );
        yield* fs.writeFileString(
          `${stateDir}/ctox/secrets.json`,
          JSON.stringify({
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
        const session = JSON.stringify({
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
        const catalog = JSON.stringify({
          schemaVersion: 1,
          targets: [],
          profiles: [],
          credentials: [],
          remoteDpopTokens: [],
        });
        yield* fs.writeFileString(
          `${stateDir}/connection-catalog.json`,
          JSON.stringify({
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
      }),
    );
  }
});
