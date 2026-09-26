import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { HostProcessPlatform } from "@workjet/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

vi.mock("electron", () => ({ safeStorage: {} }));
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import { LocalServiceCredential, make } from "./DesktopLocalServiceCredential.ts";

const fixture = Effect.fn("test.localServiceCredential.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "workjet-local-credential-" }),
  );
  const control = {
    available: true,
    denyDecrypt: false,
    denyEncrypt: false,
    backend: "gnome_libsecret",
  };
  // Opaque ciphertext double. This verifies persistence/binding/error handling,
  // not Electron or the operating system's cryptography.
  const protectedValues = new Map<string, string>();
  const storage = ElectronSafeStorage.ElectronSafeStorage.of({
    isEncryptionAvailable: Effect.sync(() => control.available),
    selectedStorageBackend: Effect.sync(() => Option.some(control.backend)),
    encryptString: (plaintext) =>
      Effect.gen(function* () {
        if (control.denyEncrypt)
          return yield* new ElectronSafeStorage.ElectronSafeStorageEncryptError({
            cause: "fixture-secret-must-not-leak",
          });
        const ciphertext = `opaque-${protectedValues.size}`;
        protectedValues.set(ciphertext, plaintext);
        return new TextEncoder().encode(ciphertext);
      }),
    decryptString: (bytes) =>
      Effect.gen(function* () {
        const value = protectedValues.get(new TextDecoder().decode(bytes));
        if (control.denyDecrypt || value === undefined)
          return yield* new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: "fixture-secret-must-not-leak",
          });
        return value;
      }),
  });
  const open = (
    environmentId = "environment-a",
    profile = baseDir,
    platform: NodeJS.Platform = "darwin",
  ) =>
    make({ baseDir: profile, environmentId }).pipe(
      Effect.provideService(ElectronSafeStorage.ElectronSafeStorage, storage),
      Effect.provideService(HostProcessPlatform, platform),
    );
  const credential = Schema.decodeUnknownSync(LocalServiceCredential)({
    version: 1,
    baseDir,
    environmentId: "environment-a",
    sessionId: "11111111-1111-4111-8111-111111111111",
    token: "fixture-secret-must-not-leak",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  return { fs, baseDir, control, open, credential };
});

it.layer(NodeServices.layer)("protected local service credential", (it) => {
  it.effect(
    "retains incomplete enrollment across store recreation and refuses a different receipt",
    () =>
      Effect.gen(function* () {
        const { fs, open, credential } = yield* fixture();
        const first = yield* open();
        yield* first.assertEnrollmentSettled;
        const attemptId = yield* first.beginEnrollment;
        const pendingPath = first.filePath.replace("session.enc", "enrollment-pending.json");
        const before = yield* fs.readFileString(pendingPath);
        assert.notInclude(before, Redacted.value(credential.token));
        const reopened = yield* open();
        yield* reopened.assertEnrollmentSettled.pipe(Effect.flip);
        yield* reopened.beginEnrollment.pipe(Effect.flip);
        yield* reopened.finishEnrollment("wrong-attempt").pipe(Effect.flip);
        assert.equal(yield* fs.readFileString(pendingPath), before);
        yield* reopened.finishEnrollment(attemptId);
        yield* reopened.assertEnrollmentSettled;
      }),
  );

  it.effect(
    "reopens an encrypted credential in a fresh store instance without plaintext on disk",
    () =>
      Effect.gen(function* () {
        const { fs, open, credential } = yield* fixture();
        const first = yield* open();
        assert.isTrue(Option.isNone(yield* first.get));
        yield* first.save(credential);
        const bytes = yield* fs.readFileString(first.filePath);
        assert.notInclude(bytes, Redacted.value(credential.token));
        const second = yield* open();
        const loaded = yield* second.get;
        assert.isTrue(Option.isSome(loaded));
        if (Option.isSome(loaded)) {
          assert.equal(loaded.value.sessionId, credential.sessionId);
          assert.equal(Redacted.value(loaded.value.token), Redacted.value(credential.token));
        }
      }),
  );
  it.effect(
    "rejects a different environment or copied profile credential without resetting it",
    () =>
      Effect.gen(function* () {
        const { fs, open, credential } = yield* fixture();
        const store = yield* open();
        yield* store.save(credential);
        const before = yield* fs.readFileString(store.filePath);
        const other = yield* open("environment-b");
        yield* other.get.pipe(Effect.flip);
        const otherBase = yield* fs.makeTempDirectoryScoped({ prefix: "workjet-other-profile-" });
        const copied = yield* open("environment-a", otherBase);
        yield* fs.makeDirectory(`${otherBase}/runtime/desktop-auth`, { recursive: true });
        yield* fs.copyFile(store.filePath, copied.filePath);
        yield* copied.get.pipe(Effect.flip);
        assert.equal(yield* fs.readFileString(store.filePath), before);
        assert.equal(yield* fs.readFileString(copied.filePath), before);
      }),
  );
  it.effect(
    "preserves existing ciphertext on keychain denial and redacts the underlying cause",
    () =>
      Effect.gen(function* () {
        const { fs, open, credential, control } = yield* fixture();
        const store = yield* open();
        yield* store.save(credential);
        const before = yield* fs.readFileString(store.filePath);
        control.denyDecrypt = true;
        const error = yield* store.save(credential).pipe(Effect.flip);
        assert.notInclude(String(error), "fixture-secret-must-not-leak");
        assert.equal(yield* fs.readFileString(store.filePath), before);
        control.denyDecrypt = false;
        control.denyEncrypt = true;
        yield* store.save(credential).pipe(Effect.flip);
        assert.equal(yield* fs.readFileString(store.filePath), before);
      }),
  );
  it.effect("refuses unavailable protection and Linux basic-text storage", () =>
    Effect.gen(function* () {
      const { fs, open, credential, control } = yield* fixture();
      const store = yield* open();
      control.available = false;
      yield* store.save(credential).pipe(Effect.flip);
      assert.isFalse(yield* fs.exists(store.filePath));
      control.available = true;
      control.backend = "basic_text";
      const linux = yield* open("environment-a", credential.baseDir, "linux");
      yield* linux.save(credential).pipe(Effect.flip);
      assert.isFalse(yield* fs.exists(linux.filePath));
    }),
  );
  it.effect("removes only the explicitly named saved session", () =>
    Effect.gen(function* () {
      const { fs, open, credential } = yield* fixture();
      const store = yield* open();
      yield* store.save(credential);
      yield* store.remove("stale-session").pipe(Effect.flip);
      assert.isTrue(yield* fs.exists(store.filePath));
      assert.isTrue(yield* store.remove(credential.sessionId));
      assert.isFalse(yield* fs.exists(store.filePath));
    }),
  );
});
