// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics nodeBuiltinImport:off -- Opaque secret-store key hashing, no network endpoint selection.
import * as Crypto from "node:crypto";
import {
  RemoteWorkerDispatchError,
  WorkjetComputerId,
  WorkjetConnectionId,
  RemoteWorkerSourceProfile,
  type EnvironmentId,
  type RemoteWorkerComputerEnrollmentInput,
  type RemoteWorkerComputerEnrollmentResult,
  type WorkjetConfiguration,
} from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { RemoteWorkerNativeScope } from "./ctox/CtoxRemoteWorkerAdmission.ts";
import type { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as Option from "effect/Option";
import type { ServerSettingsService } from "../serverSettings.ts";
import type { DecisionHubConnectionRegistry } from "./decisionHub/DecisionHubConnectionRegistry.ts";
import type { makeCtoxRemoteWorkerTargets } from "./ctox/CtoxRemoteWorkerTargets.ts";

export class RemoteWorkerComputerEnrollment extends Context.Service<
  RemoteWorkerComputerEnrollment,
  {
    readonly forgetRevokedProfile: (
      computerId: WorkjetComputerId,
      scope: RemoteWorkerNativeScope,
    ) => Effect.Effect<void, RemoteWorkerDispatchError>;
    readonly verifyRegisteredProfile: (
      computerId: WorkjetComputerId,
      scope: RemoteWorkerNativeScope,
      profile: RemoteWorkerSourceProfile,
    ) => Effect.Effect<void, RemoteWorkerDispatchError>;
    readonly enroll: (
      input: RemoteWorkerComputerEnrollmentInput,
    ) => Effect.Effect<RemoteWorkerComputerEnrollmentResult, RemoteWorkerDispatchError>;
  }
>()("workjet/workjet/RemoteWorkerComputerEnrollment") {}

const RegisteredProfile = Schema.Struct({
  computerId: WorkjetComputerId,
  scope: Schema.Struct({ connectionId: WorkjetConnectionId, instanceId: Schema.String }),
  profile: RemoteWorkerSourceProfile,
});
const ProfileJson = Schema.fromJsonString(RegisteredProfile);
const profileKey = (computerId: WorkjetComputerId) =>
  `worker-registered-profile-${Crypto.createHash("sha256").update(computerId).digest("hex")}`;

/** Preserve references when native replaces a local draft ID with its issued ID. */
export const retainNativeComputerId = (
  config: WorkjetConfiguration,
  environmentId: EnvironmentId,
  previousId: WorkjetComputerId,
  nativeId: WorkjetComputerId,
  displayName: string,
): WorkjetConfiguration => ({
  ...config,
  computers: config.computers.map((computer) =>
    computer.environmentId === environmentId
      ? { ...computer, id: nativeId, label: displayName }
      : computer,
  ),
  selectedComputerId:
    config.selectedComputerId === previousId ? nativeId : config.selectedComputerId,
  workerProfiles: config.workerProfiles.map((profile) =>
    profile.computerId === previousId ? { ...profile, computerId: nativeId } : profile,
  ),
});

export const makeRemoteWorkerComputerEnrollment = Effect.fn("RemoteWorkerComputerEnrollment.make")(
  function* (dependencies: {
    readonly environmentId: EnvironmentId;
    readonly connections: Pick<
      DecisionHubConnectionRegistry["Service"],
      "list" | "resolveReadyTarget"
    >;
    readonly targets: ReturnType<typeof makeCtoxRemoteWorkerTargets>;
    readonly settings: Pick<ServerSettingsService["Service"], "getSettings" | "updateSettings">;
    readonly secrets: Pick<ServerSecretStore["Service"], "get" | "set" | "remove">;
  }) {
    const mutex = yield* Semaphore.make(1);
    const failure = () => new RemoteWorkerDispatchError({ reason: "computer-unavailable" });
    const read = (computerId: WorkjetComputerId) =>
      dependencies.secrets.get(profileKey(computerId)).pipe(Effect.mapError(failure));
    const encode = Schema.encodeEffect(ProfileJson);
    const verifyRegisteredProfile = Effect.fn("RemoteWorkerComputerEnrollment.verifyProfile")(
      function* (
        computerId: WorkjetComputerId,
        scope: RemoteWorkerNativeScope,
        profile: RemoteWorkerSourceProfile,
      ) {
        const retained = yield* read(computerId);
        if (Option.isNone(retained)) return yield* failure();
        const expected = yield* encode({ computerId, scope, profile }).pipe(
          Effect.mapError(failure),
        );
        const saved = yield* Schema.decodeUnknownEffect(ProfileJson)(
          new TextDecoder().decode(retained.value),
        ).pipe(Effect.mapError(failure));
        if ((yield* encode(saved).pipe(Effect.mapError(failure))) !== expected)
          return yield* failure();
      },
    );
    // Internal lifecycle hook: caller must first obtain current native revocation.
    const forgetRevokedProfile = Effect.fn("RemoteWorkerComputerEnrollment.forgetRevokedProfile")(
      function* (computerId: WorkjetComputerId, scope: RemoteWorkerNativeScope) {
        const retained = yield* read(computerId);
        if (Option.isNone(retained)) return;
        const saved = yield* Schema.decodeUnknownEffect(ProfileJson)(
          new TextDecoder().decode(retained.value),
        ).pipe(Effect.mapError(failure));
        if (
          saved.scope.connectionId !== scope.connectionId ||
          saved.scope.instanceId !== scope.instanceId
        )
          return yield* failure();
        yield* dependencies.secrets.remove(profileKey(computerId)).pipe(Effect.mapError(failure));
      },
    );
    const enroll = Effect.fn("RemoteWorkerComputerEnrollment.enroll")(function* (
      input: RemoteWorkerComputerEnrollmentInput,
    ) {
      if (input.profile.environmentId === dependencies.environmentId) return yield* failure();
      const settings = yield* dependencies.settings.getSettings.pipe(Effect.mapError(failure));
      const computers = settings.workjet.computers.filter(
        (computer) => computer.environmentId === input.profile.environmentId,
      );
      if (computers.length !== 1) return yield* failure();
      // The explicit selected Business OS determines the native grant tuple. SSH
      // connection/profile IDs never serve as native Business OS identity.
      const candidates = (yield* dependencies.connections.list.pipe(
        Effect.mapError(failure),
      )).filter(
        (connection) =>
          connection.instanceId === input.selectedInstanceId && connection.status === "ready",
      );
      if (candidates.length !== 1) return yield* failure();
      const selected = candidates[0]!;
      yield* dependencies.connections
        .resolveReadyTarget(selected.connectionId, input.selectedInstanceId)
        .pipe(Effect.mapError(failure));
      const previous = yield* read(computers[0]!.id);
      if (Option.isSome(previous)) {
        const expected = yield* encode({
          computerId: computers[0]!.id,
          scope: { connectionId: selected.connectionId, instanceId: input.selectedInstanceId },
          profile: input.profile,
        }).pipe(Effect.mapError(failure));
        if (new TextDecoder().decode(previous.value) !== expected)
          return yield* new RemoteWorkerDispatchError({ reason: "request-conflict" });
      }
      const scope = { connectionId: selected.connectionId, instanceId: input.selectedInstanceId };
      // Enrollment intent is immutable. Later capability edits keep the issued
      // computer and run through the existing computer.assign policy/epoch path.
      const receipt = yield* Option.isSome(previous)
        ? dependencies.targets.resolve(
            scope,
            dependencies.environmentId,
            input.profile.environmentId,
          )
        : dependencies.targets.enroll(
            scope,
            dependencies.environmentId,
            input.profile.environmentId,
            {
              targetConnectionId: selected.connectionId,
              targetInstanceId: input.selectedInstanceId,
            },
            input,
          );
      if (Option.isSome(previous) && receipt.target.targetComputerId !== computers[0]!.id)
        return yield* failure();
      const computerId = yield* Schema.decodeUnknownEffect(WorkjetComputerId)(
        receipt.target.targetComputerId,
      ).pipe(Effect.mapError(failure));
      const registered = yield* encode({
        computerId,
        scope: { connectionId: selected.connectionId, instanceId: input.selectedInstanceId },
        profile: input.profile,
      }).pipe(Effect.mapError(failure));
      const retained = yield* read(computerId);
      if (Option.isSome(retained) && new TextDecoder().decode(retained.value) !== registered)
        return yield* new RemoteWorkerDispatchError({ reason: "request-conflict" });
      // Explicit re-enrollment is idempotent only for the same native grant and
      // registered SSH profile. Replacement needs revocation/re-pairing first.
      yield* dependencies.secrets
        .set(profileKey(computerId), new TextEncoder().encode(registered))
        .pipe(Effect.mapError(failure));
      // Read again after native IO so unrelated settings edits are retained. ACK is
      // sent only after durable persistence; a retry uses native's existing mapping.
      const current = yield* dependencies.settings.getSettings.pipe(Effect.mapError(failure));
      const same = current.workjet.computers.filter(
        (computer) => computer.environmentId === input.profile.environmentId,
      );
      if (same.length !== 1 || (same[0]!.id !== input.computerId && same[0]!.id !== computerId))
        return yield* failure();
      yield* dependencies.settings
        .updateSettings({
          workjet: retainNativeComputerId(
            current.workjet,
            input.profile.environmentId,
            input.computerId,
            computerId,
            input.displayName,
          ),
        })
        .pipe(Effect.mapError(failure));
      return { computerId };
    });
    return RemoteWorkerComputerEnrollment.of({
      verifyRegisteredProfile,
      forgetRevokedProfile,
      enroll: (input) => enroll(input).pipe(mutex.withPermits(1)),
    });
  },
);
