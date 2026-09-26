import { AuthSessionId, TrimmedNonEmptyString } from "@workjet/contracts";
import { HostProcessPlatform } from "@workjet/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

/** Main-local secret. It must never be sent through renderer IPC or written as plaintext. */
export const LocalServiceCredential = Schema.Struct({
  version: Schema.Literal(1),
  baseDir: TrimmedNonEmptyString,
  environmentId: TrimmedNonEmptyString,
  sessionId: AuthSessionId,
  token: Schema.RedactedFromValue(TrimmedNonEmptyString),
  expiresAt: TrimmedNonEmptyString,
});
export type LocalServiceCredential = typeof LocalServiceCredential.Type;

export class LocalServiceCredentialError extends Schema.TaggedErrorClass<LocalServiceCredentialError>()(
  "LocalServiceCredentialError",
  { operation: Schema.String },
) {
  override get message(): string {
    return `Could not ${this.operation} the protected local service credential.`;
  }
}

/** Uses the existing OS-backed Electron safeStorage; not the remote connection catalog. */
export const make = Effect.fn("desktop.localServiceCredential.make")(function* (input: {
  readonly baseDir: string;
  readonly environmentId: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const platform = yield* HostProcessPlatform;
  const baseDir = yield* fs
    .realPath(input.baseDir)
    .pipe(
      Effect.mapError(
        () => new LocalServiceCredentialError({ operation: "resolve the profile for" }),
      ),
    );
  const directory = path.join(baseDir, "runtime", "desktop-auth");
  const filePath = path.join(directory, "session.enc");
  const lock = yield* Semaphore.make(1);
  const fail = (operation: string) => new LocalServiceCredentialError({ operation });
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalServiceCredential));
  const encode = Schema.encodeEffect(Schema.fromJsonString(LocalServiceCredential));
  const requireProtection = Effect.gen(function* () {
    if (!(yield* safeStorage.isEncryptionAvailable)) return yield* fail("unlock");
    if (platform === "linux") {
      const backend = yield* safeStorage.selectedStorageBackend;
      if (
        Option.isNone(backend) ||
        !["gnome_libsecret", "gnome-libsecret", "kwallet", "kwallet5", "kwallet6"].includes(
          backend.value,
        )
      ) {
        return yield* fail("protect");
      }
    }
  }).pipe(Effect.mapError(() => fail("unlock")));
  const checkBinding = (credential: LocalServiceCredential) => {
    if (
      credential.baseDir !== baseDir ||
      credential.environmentId !== input.environmentId ||
      !Number.isFinite(Date.parse(credential.expiresAt))
    ) {
      return Effect.fail(fail("verify the profile binding of"));
    }
    return Effect.succeed(credential);
  };
  const read = Effect.gen(function* () {
    const bytes = yield* fs.readFile(filePath).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<Uint8Array>())
          : Effect.fail(fail("read")),
      ),
    );
    if (Option.isNone(bytes)) return Option.none<LocalServiceCredential>();
    yield* requireProtection;
    const plaintext = yield* safeStorage
      .decryptString(bytes.value)
      .pipe(Effect.mapError(() => fail("decrypt")));
    const credential = yield* decode(plaintext).pipe(
      Effect.mapError(() => fail("decode")),
      Effect.flatMap(checkBinding),
    );
    return Option.some(credential);
  });
  const save = Effect.fn("desktop.localServiceCredential.save")(function* (
    credential: LocalServiceCredential,
  ) {
    yield* checkBinding(credential);
    // Read and validate an existing encrypted record before replacing it. A
    // denied keychain or a different profile must never become implicit reset.
    yield* read;
    yield* requireProtection;
    const plaintext = yield* encode(credential).pipe(Effect.mapError(() => fail("encode")));
    const encrypted = yield* safeStorage
      .encryptString(plaintext)
      .pipe(Effect.mapError(() => fail("encrypt")));
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* fs.makeDirectory(directory, { recursive: true });
        if (platform !== "win32") yield* fs.chmod(directory, 0o700);
        const temporary = yield* fs.makeTempFileScoped({ directory, prefix: ".session-" });
        if (platform !== "win32") yield* fs.chmod(temporary, 0o600);
        yield* fs.writeFile(temporary, encrypted);
        yield* (yield* fs.open(temporary, { flag: "r" })).sync;
        yield* fs.rename(temporary, filePath);
        if (platform !== "win32") yield* (yield* fs.open(directory, { flag: "r" })).sync;
      }),
    ).pipe(Effect.mapError(() => fail("save")));
  });
  // The caller must revoke the server session first. A stale sign-out must not
  // remove a newer credential saved through this store in the meantime.
  const remove = Effect.fn("desktop.localServiceCredential.remove")(function* (sessionId: string) {
    const saved = yield* read;
    if (Option.isNone(saved)) return false;
    if (saved.value.sessionId !== sessionId) return yield* fail("remove a replaced session from");
    yield* fs.remove(filePath).pipe(Effect.mapError(() => fail("remove")));
    return true;
  });
  return {
    filePath,
    // Check the keychain before minting a new durable server session.
    requireProtection,
    get: lock.withPermit(read),
    save: (credential: LocalServiceCredential) => lock.withPermit(save(credential)),
    remove: (sessionId: string) => lock.withPermit(remove(sessionId)),
  };
});
