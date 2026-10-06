import { AuthSessionId, TrimmedNonEmptyString } from "@workjet/contracts";
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
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

/** Non-secret identities and fingerprints, used only under this store's access lock. */
export interface LocalCredentialRecovery {
  readonly baseDir: string;
  readonly environmentId: string;
  readonly sessionId: string | undefined;
  readonly attemptId: string | undefined;
  readonly fingerprints: ReadonlyArray<readonly [string, string | null]>;
}

export interface LocalServiceCredentialStore {
  readonly filePath: string;
  readonly withAccess: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | LocalServiceCredentialError, R>;
  readonly inspectRecovery: Effect.Effect<LocalCredentialRecovery, LocalServiceCredentialError>;
  readonly retireRecovered: (
    recovery: LocalCredentialRecovery,
  ) => Effect.Effect<void, LocalServiceCredentialError>;
  readonly assertEnrollmentSettled: Effect.Effect<void, LocalServiceCredentialError>;
  readonly beginEnrollment: Effect.Effect<string, LocalServiceCredentialError>;
  readonly finishEnrollment: (
    attemptId: string,
  ) => Effect.Effect<void, LocalServiceCredentialError>;
  readonly requireProtection: Effect.Effect<void, LocalServiceCredentialError>;
  readonly get: Effect.Effect<Option.Option<LocalServiceCredential>, LocalServiceCredentialError>;
  readonly save: (
    credential: LocalServiceCredential,
  ) => Effect.Effect<void, LocalServiceCredentialError>;
  readonly remove: (sessionId: string) => Effect.Effect<void, LocalServiceCredentialError>;
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
  const pendingPath = path.join(directory, "enrollment-pending.json");
  const bindingPath = path.join(directory, "session-binding.json");
  const PendingEnrollment = Schema.Struct({
    version: Schema.Literal(1),
    baseDir: TrimmedNonEmptyString,
    environmentId: TrimmedNonEmptyString,
    attemptId: TrimmedNonEmptyString,
  });
  const SessionBinding = Schema.Struct({
    version: Schema.Literal(1),
    baseDir: TrimmedNonEmptyString,
    environmentId: TrimmedNonEmptyString,
    sessionId: AuthSessionId,
  });
  const lock = yield* Semaphore.make(1);
  const fail = (operation: string) => new LocalServiceCredentialError({ operation });
  // Kernel-backed exclusion for the complete issue/recovery operation. Process
  // death releases ownership; a leftover filename never authorizes a takeover.
  const access = Effect.acquireRelease(
    Effect.gen(function* () {
      const ownershipDir = path.join(baseDir, "runtime", "ownership");
      yield* fs.makeDirectory(ownershipDir, { recursive: true });
      return yield* Effect.try({
        try: () => {
          const database = new NodeSqlite.DatabaseSync(
            path.join(ownershipDir, "desktop-auth.sqlite"),
          );
          try {
            database.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;");
            return database;
          } catch (cause) {
            database.close();
            throw cause;
          }
        },
        catch: () => fail("acquire exclusive access to"),
      });
    }).pipe(Effect.mapError(() => fail("acquire exclusive access to"))),
    (database) => Effect.sync(() => database.close()),
  );
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
    if (Option.isNone(bytes)) {
      const entries = yield* fs
        .readDirectory(directory)
        .pipe(
          Effect.catch((error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeed([] as string[])
              : Effect.fail(fail("read")),
          ),
        );
      if (entries.includes("session.enc") || entries.includes("session-binding.json"))
        return yield* fail("recover retained session identity for");
      return Option.none<LocalServiceCredential>();
    }
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
    const previous = yield* read;
    if (Option.isSome(previous) && previous.value.sessionId !== credential.sessionId)
      return yield* fail("replace an existing session without recovery of");
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
        const binding = yield* Schema.encodeEffect(Schema.fromJsonString(SessionBinding))({
          version: 1,
          baseDir,
          environmentId: input.environmentId,
          sessionId: credential.sessionId,
        });
        const bindingTemporary = yield* fs.makeTempFileScoped({ directory, prefix: ".binding-" });
        if (platform !== "win32") yield* fs.chmod(bindingTemporary, 0o600);
        yield* fs.writeFileString(bindingTemporary, binding);
        yield* (yield* fs.open(bindingTemporary, { flag: "r" })).sync;
        yield* fs.rename(bindingTemporary, bindingPath);
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
    const binding = yield* fs.readFileString(bindingPath).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(fail("remove")),
      ),
      Effect.mapError(() => fail("remove")),
    );
    if (Option.isSome(binding)) {
      const identity = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SessionBinding))(
        binding.value,
      ).pipe(Effect.mapError(() => fail("remove")));
      if (
        identity.sessionId !== sessionId ||
        identity.baseDir !== baseDir ||
        identity.environmentId !== input.environmentId
      )
        return yield* fail("remove a replaced recovery identity from");
    }
    yield* fs.remove(filePath).pipe(Effect.mapError(() => fail("remove")));
    if (Option.isSome(binding))
      yield* fs.remove(bindingPath).pipe(Effect.mapError(() => fail("remove")));
    return true;
  });
  // The non-secret receipt records an UNKNOWN mutation outcome, not liveness.
  // Never age it out: a CLI may have committed before losing its reply.
  const assertEnrollmentSettled: Effect.Effect<void, LocalServiceCredentialError> = Effect.gen(
    function* () {
      if (yield* fs.exists(pendingPath))
        return yield* fail("reconcile an incomplete enrollment for");
    },
  ).pipe(Effect.mapError(() => fail("reconcile an incomplete enrollment for")));
  const beginEnrollment: Effect.Effect<string, LocalServiceCredentialError> = Effect.scoped(
    Effect.gen(function* () {
      yield* assertEnrollmentSettled;
      const attemptId = NodeCrypto.randomUUID();
      const receipt = yield* Schema.encodeEffect(Schema.fromJsonString(PendingEnrollment))({
        version: 1,
        baseDir,
        environmentId: input.environmentId,
        attemptId,
      });
      yield* fs.makeDirectory(directory, { recursive: true });
      if (platform !== "win32") yield* fs.chmod(directory, 0o700);
      // Exclusive creation also excludes another Desktop process. A partial write
      // is retained and blocks enrollment, rather than guessed to be abandoned.
      yield* fs.writeFileString(pendingPath, receipt, { flag: "wx", mode: 0o600 });
      yield* (yield* fs.open(pendingPath, { flag: "r" })).sync;
      if (platform !== "win32") yield* (yield* fs.open(directory, { flag: "r" })).sync;
      if (platform !== "win32")
        yield* (yield* fs.open(path.dirname(directory), { flag: "r" })).sync;
      return attemptId;
    }),
  ).pipe(Effect.mapError(() => fail("record enrollment intent for")));
  const finishEnrollment = (attemptId: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const receipt = yield* fs
          .readFileString(pendingPath)
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PendingEnrollment))),
          );
        if (
          receipt.attemptId !== attemptId ||
          receipt.baseDir !== baseDir ||
          receipt.environmentId !== input.environmentId
        )
          return yield* fail("settle a different enrollment for");
        yield* fs.remove(pendingPath);
        if (platform !== "win32") yield* (yield* fs.open(directory, { flag: "r" })).sync;
      }),
    ).pipe(Effect.mapError(() => fail("settle enrollment for")));
  const recoveryFiles = [filePath, pendingPath, bindingPath];
  const fingerprintFiles = Effect.gen(function* () {
    const entries = (yield* fs.exists(directory)) ? yield* fs.readDirectory(directory) : [];
    return yield* Effect.forEach(recoveryFiles, (location) =>
      fs.readFile(location).pipe(
        Effect.map(
          (bytes) =>
            [location, NodeCrypto.createHash("sha256").update(bytes).digest("hex")] as const,
        ),
        Effect.catch((error) =>
          error.reason._tag === "NotFound" && !entries.includes(path.basename(location))
            ? Effect.succeed([location, null] as const)
            : Effect.fail(fail("inspect recovery files for")),
        ),
      ),
    );
  });
  const inspectRecovery = Effect.gen(function* () {
    const fingerprints = yield* fingerprintFiles;
    const exists = (location: string) =>
      fingerprints.some(([file, digest]) => file === location && digest !== null);
    const binding = exists(bindingPath)
      ? yield* fs
          .readFileString(bindingPath)
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SessionBinding))))
      : undefined;
    const pending = exists(pendingPath)
      ? yield* fs
          .readFileString(pendingPath)
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(PendingEnrollment))),
          )
      : undefined;
    for (const record of [binding, pending]) {
      if (
        record !== undefined &&
        (record.baseDir !== baseDir || record.environmentId !== input.environmentId)
      )
        return yield* fail("verify recovery ownership of");
    }
    const saved =
      !exists(filePath) && binding !== undefined
        ? Option.none<LocalServiceCredential>()
        : yield* read.pipe(
            Effect.catch((error) =>
              binding !== undefined && ["unlock", "decrypt"].includes(error.operation)
                ? Effect.succeed(Option.none<LocalServiceCredential>())
                : Effect.fail(error),
            ),
          );
    if (
      binding !== undefined &&
      Option.isSome(saved) &&
      saved.value.sessionId !== binding.sessionId
    )
      return yield* fail("reconcile conflicting recovery identities for");
    const sessionId =
      binding?.sessionId ?? (Option.isSome(saved) ? saved.value.sessionId : undefined);
    if (sessionId === undefined && pending === undefined)
      return yield* fail("identify a recoverable session for");
    return {
      baseDir,
      environmentId: input.environmentId,
      sessionId,
      attemptId: pending?.attemptId,
      fingerprints,
    } satisfies LocalCredentialRecovery;
  }).pipe(Effect.mapError(() => fail("inspect the recovery identity of")));
  const retireRecovered = (recovery: LocalCredentialRecovery) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (recovery.baseDir !== baseDir || recovery.environmentId !== input.environmentId)
          return yield* fail("retire a different profile's");
        const current = yield* fingerprintFiles;
        if (
          current.length !== recovery.fingerprints.length ||
          current.some(
            ([file, digest], index) =>
              recovery.fingerprints[index]?.[0] !== file ||
              recovery.fingerprints[index]?.[1] !== digest,
          )
        )
          return yield* fail("retire changed recovery files for");
        // Preserve ciphertext and receipts together after confirmed server revocation.
        // Ownership is held outside this directory and survives its atomic move.
        yield* fs.rename(
          directory,
          path.join(baseDir, "runtime", `desktop-auth-retired-${NodeCrypto.randomUUID()}`),
        );
        if (platform !== "win32")
          yield* (yield* fs.open(path.join(baseDir, "runtime"), { flag: "r" })).sync;
      }),
    ).pipe(Effect.mapError(() => fail("retire the recovered files for")));
  const store: LocalServiceCredentialStore = {
    filePath,
    withAccess: (effect) => Effect.scoped(Effect.andThen(access, effect)),
    inspectRecovery: lock.withPermit(inspectRecovery),
    retireRecovered: (recovery) => lock.withPermit(retireRecovered(recovery)),
    assertEnrollmentSettled: lock.withPermit(assertEnrollmentSettled),
    beginEnrollment: lock.withPermit(beginEnrollment),
    finishEnrollment: (attemptId: string) => lock.withPermit(finishEnrollment(attemptId)),
    // Check the keychain before minting a new durable server session.
    requireProtection,
    get: lock.withPermit(read),
    save: (credential: LocalServiceCredential) => lock.withPermit(save(credential)),
    remove: (sessionId: string) => lock.withPermit(remove(sessionId)),
  };
  return store;
});
