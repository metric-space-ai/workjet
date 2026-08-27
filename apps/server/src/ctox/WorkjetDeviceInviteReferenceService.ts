// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { WorkjetDeviceInviteRefV1 } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_ATTEMPTS = 12;
const RATE_LIMIT_BUCKET_HASH_LENGTH = 2;

export type WorkjetDeviceInviteIntent = {
  readonly inviteId: string;
  readonly endpoint: string;
  readonly businessOsInstanceId: string;
  readonly expiresAtMs: number;
};

export type WorkjetDeviceBindingRecord = {
  readonly devicePairingId: string;
  readonly deviceId: string;
  readonly proofKeyThumbprint: string;
  readonly businessOsInstanceId: string;
  readonly environmentPairingLinkId: string;
  readonly ctoxInviteId: string;
  readonly createdAtMs: number;
};

export type WorkjetDeviceInviteRevocation =
  | { readonly _tag: "pending" }
  | { readonly _tag: "binding"; readonly binding: WorkjetDeviceBindingRecord }
  | { readonly _tag: "missing" };

export type WorkjetDeviceInviteReferenceFailureReason = "internal" | "rate_limited" | "rejected";

export class WorkjetDeviceInviteReferenceServiceError extends Schema.TaggedErrorClass<WorkjetDeviceInviteReferenceServiceError>()(
  "WorkjetDeviceInviteReferenceServiceError",
  { reason: Schema.Literals(["internal", "rate_limited", "rejected"]) },
) {
  override get message(): string {
    return "The Workjet device invitation reference operation failed.";
  }
}

export class WorkjetDeviceInviteReferenceService extends Context.Service<
  WorkjetDeviceInviteReferenceService,
  {
    readonly issue: (input: {
      readonly endpoint: string;
      readonly expiresAt: string;
      readonly businessOsInstanceId: string;
    }) => Effect.Effect<
      { readonly inviteId: string; readonly reference: WorkjetDeviceInviteRefV1 },
      WorkjetDeviceInviteReferenceServiceError
    >;
    readonly consume: (input: {
      readonly code: string;
      readonly rateLimitKey: string;
    }) => Effect.Effect<WorkjetDeviceInviteIntent, WorkjetDeviceInviteReferenceServiceError>;
    readonly complete: (
      binding: WorkjetDeviceBindingRecord,
    ) => Effect.Effect<WorkjetDeviceBindingRecord | null, WorkjetDeviceInviteReferenceServiceError>;
    readonly beginRevocation: (
      identifier: string,
    ) => Effect.Effect<WorkjetDeviceInviteRevocation, WorkjetDeviceInviteReferenceServiceError>;
    readonly finalizeBindingRevocation: (
      devicePairingId: string,
    ) => Effect.Effect<boolean, WorkjetDeviceInviteReferenceServiceError>;
    readonly listBindings: (
      businessOsInstanceId: string,
    ) => Effect.Effect<
      ReadonlyArray<WorkjetDeviceBindingRecord>,
      WorkjetDeviceInviteReferenceServiceError
    >;
  }
>()("t3/ctox/WorkjetDeviceInviteReferenceService") {}

export interface WorkjetDeviceInviteReferenceServiceOptions {
  readonly nowEpochMs?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
}

function serviceError(reason: WorkjetDeviceInviteReferenceFailureReason) {
  return new WorkjetDeviceInviteReferenceServiceError({ reason });
}

function sha256(value: string): string {
  return NodeCrypto.createHash("sha256").update(value, "utf8").digest("base64url");
}

const BINDING_COLUMNS = `
  device_pairing_id AS "devicePairingId",
  device_id AS "deviceId",
  proof_key_thumbprint AS "proofKeyThumbprint",
  business_os_instance_id AS "businessOsInstanceId",
  environment_pairing_link_id AS "environmentPairingLinkId",
  ctox_invite_id AS "ctoxInviteId",
  created_at_ms AS "createdAtMs"
`;

export const make = Effect.fn("WorkjetDeviceInviteReferenceService.make")(function* (
  options: WorkjetDeviceInviteReferenceServiceOptions = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const currentTimeMillis =
    options.nowEpochMs === undefined
      ? DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))
      : Effect.sync(options.nowEpochMs);
  const randomBytes = options.randomBytes ?? ((size: number) => NodeCrypto.randomBytes(size));

  const issue = Effect.fn("WorkjetDeviceInviteReferenceService.issue")(function* (input: {
    readonly endpoint: string;
    readonly expiresAt: string;
    readonly businessOsInstanceId: string;
  }) {
    const expiresAtMs = Date.parse(input.expiresAt);
    const now = yield* currentTimeMillis;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
      return yield* serviceError("internal");
    }
    const code = Buffer.from(randomBytes(32)).toString("base64url");
    const inviteId = Buffer.from(randomBytes(24)).toString("base64url");
    const codeHash = sha256(code);
    yield* sql`
      INSERT INTO workjet_device_invite_references (
        invite_id, code_hash, endpoint, business_os_instance_id,
        expires_at_ms, created_at_ms
      ) VALUES (
        ${inviteId}, ${codeHash}, ${input.endpoint}, ${input.businessOsInstanceId},
        ${expiresAtMs}, ${now}
      )
    `.pipe(Effect.mapError(() => serviceError("internal")));
    return {
      inviteId,
      reference: {
        type: "workjet-device-invite-ref" as const,
        version: 1 as const,
        endpoint: input.endpoint,
        code,
        expires_at: input.expiresAt,
      },
    };
  });

  const consume = Effect.fn("WorkjetDeviceInviteReferenceService.consume")(function* (input: {
    readonly code: string;
    readonly rateLimitKey: string;
  }) {
    const now = yield* currentTimeMillis;
    const codeHash = sha256(input.code);
    // Bucket the untrusted network key into a fixed-size keyspace. This keeps
    // the durable limiter bounded even when an attacker rotates source
    // addresses or submits arbitrary invite codes.
    const rateKeyHash = sha256(input.rateLimitKey).slice(0, RATE_LIMIT_BUCKET_HASH_LENGTH);
    const outcome = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM workjet_device_invite_rate_limits
            WHERE updated_at_ms < ${now - RATE_LIMIT_WINDOW_MS}
          `;
          const windows = yield* sql<{
            readonly windowStartedAtMs: number;
            readonly attempts: number;
          }>`
            SELECT
              window_started_at_ms AS "windowStartedAtMs",
              attempts
            FROM workjet_device_invite_rate_limits
            WHERE rate_key_hash = ${rateKeyHash}
          `;
          const prior = windows[0];
          const active =
            prior !== undefined && now - prior.windowStartedAtMs < RATE_LIMIT_WINDOW_MS;
          const attempts = active ? prior.attempts : 0;
          if (attempts >= RATE_LIMIT_ATTEMPTS) {
            return { _tag: "failure" as const, reason: "rate_limited" as const };
          }
          yield* sql`
            INSERT INTO workjet_device_invite_rate_limits (
              rate_key_hash, window_started_at_ms, attempts, updated_at_ms
            ) VALUES (
              ${rateKeyHash}, ${active ? (prior?.windowStartedAtMs ?? now) : now},
              ${attempts + 1}, ${now}
            )
            ON CONFLICT(rate_key_hash) DO UPDATE SET
              window_started_at_ms = excluded.window_started_at_ms,
              attempts = excluded.attempts,
              updated_at_ms = excluded.updated_at_ms
          `;
          const rows = yield* sql<{
            readonly inviteId: string;
            readonly endpoint: string;
            readonly businessOsInstanceId: string;
            readonly expiresAtMs: number;
          }>`
            SELECT
              invite_id AS "inviteId",
              endpoint,
              business_os_instance_id AS "businessOsInstanceId",
              expires_at_ms AS "expiresAtMs"
            FROM workjet_device_invite_references
            WHERE code_hash = ${codeHash}
              AND consumed_at_ms IS NULL
              AND revoked_at_ms IS NULL
              AND expires_at_ms > ${now}
          `;
          const intent = rows[0];
          if (intent === undefined) {
            return { _tag: "failure" as const, reason: "rejected" as const };
          }
          const consumed = yield* sql<{ readonly inviteId: string }>`
            UPDATE workjet_device_invite_references
            SET consumed_at_ms = ${now}
            WHERE invite_id = ${intent.inviteId}
              AND consumed_at_ms IS NULL
              AND revoked_at_ms IS NULL
            RETURNING invite_id AS "inviteId"
          `;
          if (consumed.length !== 1) {
            return { _tag: "failure" as const, reason: "rejected" as const };
          }
          return { _tag: "success" as const, intent };
        }),
      )
      .pipe(Effect.mapError(() => serviceError("internal")));
    if (outcome._tag === "failure") return yield* serviceError(outcome.reason);
    return outcome.intent satisfies WorkjetDeviceInviteIntent;
  });

  const complete = Effect.fn("WorkjetDeviceInviteReferenceService.complete")(function* (
    binding: WorkjetDeviceBindingRecord,
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const previous = yield* sql<WorkjetDeviceBindingRecord>`
            SELECT ${sql.literal(BINDING_COLUMNS)}
            FROM workjet_device_bindings
            WHERE device_id = ${binding.deviceId}
              AND business_os_instance_id = ${binding.businessOsInstanceId}
              AND revoked_at_ms IS NULL
          `;
          yield* sql`
            INSERT INTO workjet_device_bindings (
              device_pairing_id, device_id, proof_key_thumbprint,
              business_os_instance_id, environment_pairing_link_id,
              ctox_invite_id, created_at_ms, revoked_at_ms
            ) VALUES (
              ${binding.devicePairingId}, ${binding.deviceId}, ${binding.proofKeyThumbprint},
              ${binding.businessOsInstanceId}, ${binding.environmentPairingLinkId},
              ${binding.ctoxInviteId}, ${binding.createdAtMs}, NULL
            )
            ON CONFLICT(device_id, business_os_instance_id) DO UPDATE SET
              device_pairing_id = excluded.device_pairing_id,
              proof_key_thumbprint = excluded.proof_key_thumbprint,
              environment_pairing_link_id = excluded.environment_pairing_link_id,
              ctox_invite_id = excluded.ctox_invite_id,
              created_at_ms = excluded.created_at_ms,
              revoked_at_ms = NULL
          `;
          return previous[0] ?? null;
        }),
      )
      .pipe(Effect.mapError(() => serviceError("internal")));
  });

  const beginRevocation = Effect.fn("WorkjetDeviceInviteReferenceService.beginRevocation")(
    function* (identifier: string) {
      const now = yield* currentTimeMillis;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const pending = yield* sql<{ readonly inviteId: string }>`
            UPDATE workjet_device_invite_references
            SET revoked_at_ms = ${now}
            WHERE invite_id = ${identifier}
              AND consumed_at_ms IS NULL
              AND revoked_at_ms IS NULL
            RETURNING invite_id AS "inviteId"
          `;
            if (pending.length === 1) return { _tag: "pending" as const };
            const bindings = yield* sql<WorkjetDeviceBindingRecord>`
            SELECT ${sql.literal(BINDING_COLUMNS)}
            FROM workjet_device_bindings
            WHERE device_pairing_id = ${identifier}
              AND revoked_at_ms IS NULL
          `;
            const binding = bindings[0];
            if (binding === undefined) return { _tag: "missing" as const };
            return { _tag: "binding" as const, binding };
          }),
        )
        .pipe(Effect.mapError(() => serviceError("internal")));
    },
  );

  const finalizeBindingRevocation = Effect.fn(
    "WorkjetDeviceInviteReferenceService.finalizeBindingRevocation",
  )(function* (devicePairingId: string) {
    const now = yield* currentTimeMillis;
    const revoked = yield* sql<{ readonly devicePairingId: string }>`
      UPDATE workjet_device_bindings
      SET revoked_at_ms = CASE
        WHEN created_at_ms > ${now} THEN created_at_ms
        ELSE ${now}
      END
      WHERE device_pairing_id = ${devicePairingId}
        AND revoked_at_ms IS NULL
      RETURNING device_pairing_id AS "devicePairingId"
    `.pipe(Effect.mapError(() => serviceError("internal")));
    return revoked.length === 1;
  });

  const listBindings = Effect.fn("WorkjetDeviceInviteReferenceService.listBindings")(function* (
    businessOsInstanceId: string,
  ) {
    return yield* sql<WorkjetDeviceBindingRecord>`
        SELECT ${sql.literal(BINDING_COLUMNS)}
        FROM workjet_device_bindings
        WHERE business_os_instance_id = ${businessOsInstanceId}
          AND revoked_at_ms IS NULL
        ORDER BY device_id ASC
      `.pipe(Effect.mapError(() => serviceError("internal")));
  });

  return WorkjetDeviceInviteReferenceService.of({
    issue,
    consume,
    complete,
    beginRevocation,
    finalizeBindingRevocation,
    listBindings,
  });
});

export const layer = (options: WorkjetDeviceInviteReferenceServiceOptions = {}) =>
  Layer.effect(WorkjetDeviceInviteReferenceService, make(options));
