import { ConnectionCatalogDocument } from "@workjet/client-runtime/platform";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as NodeCrypto from "node:crypto";
import { LocalServiceCredential } from "../backend/DesktopLocalServiceCredential.ts";
import { ElectronSafeStorage } from "../electron/ElectronSafeStorage.ts";
import { DesktopEnvironment } from "./DesktopEnvironment.ts";

const RecoveryRecord = Schema.Struct({
  version: Schema.Literal(1),
  generation: Schema.String.check(Schema.isPattern(/^[0-9]+-[a-f0-9-]{36}$/)),
  pendingLogin: Schema.Boolean,
  unreadableStores: Schema.Array(Schema.Literals(["session", "catalog", "ctox"])),
});
type RecoveryRecord = typeof RecoveryRecord.Type;
const RecordJson = Schema.fromJsonString(RecoveryRecord);
const CatalogEnvelope = Schema.fromJsonString(Schema.Struct({
  version: Schema.Literal(1), encryptedCatalog: Schema.String,
}));
const SecretEnvelope = Schema.fromJsonString(Schema.Struct({
  version: Schema.Literal(1),
  records: Schema.Array(Schema.Struct({ id: Schema.String, ciphertext: Schema.String })),
  deviceKeys: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String, ciphertext: Schema.String }))),
}));
const ProtectedJson = Schema.fromJsonString(Schema.Struct({ version: Schema.Literals([1, 2]) }));

export class DesktopKeyRecoveryError extends Schema.TaggedErrorClass<DesktopKeyRecoveryError>()(
  "DesktopKeyRecoveryError", { operation: Schema.String },
) {}

export class DesktopKeyRecovery extends Context.Service<DesktopKeyRecovery, {
  readonly inspect: Effect.Effect<RecoveryRecord | undefined, DesktopKeyRecoveryError>;
  readonly completeLogin: Effect.Effect<void, DesktopKeyRecoveryError>;
}>()("@workjet/desktop/app/DesktopKeyRecovery") {}

/** Only independent protected stores count. A locked keychain or one damaged file cannot authorize reset. */
export const makeRecovery = Effect.fn("desktop.keyRecovery.make")(function* (input: {
  readonly baseDir: string;
  readonly stateDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const storage = yield* ElectronSafeStorage;
  const lock = yield* Semaphore.make(1);
  const markerPath = `${input.stateDir}/key-recovery.json`;
  const fail = (operation: string) => new DesktopKeyRecoveryError({ operation });
  let initialized = false;
  let record: RecoveryRecord | undefined;
  const persist = (value: RecoveryRecord) => Effect.scoped(Effect.gen(function* () {
    yield* fs.makeDirectory(input.stateDir, { recursive: true });
    const temporary = yield* fs.makeTempFileScoped({ directory: input.stateDir, prefix: ".key-recovery-" });
    yield* fs.writeFileString(temporary, yield* Schema.encodeEffect(RecordJson)(value));
    yield* (yield* fs.open(temporary, { flag: "r" })).sync;
    yield* fs.rename(temporary, markerPath);
  })).pipe(Effect.mapError(() => fail("save recovery state")));
  const readOptional = (filePath: string) => fs.readFile(filePath).pipe(
    Effect.map(Option.some),
    Effect.catch((error) => error.reason._tag === "NotFound"
      ? Effect.succeed(Option.none<Uint8Array>()) : Effect.fail(fail("read protected store"))),
  );
  const decodeText = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const unreadable = <A, I>(bytes: Uint8Array, schema: Schema.Codec<A, I>) => storage.decryptString(bytes).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.as(false), Effect.orElseSucceed(() => true),
  );
  const inspect = lock.withPermit(Effect.gen(function* () {
    if (initialized) return record;
    // Do not infer key loss while OS protection is denied or insecure.
    if (!(yield* storage.isEncryptionAvailable.pipe(Effect.orElseSucceed(() => false)))) return undefined;
    const backend = yield* storage.selectedStorageBackend;
    if (Option.isSome(backend) && backend.value === "basic_text") return undefined;
    const previous = yield* readOptional(markerPath);
    if (Option.isSome(previous)) {
      record = yield* Schema.decodeUnknownEffect(RecordJson)(decodeText(previous.value)).pipe(
        Effect.mapError(() => fail("read recovery state")),
      );
    }
    const failures: Array<"session" | "catalog" | "ctox"> = [];
    const session = yield* readOptional(`${input.baseDir}/runtime/desktop-auth/session.enc`);
    if (Option.isSome(session) && (yield* unreadable(session.value, Schema.fromJsonString(LocalServiceCredential)))) failures.push("session");
    const catalog = yield* readOptional(`${input.stateDir}/connection-catalog.json`);
    if (Option.isSome(catalog)) {
      const envelope = yield* Schema.decodeUnknownEffect(CatalogEnvelope)(decodeText(catalog.value)).pipe(Effect.option);
      if (Option.isSome(envelope)) {
        const bytes = Encoding.decodeBase64(envelope.value.encryptedCatalog);
        if (bytes._tag === "Success" && (yield* unreadable(bytes.success, Schema.fromJsonString(ConnectionCatalogDocument)))) failures.push("catalog");
      }
    }
    const secrets = yield* readOptional(`${input.stateDir}/ctox/secrets.json`);
    if (Option.isSome(secrets)) {
      const envelope = yield* Schema.decodeUnknownEffect(SecretEnvelope)(decodeText(secrets.value)).pipe(Effect.option);
      if (Option.isSome(envelope)) {
        for (const entry of [...envelope.value.records, ...(envelope.value.deviceKeys ?? [])]) {
          const bytes = Encoding.decodeBase64(entry.ciphertext);
          if (bytes._tag === "Success" && (yield* unreadable(bytes.success, ProtectedJson))) {
            failures.push("ctox"); break;
          }
        }
      }
    }
    if (failures.length >= 2) {
      record = { version: 1, generation: `${Date.now()}-${NodeCrypto.randomUUID()}`, pendingLogin: true, unreadableStores: failures };
      yield* persist(record);
      yield* Effect.logWarning("Workjet detected loss of its local encryption key.", { unreadableStores: failures });
    }
    initialized = true;
    return record;
  }));
  return DesktopKeyRecovery.of({
    inspect,
    completeLogin: Effect.andThen(inspect, lock.withPermit(Effect.gen(function* () {
      if (record === undefined || !record.pendingLogin) return;
      const completed = { ...record, pendingLogin: false };
      yield* persist(completed);
      record = completed;
    }))),
  });
});

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment;
  return yield* makeRecovery(environment);
});
export const layer = Layer.effect(DesktopKeyRecovery, make);

/** Optional for isolated service tests; the desktop composition always provides the one owner. */
export const currentRecovery = Effect.gen(function* () {
  const recovery = yield* Effect.serviceOption(DesktopKeyRecovery);
  return Option.isSome(recovery) ? yield* recovery.value.inspect : undefined;
});
