// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type {
  BusinessOsInstanceId,
  WorkjetDeviceInviteRedeemInput,
  WorkjetDeviceInviteV2,
  WorkjetManagedCtoxSyncInviteIssueInput,
  WorkjetManagedCtoxSyncInviteIssueResult,
  WorkjetManagedDeviceBindingRecordV1,
  WorkjetManagedDeviceSessionIssueInput,
  WorkjetManagedDeviceSessionIssueResult,
  WorkjetManagedProvisioningGrantRevokeInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

const DPOP_MAX_CLOCK_SKEW_SECONDS = 300;

export type WorkjetManagedDeviceInviteIntent = {
  readonly devicePairingId: string;
  readonly businessOsInstanceId: BusinessOsInstanceId;
  readonly expiresAtEpochSeconds: number;
};

export type WorkjetManagedRedeemDpopClaims = {
  readonly proofKeyThumbprint: string;
  readonly htm: string;
  readonly htu: string;
  readonly iat: number;
  readonly jti: string;
  /** The verifier durably reserved this JTI for the proof key and HTU. */
  readonly replayProtected: boolean;
};

export class WorkjetManagedDeviceProvisioningPortError extends Schema.TaggedErrorClass<WorkjetManagedDeviceProvisioningPortError>()(
  "WorkjetManagedDeviceProvisioningPortError",
  { reason: Schema.Literals(["conflict", "internal", "rejected", "unavailable"]) },
) {
  override get message(): string {
    return "The managed Workjet device provisioning operation failed.";
  }
}

export class WorkjetManagedDeviceInviteCoordinatorError extends Schema.TaggedErrorClass<WorkjetManagedDeviceInviteCoordinatorError>()(
  "WorkjetManagedDeviceInviteCoordinatorError",
  { reason: Schema.Literals(["rejected", "unavailable"]) },
) {
  override get message(): string {
    return "The managed Workjet device invitation could not be redeemed.";
  }
}

/**
 * Cryptographically validates the DPoP JWT and atomically claims its JTI.
 * Implementations must reject invalid signatures and duplicate JTI values.
 */
export class WorkjetManagedRedeemDpopVerifier extends Context.Service<
  WorkjetManagedRedeemDpopVerifier,
  {
    readonly verifyAndClaim: (input: {
      readonly proof: string;
      readonly expectedMethod: "POST";
      readonly expectedUrl: string;
    }) => Effect.Effect<WorkjetManagedRedeemDpopClaims, WorkjetManagedDeviceProvisioningPortError>;
  }
>()("t3/ctox/WorkjetManagedDeviceInviteCoordinator/WorkjetManagedRedeemDpopVerifier") {}

/**
 * Issues the instance-scoped Workjet installation session. `issue` is
 * idempotent by devicePairingId and proof-key binding; it never selects a Code
 * Environment. Membership is resolved after the bootstrap exchange.
 */
export class WorkjetManagedDeviceSessionIssuer extends Context.Service<
  WorkjetManagedDeviceSessionIssuer,
  {
    readonly issue: (
      input: WorkjetManagedDeviceSessionIssueInput,
    ) => Effect.Effect<
      WorkjetManagedDeviceSessionIssueResult,
      WorkjetManagedDeviceProvisioningPortError
    >;
    readonly revoke: (
      input: WorkjetManagedProvisioningGrantRevokeInput,
    ) => Effect.Effect<void, WorkjetManagedDeviceProvisioningPortError>;
  }
>()("t3/ctox/WorkjetManagedDeviceInviteCoordinator/WorkjetManagedDeviceSessionIssuer") {}

/** Issues the native/managed CTOX synchronization capability for the edge. */
export class WorkjetManagedCtoxSyncInviteIssuer extends Context.Service<
  WorkjetManagedCtoxSyncInviteIssuer,
  {
    readonly issue: (
      input: WorkjetManagedCtoxSyncInviteIssueInput,
    ) => Effect.Effect<
      WorkjetManagedCtoxSyncInviteIssueResult,
      WorkjetManagedDeviceProvisioningPortError
    >;
    readonly revoke: (
      input: WorkjetManagedProvisioningGrantRevokeInput,
    ) => Effect.Effect<void, WorkjetManagedDeviceProvisioningPortError>;
  }
>()("t3/ctox/WorkjetManagedDeviceInviteCoordinator/WorkjetManagedCtoxSyncInviteIssuer") {}

export type WorkjetManagedDeviceBindingReservation =
  | { readonly _tag: "reserved" }
  | {
      readonly _tag: "resumed";
      readonly checkpoint: WorkjetManagedDeviceProvisioningCheckpoint;
    }
  | { readonly _tag: "active"; readonly record: WorkjetManagedDeviceBindingRecordV1 };

export type WorkjetManagedDeviceProvisioningCheckpoint = {
  readonly phase: "provisioning" | "revoking";
  readonly deviceSessionGrantId?: WorkjetManagedDeviceSessionIssueResult["grantId"];
  readonly ctoxGrantId?: WorkjetManagedCtoxSyncInviteIssueResult["grantId"];
};

/**
 * Durable, secret-free store for the installation-to-instance edge. The store
 * persists only identities, proof binding, grant ids and lifecycle state.
 */
export class WorkjetManagedDeviceBindingStore extends Context.Service<
  WorkjetManagedDeviceBindingStore,
  {
    readonly reserve: (input: {
      readonly devicePairingId: string;
      readonly deviceId: string;
      readonly proofKeyThumbprint: string;
      readonly businessOsInstanceId: BusinessOsInstanceId;
    }) => Effect.Effect<
      WorkjetManagedDeviceBindingReservation,
      WorkjetManagedDeviceProvisioningPortError
    >;
    readonly activate: (
      record: WorkjetManagedDeviceBindingRecordV1,
    ) => Effect.Effect<void, WorkjetManagedDeviceProvisioningPortError>;
    readonly checkpoint: (input: {
      readonly devicePairingId: string;
      readonly checkpoint: WorkjetManagedDeviceProvisioningCheckpoint;
    }) => Effect.Effect<void, WorkjetManagedDeviceProvisioningPortError>;
    readonly release: (
      devicePairingId: string,
    ) => Effect.Effect<void, WorkjetManagedDeviceProvisioningPortError>;
    readonly beginRevocation: (input: {
      readonly businessOsInstanceId: BusinessOsInstanceId;
      readonly devicePairingId: string;
    }) => Effect.Effect<
      | { readonly _tag: "missing" }
      | { readonly _tag: "pending"; readonly record: WorkjetManagedDeviceBindingRecordV1 },
      WorkjetManagedDeviceProvisioningPortError
    >;
    readonly finalizeRevocation: (input: {
      readonly businessOsInstanceId: BusinessOsInstanceId;
      readonly devicePairingId: string;
    }) => Effect.Effect<void, WorkjetManagedDeviceProvisioningPortError>;
  }
>()("t3/ctox/WorkjetManagedDeviceInviteCoordinator/WorkjetManagedDeviceBindingStore") {}

export type WorkjetManagedDeviceInviteRedeemRequest = {
  readonly intent: WorkjetManagedDeviceInviteIntent;
  readonly payload: WorkjetDeviceInviteRedeemInput;
  readonly dpopProof: string;
  /** Exact externally visible redemption URL used for the DPoP `htu` claim. */
  readonly requestUrl: string;
};

const coordinatorError = (reason: "rejected" | "unavailable") =>
  new WorkjetManagedDeviceInviteCoordinatorError({ reason });

const portError = (error: WorkjetManagedDeviceProvisioningPortError) =>
  coordinatorError(
    error.reason === "conflict" || error.reason === "rejected" ? "rejected" : "unavailable",
  );

function isBoundedIssuerExpiry(
  expiresAt: string,
  nowEpochSeconds: number,
  intentExpiresAtEpochSeconds: number,
): boolean {
  const expiresAtMillis = Date.parse(expiresAt);
  return (
    Number.isFinite(expiresAtMillis) &&
    expiresAtMillis >= (nowEpochSeconds + 60) * 1_000 &&
    expiresAtMillis <= intentExpiresAtEpochSeconds * 1_000
  );
}

export const make = Effect.fn("WorkjetManagedDeviceInviteCoordinator.make")(function* (options?: {
  readonly nowEpochSeconds?: () => number;
}) {
  const dpopVerifier = yield* WorkjetManagedRedeemDpopVerifier;
  const deviceSessions = yield* WorkjetManagedDeviceSessionIssuer;
  const ctoxInvites = yield* WorkjetManagedCtoxSyncInviteIssuer;
  const bindings = yield* WorkjetManagedDeviceBindingStore;

  const currentTimeSeconds =
    options?.nowEpochSeconds === undefined
      ? DateTime.now.pipe(Effect.map((now) => Math.floor(DateTime.toEpochMillis(now) / 1_000)))
      : Effect.sync(options.nowEpochSeconds);

  /**
   * A reservation is released only after every issued grant was revoked. If a
   * revocation fails, keeping the reservation makes the next request resume the
   * same idempotency key instead of losing the only durable retry anchor.
   */
  const compensate = Effect.fn("WorkjetManagedDeviceInviteCoordinator.compensate")(
    function* (input: {
      readonly businessOsInstanceId: BusinessOsInstanceId;
      readonly devicePairingId: string;
      readonly deviceSessionGrantId?: WorkjetManagedDeviceSessionIssueResult["grantId"];
      readonly ctoxGrantId?: WorkjetManagedCtoxSyncInviteIssueResult["grantId"];
    }) {
      yield* bindings
        .checkpoint({
          devicePairingId: input.devicePairingId,
          checkpoint: {
            phase: "revoking",
            ...(input.deviceSessionGrantId === undefined
              ? {}
              : { deviceSessionGrantId: input.deviceSessionGrantId }),
            ...(input.ctoxGrantId === undefined ? {} : { ctoxGrantId: input.ctoxGrantId }),
          },
        })
        .pipe(Effect.exit, Effect.asVoid);
      const revocations = yield* Effect.all(
        [
          input.deviceSessionGrantId === undefined
            ? Effect.void
            : Effect.exit(
                deviceSessions.revoke({
                  businessOsInstanceId: input.businessOsInstanceId,
                  grantId: input.deviceSessionGrantId,
                }),
              ),
          input.ctoxGrantId === undefined
            ? Effect.void
            : Effect.exit(
                ctoxInvites.revoke({
                  businessOsInstanceId: input.businessOsInstanceId,
                  grantId: input.ctoxGrantId,
                }),
              ),
        ],
        { concurrency: "unbounded" },
      );
      const allRevoked = revocations.every(
        (result) => result === undefined || Exit.isSuccess(result),
      );
      if (allRevoked) {
        yield* bindings.release(input.devicePairingId).pipe(Effect.exit, Effect.asVoid);
      }
      return allRevoked;
    },
  );

  const redeem = Effect.fn("WorkjetManagedDeviceInviteCoordinator.redeem")(function* (
    request: WorkjetManagedDeviceInviteRedeemRequest,
  ) {
    const nowEpochSeconds = yield* currentTimeSeconds;
    const claims = yield* dpopVerifier
      .verifyAndClaim({
        proof: request.dpopProof,
        expectedMethod: "POST",
        expectedUrl: request.requestUrl,
      })
      .pipe(Effect.mapError(portError));

    if (
      claims.proofKeyThumbprint !== request.payload.proofKeyThumbprint ||
      claims.htm !== "POST" ||
      claims.htu !== request.requestUrl ||
      !Number.isInteger(claims.iat) ||
      Math.abs(nowEpochSeconds - claims.iat) > DPOP_MAX_CLOCK_SKEW_SECONDS ||
      claims.jti.trim() === "" ||
      claims.jti.length > 256 ||
      claims.replayProtected !== true
    ) {
      return yield* coordinatorError("rejected");
    }

    const remainingSeconds = Math.floor(request.intent.expiresAtEpochSeconds - nowEpochSeconds);
    if (remainingSeconds < 60 || remainingSeconds > 3_600) {
      return yield* coordinatorError("rejected");
    }

    const reservation = yield* bindings
      .reserve({
        devicePairingId: request.intent.devicePairingId,
        deviceId: request.payload.deviceId,
        proofKeyThumbprint: request.payload.proofKeyThumbprint,
        businessOsInstanceId: request.intent.businessOsInstanceId,
      })
      .pipe(Effect.mapError(portError));
    if (reservation._tag === "active") {
      return yield* coordinatorError("rejected");
    }
    if (
      reservation._tag === "resumed" &&
      (reservation.checkpoint.deviceSessionGrantId !== undefined ||
        reservation.checkpoint.ctoxGrantId !== undefined)
    ) {
      yield* compensate({
        businessOsInstanceId: request.intent.businessOsInstanceId,
        devicePairingId: request.intent.devicePairingId,
        ...(reservation.checkpoint.deviceSessionGrantId === undefined
          ? {}
          : { deviceSessionGrantId: reservation.checkpoint.deviceSessionGrantId }),
        ...(reservation.checkpoint.ctoxGrantId === undefined
          ? {}
          : { ctoxGrantId: reservation.checkpoint.ctoxGrantId }),
      });
      return yield* coordinatorError("unavailable");
    }

    const provisioningInput = {
      businessOsInstanceId: request.intent.businessOsInstanceId,
      devicePairingId: request.intent.devicePairingId,
      deviceId: request.payload.deviceId,
      proofKeyThumbprint: claims.proofKeyThumbprint,
      ttlSeconds: remainingSeconds,
    } satisfies WorkjetManagedDeviceSessionIssueInput;

    const issued = yield* Effect.all(
      {
        deviceSession: Effect.exit(deviceSessions.issue(provisioningInput)),
        ctox: Effect.exit(ctoxInvites.issue(provisioningInput)),
      },
      { concurrency: "unbounded" },
    );

    yield* bindings
      .checkpoint({
        devicePairingId: request.intent.devicePairingId,
        checkpoint: {
          phase: "provisioning",
          ...(Exit.isSuccess(issued.deviceSession)
            ? { deviceSessionGrantId: issued.deviceSession.value.grantId }
            : {}),
          ...(Exit.isSuccess(issued.ctox) ? { ctoxGrantId: issued.ctox.value.grantId } : {}),
        },
      })
      .pipe(Effect.mapError(portError));

    if (Exit.isFailure(issued.deviceSession) || Exit.isFailure(issued.ctox)) {
      yield* compensate({
        businessOsInstanceId: request.intent.businessOsInstanceId,
        devicePairingId: request.intent.devicePairingId,
        ...(Exit.isSuccess(issued.deviceSession)
          ? { deviceSessionGrantId: issued.deviceSession.value.grantId }
          : {}),
        ...(Exit.isSuccess(issued.ctox) ? { ctoxGrantId: issued.ctox.value.grantId } : {}),
      });
      return yield* coordinatorError("unavailable");
    }

    const deviceSession = issued.deviceSession.value;
    const ctox = issued.ctox.value;
    const issuerBindingsMatch =
      deviceSession.businessOsInstanceId === request.intent.businessOsInstanceId &&
      deviceSession.deviceId === request.payload.deviceId &&
      deviceSession.proofKeyThumbprint === claims.proofKeyThumbprint &&
      ctox.businessOsInstanceId === request.intent.businessOsInstanceId &&
      ctox.deviceId === request.payload.deviceId &&
      ctox.proofKeyThumbprint === claims.proofKeyThumbprint &&
      ctox.invite.instance_id === request.intent.businessOsInstanceId;
    const issuerExpiriesMatch =
      isBoundedIssuerExpiry(
        deviceSession.expiresAt,
        nowEpochSeconds,
        request.intent.expiresAtEpochSeconds,
      ) &&
      isBoundedIssuerExpiry(
        ctox.expiresAt,
        nowEpochSeconds,
        request.intent.expiresAtEpochSeconds,
      ) &&
      isBoundedIssuerExpiry(
        ctox.invite.expires_at,
        nowEpochSeconds,
        request.intent.expiresAtEpochSeconds,
      );
    if (!issuerBindingsMatch || !issuerExpiriesMatch) {
      yield* compensate({
        businessOsInstanceId: request.intent.businessOsInstanceId,
        devicePairingId: request.intent.devicePairingId,
        deviceSessionGrantId: deviceSession.grantId,
        ctoxGrantId: ctox.grantId,
      });
      return yield* coordinatorError("rejected");
    }

    const record = {
      type: "workjet-managed-device-binding" as const,
      version: 1 as const,
      devicePairingId: request.intent.devicePairingId,
      deviceId: request.payload.deviceId,
      proofKeyThumbprint: claims.proofKeyThumbprint,
      businessOsInstanceId: request.intent.businessOsInstanceId,
      deviceSessionGrantId: deviceSession.grantId,
      ctoxGrantId: ctox.grantId,
      state: "active" as const,
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(nowEpochSeconds * 1_000)),
      revokedAt: null,
    } satisfies WorkjetManagedDeviceBindingRecordV1;

    const persisted = yield* Effect.exit(bindings.activate(record));
    if (Exit.isFailure(persisted)) {
      yield* compensate({
        businessOsInstanceId: request.intent.businessOsInstanceId,
        devicePairingId: request.intent.devicePairingId,
        deviceSessionGrantId: deviceSession.grantId,
        ctoxGrantId: ctox.grantId,
      });
      return yield* coordinatorError("unavailable");
    }

    return {
      type: "workjet-device-invite" as const,
      version: 2 as const,
      device_pairing_id: request.intent.devicePairingId,
      business_os_instance_id: request.intent.businessOsInstanceId,
      workjet_session: {
        issuer: deviceSession.issuer,
        bootstrap_credential: deviceSession.bootstrapCredential,
        expires_at: deviceSession.expiresAt,
      },
      business_os: ctox.invite,
    } satisfies WorkjetDeviceInviteV2;
  });

  const revokeBinding = Effect.fn("WorkjetManagedDeviceInviteCoordinator.revokeBinding")(
    function* (input: {
      readonly businessOsInstanceId: BusinessOsInstanceId;
      readonly devicePairingId: string;
    }) {
      const revocation = yield* bindings.beginRevocation(input).pipe(Effect.mapError(portError));
      if (revocation._tag === "missing") return { revoked: true as const };
      if (revocation.record.businessOsInstanceId !== input.businessOsInstanceId) {
        return yield* coordinatorError("rejected");
      }

      const downstream = yield* Effect.all(
        [
          Effect.exit(
            deviceSessions.revoke({
              businessOsInstanceId: input.businessOsInstanceId,
              grantId: revocation.record.deviceSessionGrantId,
            }),
          ),
          Effect.exit(
            ctoxInvites.revoke({
              businessOsInstanceId: input.businessOsInstanceId,
              grantId: revocation.record.ctoxGrantId,
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      if (downstream.some(Exit.isFailure)) {
        return yield* coordinatorError("unavailable");
      }
      yield* bindings.finalizeRevocation(input).pipe(Effect.mapError(portError));
      return { revoked: true as const };
    },
  );

  return { redeem, revokeBinding } as const;
});

export class WorkjetManagedDeviceInviteCoordinator extends Context.Service<
  WorkjetManagedDeviceInviteCoordinator,
  Effect.Success<ReturnType<typeof make>>
>()("t3/ctox/WorkjetManagedDeviceInviteCoordinator") {}
