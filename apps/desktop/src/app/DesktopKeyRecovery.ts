import * as Clock from "effect/Clock";
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
  retiredPartitions: Schema.optionalKey(Schema.Array(Schema.String)),
  catalogReset: Schema.optionalKey(Schema.Boolean),
  clerkRetired: Schema.optionalKey(Schema.Boolean),
  ctoxRetired: Schema.optionalKey(Schema.Boolean),
  managedRepairStarted: Schema.optionalKey(Schema.Boolean),
  managedRepairVersion: Schema.optionalKey(Schema.Literals([2, 3])),
  attempt: Schema.optionalKey(Schema.Int),
  nextAt: Schema.optionalKey(Schema.Number),
  repairTargets: Schema.optionalKey(Schema.Array(Schema.String)),
  deviceRecoveryGeneration: Schema.optionalKey(Schema.String),
  discoveryRetry: Schema.optionalKey(Schema.Boolean),
  manualRetryAt: Schema.optionalKey(Schema.Number),
  lastRepairLoginId: Schema.optionalKey(Schema.String),
  instanceRepairs: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        instanceId: Schema.String,
        state: Schema.Literals([
          "repairing",
          "repaired",
          "repair_failed",
          "login_required",
          "retryable",
        ]),
        failureClass: Schema.optionalKey(
          Schema.Literals(["repair_failed", "login_required", "retryable"]),
        ),
        operation: Schema.optionalKey(Schema.String),
        httpStatus: Schema.optionalKey(Schema.Int),
      }),
    ),
  ),
});
type RecoveryRecord = typeof RecoveryRecord.Type;
export interface RepairFailure {
  readonly failureClass: "repair_failed" | "login_required" | "retryable";
  readonly operation: string;
  readonly httpStatus?: number;
}
const retryDelay = (attempt: number) =>
  [1, 2, 5, 15, 30, 60][Math.min(Math.max(attempt - 1, 0), 5)]! * 60_000;
/** An explicit reconnect may skip the backoff, but at most once per minute. */
const MANUAL_RETRY_INTERVAL_MS = 60_000;
const RecordJson = Schema.fromJsonString(RecoveryRecord);
const CatalogEnvelope = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    encryptedCatalog: Schema.String,
  }),
);
const SecretEnvelope = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    records: Schema.Array(Schema.Struct({ id: Schema.String, ciphertext: Schema.String })),
    deviceKeys: Schema.optionalKey(
      Schema.Array(Schema.Struct({ id: Schema.String, ciphertext: Schema.String })),
    ),
  }),
);
const ProtectedJson = Schema.fromJsonString(Schema.Struct({ version: Schema.Literals([1, 2]) }));
const ProtectedDeviceKeyJson = Schema.fromJsonString(
  Schema.Struct({
    scope: Schema.Struct({ instanceId: Schema.String, userId: Schema.String }),
    pkcs8: Schema.String,
  }),
);
const encodeRecord = Schema.encodeEffect(RecordJson);
const decodeRecord = Schema.decodeUnknownEffect(RecordJson);
const decodeCatalogEnvelope = Schema.decodeUnknownEffect(CatalogEnvelope);
const decodeSecretEnvelope = Schema.decodeUnknownEffect(SecretEnvelope);

export class DesktopKeyRecoveryError extends Schema.TaggedErrorClass<DesktopKeyRecoveryError>()(
  "DesktopKeyRecoveryError",
  { operation: Schema.String },
) {}
const isRecoveryError = Schema.is(DesktopKeyRecoveryError);

export class DesktopKeyRecovery extends Context.Service<
  DesktopKeyRecovery,
  {
    readonly inspect: Effect.Effect<RecoveryRecord | undefined, DesktopKeyRecoveryError>;
    readonly completeLogin: Effect.Effect<void, DesktopKeyRecoveryError>;
    readonly retirePartition?: (partition: string) => Effect.Effect<void, DesktopKeyRecoveryError>;
    readonly markCatalogReset?: Effect.Effect<void, DesktopKeyRecoveryError>;
    readonly beginManagedRepair?: (
      instanceIds: readonly string[],
      generation?: string,
    ) => Effect.Effect<boolean, DesktopKeyRecoveryError>;
    readonly restartManagedRepairAfterLogin?: (
      loginId: string,
    ) => Effect.Effect<boolean, DesktopKeyRecoveryError>;
    readonly prepareManagedRetry?: (
      instanceId?: string,
    ) => Effect.Effect<boolean, DesktopKeyRecoveryError>;
    readonly claimDeviceRecovery?: Effect.Effect<boolean, DesktopKeyRecoveryError>;
    readonly noteManagedLaunchFailure?: (
      instanceId: string,
      failure: RepairFailure,
    ) => Effect.Effect<void, DesktopKeyRecoveryError>;
    readonly deferManagedDiscovery?: (
      generation: string,
      loginRequired: boolean,
    ) => Effect.Effect<void, DesktopKeyRecoveryError>;
    readonly recordInstanceRepair?: (
      instanceId: string,
      state: "repaired" | "repair_failed" | "login_required" | "retryable",
      generation?: string,
      failure?: RepairFailure,
    ) => Effect.Effect<void, DesktopKeyRecoveryError>;
  }
>()("@workjet/desktop/app/DesktopKeyRecovery") {}

/** CTOX can be repaired independently; broader key loss still requires independent stores. */
export const makeRecovery = Effect.fn("desktop.keyRecovery.make")(function* (input: {
  readonly baseDir: string;
  readonly stateDir: string;
  readonly userDataDir?: string;
  readonly platform?: NodeJS.Platform;
}) {
  const fs = yield* FileSystem.FileSystem;
  const storage = yield* ElectronSafeStorage;
  const lock = yield* Semaphore.make(1);
  const markerPath = `${input.stateDir}/key-recovery.json`;
  const fail = (operation: string) => new DesktopKeyRecoveryError({ operation });
  let initialized = false;
  let record: RecoveryRecord | undefined;
  const persist = (value: RecoveryRecord) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* fs.makeDirectory(input.stateDir, { recursive: true });
        const temporary = yield* fs.makeTempFileScoped({
          directory: input.stateDir,
          prefix: ".key-recovery-",
        });
        yield* fs.writeFileString(temporary, yield* encodeRecord(value));
        yield* (yield* fs.open(temporary, { flag: "r" })).sync;
        yield* fs.rename(temporary, markerPath);
      }),
    ).pipe(Effect.mapError(() => fail("save recovery state")));
  const readOptional = (filePath: string) =>
    fs.readFile(filePath).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed(Option.none<Uint8Array>())
          : Effect.fail(fail("read protected store")),
      ),
    );
  const decodeText = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  const unreadable = <A, I>(bytes: Uint8Array, schema: Schema.Codec<A, I>) =>
    storage.decryptString(bytes).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.as(false),
      Effect.orElseSucceed(() => true),
    );
  const inspect = lock.withPermit(
    Effect.gen(function* () {
      if (initialized) return record;
      // Do not infer key loss while OS protection is denied or insecure.
      if (!(yield* storage.isEncryptionAvailable.pipe(Effect.orElseSucceed(() => false))))
        return undefined;
      const backend = yield* storage.selectedStorageBackend;
      if (
        (Option.isSome(backend) && backend.value === "basic_text") ||
        (input.platform === "linux" && Option.isNone(backend))
      )
        return undefined;
      const previous = yield* readOptional(markerPath);
      if (Option.isSome(previous)) {
        record = yield* decodeRecord(decodeText(previous.value)).pipe(
          Effect.mapError(() => fail("read recovery state")),
        );
        if (record.instanceRepairs?.some((entry) => entry.state === "repairing")) {
          record = {
            ...record,
            instanceRepairs: record.instanceRepairs.map((entry) =>
              entry.state === "repairing"
                ? {
                    ...entry,
                    state: "retryable" as const,
                    failureClass: "retryable" as const,
                    operation: "interrupted",
                  }
                : entry,
            ),
          };
          yield* persist(record);
        }
        if (
          record.managedRepairVersion === undefined &&
          record.managedRepairStarted &&
          record.instanceRepairs !== undefined &&
          record.instanceRepairs.length > 0 &&
          record.instanceRepairs.every((entry) => entry.state === "repair_failed")
        ) {
          record = {
            ...record,
            pendingLogin: true,
            managedRepairVersion: 2,
            instanceRepairs: record.instanceRepairs.map((entry) => ({
              ...entry,
              state: "login_required" as const,
            })),
          };
          yield* persist(record);
        }
      }
      if (
        record?.managedRepairVersion === 2 &&
        record.instanceRepairs?.some(
          (entry) => entry.state === "repair_failed" && entry.failureClass === undefined,
        )
      ) {
        record = {
          ...record,
          managedRepairVersion: 3,
          pendingLogin: record.instanceRepairs.some((entry) => entry.state === "login_required"),
          nextAt: yield* Clock.currentTimeMillis,
          instanceRepairs: record.instanceRepairs.map((entry) =>
            entry.state === "repair_failed" && entry.failureClass === undefined
              ? {
                  ...entry,
                  state: "retryable" as const,
                  failureClass: "retryable" as const,
                  operation: "legacy-unclassified",
                }
              : entry,
          ),
        };
        yield* persist(record);
      }
      const failures: Array<"session" | "catalog" | "ctox"> = [];
      const session = yield* readOptional(`${input.baseDir}/runtime/desktop-auth/session.enc`);
      if (
        Option.isSome(session) &&
        (yield* unreadable(session.value, Schema.fromJsonString(LocalServiceCredential)))
      )
        failures.push("session");
      const catalog = yield* readOptional(`${input.stateDir}/connection-catalog.json`);
      if (Option.isSome(catalog)) {
        const envelope = yield* decodeCatalogEnvelope(decodeText(catalog.value)).pipe(
          Effect.option,
        );
        if (Option.isSome(envelope)) {
          const bytes = Encoding.decodeBase64(envelope.value.encryptedCatalog);
          if (
            bytes._tag === "Success" &&
            (yield* unreadable(bytes.success, Schema.fromJsonString(ConnectionCatalogDocument)))
          )
            failures.push("catalog");
        }
      }
      const secrets = yield* readOptional(`${input.stateDir}/ctox/secrets.json`);
      if (Option.isSome(secrets)) {
        const envelope = yield* decodeSecretEnvelope(decodeText(secrets.value)).pipe(Effect.option);
        if (Option.isSome(envelope)) {
          let failed = false;
          for (const entry of envelope.value.records) {
            const bytes = Encoding.decodeBase64(entry.ciphertext);
            if (bytes._tag === "Failure" || (yield* unreadable(bytes.success, ProtectedJson))) {
              failed = true;
              break;
            }
          }
          if (!failed)
            for (const entry of envelope.value.deviceKeys ?? []) {
              const bytes = Encoding.decodeBase64(entry.ciphertext);
              if (
                bytes._tag === "Failure" ||
                (yield* unreadable(bytes.success, ProtectedDeviceKeyJson))
              ) {
                failed = true;
                break;
              }
            }
          if (failed) failures.push("ctox");
        } else failures.push("ctox");
      }
      if (
        (failures.length >= 2 || failures.includes("ctox")) &&
        (record === undefined || (record.ctoxRetired === true && failures.includes("ctox")))
      ) {
        record = {
          version: 1,
          generation: `${yield* Clock.currentTimeMillis}-${NodeCrypto.randomUUID()}`,
          pendingLogin: true,
          unreadableStores: failures,
        };
        yield* persist(record);
        yield* Effect.logWarning("Workjet detected loss of its local encryption key.", {
          unreadableStores: failures,
        });
      }
      if (record?.unreadableStores.includes("ctox") && !record.ctoxRetired) {
        const original = `${input.stateDir}/ctox/secrets.json`;
        const backup = `${original}.recovery-${record.generation}.bak`;
        // Persist the generation before retiring anything, so interrupted startup resumes it.
        if (!(yield* fs.exists(backup)) && (yield* fs.exists(original)))
          yield* fs.rename(original, backup);
        const bindings = `${input.stateDir}/ctox/instances.json`;
        const bindingsBackup = `${bindings}.recovery-${record.generation}.bak`;
        // Keep public IDs in place: manual pairings must remain visible and replaceable.
        if (!(yield* fs.exists(bindingsBackup)) && (yield* fs.exists(bindings)))
          yield* fs.copyFile(bindings, bindingsBackup);
        const updated = { ...record, ctoxRetired: true };
        yield* persist(updated);
        record = updated;
      }
      if (
        record !== undefined &&
        !record.clerkRetired &&
        record.unreadableStores.some((store) => store !== "ctox")
      ) {
        const original = `${input.stateDir}/clerk-tokens.json`;
        const retired = `${original}.recovery-${record.generation}.bak`;
        if (!(yield* fs.exists(retired)) && (yield* fs.exists(original)))
          yield* fs
            .rename(original, retired)
            .pipe(Effect.mapError(() => fail("retire protected sign-in tokens")));
        const updated = { ...record, clerkRetired: true };
        yield* persist(updated);
        record = updated;
      }
      initialized = true;
      return record;
    }).pipe(
      Effect.mapError((error) => (isRecoveryError(error) ? error : fail("inspect key recovery"))),
    ),
  );
  return DesktopKeyRecovery.of({
    inspect,
    beginManagedRepair: (instanceIds, generation) =>
      Effect.andThen(
        inspect,
        lock.withPermit(
          Effect.gen(function* () {
            if (
              record === undefined ||
              record.managedRepairStarted ||
              (generation !== undefined && record.generation !== generation)
            )
              return false;
            const updated = {
              ...record,
              pendingLogin: (record.instanceRepairs ?? []).some(
                (entry) =>
                  entry.state === "login_required" && !instanceIds.includes(entry.instanceId),
              ),
              managedRepairStarted: true,
              managedRepairVersion: 3 as const,
              attempt: (record.attempt ?? 0) + 1,
              nextAt: (yield* Clock.currentTimeMillis) + retryDelay((record.attempt ?? 0) + 1),
              instanceRepairs: [
                ...(record.instanceRepairs ?? []).filter(
                  (entry) => !instanceIds.includes(entry.instanceId),
                ),
                ...instanceIds.map((instanceId) => ({
                  instanceId,
                  state: "repairing" as const,
                })),
              ],
            };
            yield* persist(updated);
            record = updated;
            return true;
          }),
        ),
      ),
    restartManagedRepairAfterLogin: (loginId) =>
      Effect.andThen(
        inspect,
        lock.withPermit(
          Effect.gen(function* () {
            if (record === undefined || record.lastRepairLoginId === loginId) return false;
            if (
              !record.instanceRepairs?.some((entry) =>
                ["repair_failed", "login_required", "retryable"].includes(entry.state),
              ) &&
              !(record.pendingLogin && record.managedRepairStarted)
            ) {
              const updated = { ...record, lastRepairLoginId: loginId };
              yield* persist(updated);
              record = updated;
              return false;
            }
            const updated = {
              ...record,
              generation: `${yield* Clock.currentTimeMillis}-${NodeCrypto.randomUUID()}`,
              pendingLogin: true,
              managedRepairStarted: false,
              managedRepairVersion: 3 as const,
              attempt: 0,
              repairTargets:
                record.instanceRepairs
                  ?.filter((entry) => entry.state !== "repaired")
                  .map((entry) => entry.instanceId) ?? [],
              lastRepairLoginId: loginId,
            };
            if (updated.repairTargets.length === 0)
              delete (updated as { repairTargets?: string[] }).repairTargets;
            yield* persist(updated);
            record = updated;
            return true;
          }),
        ),
      ),
    noteManagedLaunchFailure: (instanceId, failure) =>
      Effect.andThen(
        inspect,
        lock.withPermit(
          Effect.gen(function* () {
            const existing = record?.instanceRepairs?.find(
              (entry) => entry.instanceId === instanceId,
            );
            // A repair owns its own result; a blocked launch must not move its durable retry window.
            if (existing !== undefined && existing.state !== "repaired") return;
            const now = yield* Clock.currentTimeMillis;
            const current = record ?? {
              version: 1 as const,
              generation: `${now}-${NodeCrypto.randomUUID()}`,
              pendingLogin: false,
              unreadableStores: [],
            };
            // The window is record-wide: a later launch failure never shortens it.
            const updated = {
              ...current,
              managedRepairStarted: true,
              managedRepairVersion: 3 as const,
              attempt: Math.max(current.attempt ?? 0, 1),
              nextAt: Math.max(current.nextAt ?? 0, now + retryDelay(1)),
              pendingLogin: current.pendingLogin || failure.failureClass === "login_required",
              instanceRepairs: [
                ...(current.instanceRepairs ?? []).filter(
                  (entry) => entry.instanceId !== instanceId,
                ),
                { instanceId, state: failure.failureClass, ...failure },
              ],
            };
            yield* persist(updated);
            record = updated;
          }),
        ),
      ),
    deferManagedDiscovery: (generation, loginRequired) =>
      Effect.andThen(
        inspect,
        lock.withPermit(
          Effect.gen(function* () {
            if (
              record === undefined ||
              record.generation !== generation ||
              record.managedRepairStarted
            )
              return;
            const attempt = (record.attempt ?? 0) + 1;
            const updated = {
              ...record,
              managedRepairStarted: true,
              discoveryRetry: !loginRequired,
              pendingLogin: loginRequired,
              attempt,
              nextAt: (yield* Clock.currentTimeMillis) + retryDelay(attempt),
              instanceRepairs: (record.instanceRepairs ?? []).map((entry) =>
                ["retryable", "login_required"].includes(entry.state)
                  ? {
                      ...entry,
                      state: loginRequired ? ("login_required" as const) : ("retryable" as const),
                      failureClass: loginRequired
                        ? ("login_required" as const)
                        : ("retryable" as const),
                      operation: "discovery",
                    }
                  : entry,
              ),
            };
            yield* persist(updated);
            record = updated;
          }),
        ),
      ),
    prepareManagedRetry: (instanceId) =>
      Effect.andThen(
        inspect,
        lock.withPermit(
          Effect.gen(function* () {
            if (
              record === undefined ||
              record.instanceRepairs?.some((entry) => entry.state === "repairing")
            )
              return false;
            const now = yield* Clock.currentTimeMillis;
            const targets =
              record.instanceRepairs
                ?.filter((entry) =>
                  instanceId === undefined
                    ? entry.state === "retryable" && now >= (record!.nextAt ?? 0)
                    : entry.instanceId === instanceId &&
                      ["repair_failed", "retryable"].includes(entry.state),
                )
                .map((entry) => entry.instanceId) ?? [];
            if (
              (targets.length === 0 &&
                !(
                  instanceId === undefined &&
                  record.discoveryRetry &&
                  now >= (record.nextAt ?? 0)
                )) ||
              !record.managedRepairStarted ||
              (instanceId !== undefined &&
                record.manualRetryAt !== undefined &&
                now - record.manualRetryAt < MANUAL_RETRY_INTERVAL_MS)
            )
              return false;
            const updated = {
              ...record,
              generation: `${now}-${NodeCrypto.randomUUID()}`,
              managedRepairStarted: false,
              managedRepairVersion: 3 as const,
              discoveryRetry: false,
              ...(targets.length > 0 ? { repairTargets: targets } : {}),
              ...(instanceId === undefined ? {} : { manualRetryAt: now }),
              pendingLogin:
                record.instanceRepairs?.some(
                  (entry) =>
                    entry.state === "login_required" && !targets.includes(entry.instanceId),
                ) ?? false,
            };
            yield* persist(updated);
            record = updated;
            return true;
          }),
        ),
      ),
    claimDeviceRecovery: Effect.andThen(
      inspect,
      lock.withPermit(
        Effect.gen(function* () {
          if (record === undefined) return true;
          if (record.deviceRecoveryGeneration === record.generation) return false;
          const updated = { ...record, deviceRecoveryGeneration: record.generation };
          yield* persist(updated);
          record = updated;
          return true;
        }),
      ),
    ),
    recordInstanceRepair: (instanceId, state, generation, failure) =>
      Effect.andThen(
        inspect,
        lock.withPermit(
          Effect.gen(function* () {
            if (
              record === undefined ||
              !record.managedRepairStarted ||
              (generation !== undefined && record.generation !== generation)
            )
              return;
            const updated = {
              ...record,
              pendingLogin: record.pendingLogin || state === "login_required",
              instanceRepairs: (record.instanceRepairs ?? []).map((entry) =>
                entry.instanceId === instanceId ? { instanceId, state, ...failure } : entry,
              ),
            };
            yield* persist(updated);
            record = updated;
          }),
        ),
      ),
    markCatalogReset: Effect.andThen(
      inspect,
      lock.withPermit(
        Effect.gen(function* () {
          if (record === undefined || record.catalogReset) return;
          const updated = { ...record, catalogReset: true };
          yield* persist(updated);
          record = updated;
        }),
      ),
    ),
    retirePartition: (partition) =>
      Effect.andThen(
        inspect,
        lock
          .withPermit(
            Effect.gen(function* () {
              if (record === undefined || input.userDataDir === undefined) return;
              if (
                partition === "persist:workjet-ctox-control-plane" &&
                record.unreadableStores.every((store) => store === "ctox")
              )
                return;
              if (!/^persist:workjet-ctox-[a-zA-Z0-9_-]+$/.test(partition))
                return yield* fail("validate recovery partition");
              if (record.retiredPartitions?.includes(partition)) return;
              const original = `${input.userDataDir}/Partitions/${partition.slice("persist:".length).toLowerCase()}`;
              const retired = `${original}.recovery-${record.generation}`;
              if (!(yield* fs.exists(retired)) && (yield* fs.exists(original)))
                yield* fs.rename(original, retired);
              const updated = {
                ...record,
                retiredPartitions: [...(record.retiredPartitions ?? []), partition],
              };
              yield* persist(updated);
              record = updated;
            }),
          )
          .pipe(Effect.mapError(() => fail("retire protected browser partition"))),
      ),
    completeLogin: Effect.andThen(
      inspect,
      lock.withPermit(
        Effect.gen(function* () {
          if (
            record === undefined ||
            !record.pendingLogin ||
            record.instanceRepairs?.some((entry) => entry.state === "login_required")
          )
            return;
          const completed = { ...record, pendingLogin: false };
          yield* persist(completed);
          record = completed;
        }),
      ),
    ),
  });
});

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment;
  return yield* makeRecovery({
    ...environment,
    userDataDir: environment.path.join(environment.appDataDirectory, environment.userDataDirName),
  });
});
export const layer = Layer.effect(DesktopKeyRecovery, make);

/** Optional for isolated service tests; the desktop composition always provides the one owner. */
export const currentRecovery = Effect.gen(function* () {
  const recovery = yield* Effect.serviceOption(DesktopKeyRecovery);
  return Option.isSome(recovery) ? yield* recovery.value.inspect : undefined;
});
