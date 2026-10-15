// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off -- Hash protected mapping keys; compare private native observations.
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import { EnvironmentId, WorkjetComputerId, WorkjetConnectionId } from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ServerSecretStore, isSecretAlreadyExistsError } from "../auth/ServerSecretStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { DecisionHubConnectionRegistry } from "./decisionHub/DecisionHubConnectionRegistry.ts";

const NativeId = Schema.String.check(Schema.isPattern(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u));
const AbsoluteNativePath = Schema.String.check(Schema.isPattern(/^\/[^\p{Cc}\p{Zl}\p{Zp}]*$/u));
const Epoch = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** These are separate managed inputs. A UI instance ID or remote daemon root
 * cannot stand in for the canonical instance or original source enrollment root. */
export const NativeSupervisorSourceSelection = Schema.Struct({
  environmentId: EnvironmentId,
  computerId: WorkjetComputerId,
  connectionId: WorkjetConnectionId,
  instanceId: NativeId,
  nativeInstanceId: NativeId,
});
export type NativeSupervisorSourceSelection = typeof NativeSupervisorSourceSelection.Type;

export const NativeSupervisorManagedRuntime = Schema.Struct({
  ctoxExecutable: AbsoluteNativePath,
  nativeRoot: AbsoluteNativePath,
});
export type NativeSupervisorManagedRuntime = typeof NativeSupervisorManagedRuntime.Type;

const NativeConsumerIdentity = Schema.Struct({
  ownerUserId: NativeId,
  actorUserId: NativeId,
  actorEpoch: Epoch,
  computerId: NativeId,
  pairingId: NativeId,
  deviceId: NativeId,
  proofKeyThumbprint: NativeId,
});

const NativeEnrollmentIdentity = Schema.Struct({
  targetId: NativeId,
  instanceId: NativeId,
  publicIdentity: NativeId,
  accountEpoch: Epoch,
  consumer: NativeConsumerIdentity,
});

const NativeSourceFacts = Schema.Struct({
  version: Schema.Literal(1),
  ...NativeEnrollmentIdentity.fields,
  peerId: NativeId,
  generation: Epoch,
  consumer: Schema.Struct({
    ...NativeConsumerIdentity.fields,
    computerRevision: NativeId,
    pairingRevision: NativeId,
  }),
});

/** Decode only the published non-secret native startup contract. */
export const NativeSupervisorSourceStartup = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  transportReady: Schema.Literal(true),
  executionReady: Schema.Literal(false),
  source: NativeSourceFacts,
});
export type NativeSupervisorSourceStartup = typeof NativeSupervisorSourceStartup.Type;

const StoredEnrollment = Schema.Struct({
  version: Schema.Literal(1),
  selection: NativeSupervisorSourceSelection,
  runtime: NativeSupervisorManagedRuntime,
  identity: NativeEnrollmentIdentity,
});
const StoredJson = Schema.fromJsonString(StoredEnrollment);
const encode = Schema.encodeEffect(StoredJson);
const decode = Schema.decodeUnknownEffect(StoredJson);
const decodeSelection = Schema.decodeUnknownEffect(NativeSupervisorSourceSelection);
const decodeRuntime = Schema.decodeUnknownEffect(NativeSupervisorManagedRuntime);
const decodeStartup = Schema.decodeUnknownEffect(NativeSupervisorSourceStartup);
const decodeIdentity = Schema.decodeUnknownEffect(NativeEnrollmentIdentity);
const decodeAbsolutePath = Schema.decodeUnknownEffect(AbsoluteNativePath);
const encodeKey = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      environmentId: EnvironmentId,
      computerId: WorkjetComputerId,
      connectionId: WorkjetConnectionId,
    }),
  ),
);

export class NativeSupervisorSourceEnrollmentError extends Schema.TaggedErrorClass<NativeSupervisorSourceEnrollmentError>()(
  "NativeSupervisorSourceEnrollmentError",
  {
    reason: Schema.Literals([
      "runtime-unconfigured",
      "selection-unavailable",
      "runtime-conflict",
      "source-mismatch",
      "stored-mapping-invalid",
      "mapping-store-unavailable",
    ]),
  },
) {}

const failure = (reason: NativeSupervisorSourceEnrollmentError["reason"]) =>
  new NativeSupervisorSourceEnrollmentError({ reason });
const mappingKey = (selection: NativeSupervisorSourceSelection) =>
  `native-supervisor-enrollment-${NodeCrypto.createHash("sha256")
    .update(encodeKey(selection))
    .digest("hex")}`;

/** Source-service-only plan. No endpoint, credential or execution authority is
 * persisted here; the managed consumer owns and fences the actual child. */
export interface NativeSupervisorSourcePlan {
  readonly selection: NativeSupervisorSourceSelection;
  readonly runtime: NativeSupervisorManagedRuntime;
}

export const nativeSupervisorSourceArguments = (
  plan: NativeSupervisorSourcePlan,
  privateIpcDirectory: string,
): Effect.Effect<ReadonlyArray<string>, NativeSupervisorSourceEnrollmentError> =>
  decodeAbsolutePath(privateIpcDirectory).pipe(
    Effect.mapError(() => failure("source-mismatch")),
    Effect.map((directory) => [
      "sync",
      "supervisor-source-selected",
      plan.selection.nativeInstanceId,
      plan.selection.computerId,
      directory,
      "--root",
      plan.runtime.nativeRoot,
    ]),
  );

export const makeNativeSupervisorSourceEnrollment = Effect.fn(
  "NativeSupervisorSourceEnrollment.make",
)(function* (dependencies: {
  readonly settings: Pick<ServerSettingsService["Service"], "getSettings">;
  readonly connections: Pick<
    DecisionHubConnectionRegistry["Service"],
    "list" | "resolveReadyTarget"
  >;
  readonly secrets: Pick<ServerSecretStore["Service"], "get" | "create">;
}) {
  const mutex = yield* Semaphore.make(1);
  const plans = new WeakMap<NativeSupervisorSourcePlan, typeof StoredEnrollment.Type | null>();

  const current = Effect.fn("NativeSupervisorSourceEnrollment.current")(function* (
    selection: NativeSupervisorSourceSelection,
  ) {
    const settings = yield* dependencies.settings.getSettings.pipe(
      Effect.mapError(() => failure("selection-unavailable")),
    );
    const computers = settings.workjet.computers.filter(
      (computer) => computer.id === selection.computerId,
    );
    if (computers.length !== 1 || computers[0]?.environmentId !== selection.environmentId)
      return yield* failure("selection-unavailable");
    const connections = yield* dependencies.connections.list.pipe(
      Effect.mapError(() => failure("selection-unavailable")),
    );
    const matches = connections.filter(
      (connection) => connection.connectionId === selection.connectionId,
    );
    if (
      matches.length !== 1 ||
      matches[0]?.instanceId !== selection.instanceId ||
      matches[0]?.status !== "ready"
    )
      return yield* failure("selection-unavailable");
    yield* dependencies.connections
      .resolveReadyTarget(selection.connectionId, selection.instanceId)
      .pipe(Effect.mapError(() => failure("selection-unavailable")));
  });

  const read = Effect.fn("NativeSupervisorSourceEnrollment.read")(function* (
    selection: NativeSupervisorSourceSelection,
  ) {
    const bytes = yield* dependencies.secrets
      .get(mappingKey(selection))
      .pipe(Effect.mapError(() => failure("mapping-store-unavailable")));
    if (Option.isNone(bytes)) return null;
    const record = yield* decode(new TextDecoder().decode(bytes.value)).pipe(
      Effect.mapError(() => failure("stored-mapping-invalid")),
    );
    if (
      !NodeUtil.isDeepStrictEqual(record.selection, selection) ||
      record.identity.instanceId !== selection.nativeInstanceId ||
      record.identity.consumer.computerId !== selection.computerId
    )
      return yield* failure("stored-mapping-invalid");
    return record;
  });

  const makePlan = (
    selection: NativeSupervisorSourceSelection,
    runtime: NativeSupervisorManagedRuntime,
    retained: typeof StoredEnrollment.Type | null,
  ) => {
    const plan = Object.freeze({
      selection: Object.freeze(selection),
      runtime: Object.freeze(runtime),
    });
    plans.set(plan, retained);
    return plan;
  };

  const prepare = Effect.fn("NativeSupervisorSourceEnrollment.prepare")(function* (
    selectionInput: NativeSupervisorSourceSelection,
    runtimeInput: NativeSupervisorManagedRuntime,
  ) {
    const selection = yield* decodeSelection(selectionInput).pipe(
      Effect.mapError(() => failure("selection-unavailable")),
    );
    const runtime = yield* decodeRuntime(runtimeInput).pipe(
      Effect.mapError(() => failure("runtime-unconfigured")),
    );
    yield* current(selection);
    const retained = yield* read(selection);
    if (retained !== null && !NodeUtil.isDeepStrictEqual(retained.runtime, runtime))
      return yield* failure("runtime-conflict");
    return makePlan(selection, runtime, retained);
  });

  const resolve = Effect.fn("NativeSupervisorSourceEnrollment.resolve")(function* (
    selectionInput: NativeSupervisorSourceSelection,
  ) {
    const selection = yield* decodeSelection(selectionInput).pipe(
      Effect.mapError(() => failure("selection-unavailable")),
    );
    yield* current(selection);
    const retained = yield* read(selection);
    if (retained === null) return yield* failure("runtime-unconfigured");
    return makePlan(selection, retained.runtime, retained);
  });

  const retainStarted = Effect.fn("NativeSupervisorSourceEnrollment.retainStarted")(function* (
    plan: NativeSupervisorSourcePlan,
    startupInput: unknown,
  ) {
    if (!plans.has(plan)) return yield* failure("source-mismatch");
    const startup = yield* decodeStartup(startupInput).pipe(
      Effect.mapError(() => failure("source-mismatch")),
    );
    if (
      startup.source.instanceId !== plan.selection.nativeInstanceId ||
      startup.source.consumer.computerId !== plan.selection.computerId
    )
      return yield* failure("source-mismatch");
    // Strip ephemeral generation, revisions and any unknown stdout fields.
    // Only the original enrollment identity survives a managed service restart.
    const identity = yield* decodeIdentity(startup.source).pipe(
      Effect.mapError(() => failure("source-mismatch")),
    );
    const record = {
      version: 1 as const,
      selection: plan.selection,
      runtime: plan.runtime,
      identity,
    };
    const original = plans.get(plan);
    if (original && !NodeUtil.isDeepStrictEqual(original, record))
      return yield* failure("source-mismatch");
    yield* current(plan.selection);
    const saved = yield* read(plan.selection);
    if (saved !== null && !NodeUtil.isDeepStrictEqual(saved, record))
      return yield* failure("source-mismatch");
    if (saved === null) {
      const json = yield* encode(record).pipe(
        Effect.mapError(() => failure("stored-mapping-invalid")),
      );
      yield* dependencies.secrets
        .create(mappingKey(plan.selection), new TextEncoder().encode(json))
        .pipe(
          Effect.catch((error) =>
            isSecretAlreadyExistsError(error)
              ? Effect.void
              : Effect.fail(failure("mapping-store-unavailable")),
          ),
        );
    }
    const committed = yield* read(plan.selection);
    if (!NodeUtil.isDeepStrictEqual(committed, record)) return yield* failure("source-mismatch");
    // Registry changes during native startup or durable creation must fail closed.
    yield* current(plan.selection);
    plans.set(plan, record);
    return startup;
  });

  return {
    prepare: (
      selection: NativeSupervisorSourceSelection,
      runtime: NativeSupervisorManagedRuntime,
    ) => prepare(selection, runtime).pipe(mutex.withPermits(1)),
    resolve: (selection: NativeSupervisorSourceSelection) =>
      resolve(selection).pipe(mutex.withPermits(1)),
    retainStarted: (plan: NativeSupervisorSourcePlan, startup: unknown) =>
      retainStarted(plan, startup).pipe(mutex.withPermits(1)),
  };
});

export class NativeSupervisorSourceEnrollment extends Context.Service<
  NativeSupervisorSourceEnrollment,
  Effect.Success<ReturnType<typeof makeNativeSupervisorSourceEnrollment>>
>()("workjet/workjet/NativeSupervisorSourceEnrollment") {}

export const layer = Layer.effect(
  NativeSupervisorSourceEnrollment,
  Effect.gen(function* () {
    return yield* makeNativeSupervisorSourceEnrollment({
      settings: yield* ServerSettingsService,
      connections: yield* DecisionHubConnectionRegistry,
      secrets: yield* ServerSecretStore,
    });
  }),
);
