import { assert, describe, it } from "@effect/vitest";
import { beforeEach, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

const storage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn(() => Buffer.from("legacy-ciphertext")),
  decryptString: vi.fn(() => "legacy-plaintext"),
  isAsyncEncryptionAvailable: vi.fn<() => Promise<boolean>>(),
  encryptStringAsync: vi.fn<(value: string) => Promise<Buffer>>(),
  decryptStringAsync:
    vi.fn<(value: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>>(),
  getSelectedStorageBackend: vi.fn(() => "gnome_libsecret"),
}));

vi.mock("electron", () => ({ safeStorage: storage }));

import * as ElectronSafeStorage from "./ElectronSafeStorage.ts";

const makeStorage = (platform: "darwin" | "linux" | "win32") =>
  ElectronSafeStorage.make.pipe(Effect.provideService(HostProcessPlatform, platform));

beforeEach(() => {
  vi.clearAllMocks();
  storage.isAsyncEncryptionAvailable.mockResolvedValue(true);
  storage.encryptStringAsync.mockResolvedValue(Buffer.from("async-ciphertext"));
  storage.decryptStringAsync.mockResolvedValue({ result: "plaintext", shouldReEncrypt: false });
});

describe("ElectronSafeStorage", () => {
  it.effect("keeps the event loop responsive while macOS keychain authorization is pending", () =>
    Effect.gen(function* () {
      const authorization = Promise.withResolvers<boolean>();
      storage.isAsyncEncryptionAvailable.mockReturnValue(authorization.promise);
      const service = yield* makeStorage("darwin");
      let settled = false;
      const available = yield* service.isEncryptionAvailable.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            settled = true;
          }),
        ),
        Effect.forkScoped,
      );
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      assert.isFalse(settled);
      assert.strictEqual(storage.isEncryptionAvailable.mock.calls.length, 0);
      authorization.resolve(true);
      assert.isTrue(yield* Fiber.join(available));
    }).pipe(Effect.scoped),
  );

  it.effect("uses asynchronous macOS encryption and keeps the ciphertext contract", () =>
    Effect.gen(function* () {
      const service = yield* makeStorage("darwin");
      const ciphertext = yield* service.encryptString("sentinel");
      assert.deepEqual(ciphertext, Buffer.from("async-ciphertext"));
      assert.deepEqual(storage.encryptStringAsync.mock.calls, [["sentinel"]]);
      assert.strictEqual(storage.encryptString.mock.calls.length, 0);
    }),
  );

  it.effect("returns the plaintext from asynchronous macOS decryption", () =>
    Effect.gen(function* () {
      storage.decryptStringAsync.mockResolvedValue({
        result: "saved connection",
        shouldReEncrypt: true,
      });
      const service = yield* makeStorage("darwin");
      const ciphertext = new Uint8Array([1, 2, 3]);
      assert.strictEqual(yield* service.decryptString(ciphertext), "saved connection");
      assert.deepEqual(storage.decryptStringAsync.mock.calls, [[Buffer.from(ciphertext)]]);
      assert.strictEqual(storage.decryptString.mock.calls.length, 0);
    }),
  );

  it.effect("reports keychain failures without falling back to synchronous storage", () =>
    Effect.gen(function* () {
      const cause = new Error("keychain authorization denied");
      storage.isAsyncEncryptionAvailable.mockRejectedValue(cause);
      storage.encryptStringAsync.mockRejectedValue(cause);
      storage.decryptStringAsync.mockRejectedValue(cause);
      const service = yield* makeStorage("darwin");
      const availability = yield* Effect.flip(service.isEncryptionAvailable);
      const encryption = yield* Effect.flip(service.encryptString("sentinel"));
      const decryption = yield* Effect.flip(service.decryptString(new Uint8Array([1])));
      assert.instanceOf(availability, ElectronSafeStorage.ElectronSafeStorageAvailabilityError);
      assert.instanceOf(encryption, ElectronSafeStorage.ElectronSafeStorageEncryptError);
      assert.instanceOf(decryption, ElectronSafeStorage.ElectronSafeStorageDecryptError);
      assert.strictEqual(availability.cause, cause);
      assert.strictEqual(encryption.cause, cause);
      assert.strictEqual(decryption.cause, cause);
      assert.strictEqual(storage.isEncryptionAvailable.mock.calls.length, 0);
      assert.strictEqual(storage.encryptString.mock.calls.length, 0);
      assert.strictEqual(storage.decryptString.mock.calls.length, 0);
    }),
  );

  for (const platform of ["linux", "win32"] as const) {
    it.effect(`preserves the existing ${platform} keystore`, () =>
      Effect.gen(function* () {
        const service = yield* makeStorage(platform);
        assert.isTrue(yield* service.isEncryptionAvailable);
        assert.deepEqual(
          yield* service.encryptString("sentinel"),
          Buffer.from("legacy-ciphertext"),
        );
        assert.strictEqual(yield* service.decryptString(new Uint8Array([1])), "legacy-plaintext");
        assert.strictEqual(storage.isAsyncEncryptionAvailable.mock.calls.length, 0);
        assert.strictEqual(storage.encryptStringAsync.mock.calls.length, 0);
        assert.strictEqual(storage.decryptStringAsync.mock.calls.length, 0);
      }),
    );
  }
});
