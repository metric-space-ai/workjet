import * as NodeCrypto from "node:crypto";

import type { RelayDpopAccessTokenClaims } from "../auth/RelayTokens.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { and, eq, gt, isNull, sql } from "drizzle-orm";

import * as RelayTokens from "../auth/RelayTokens.ts";
import * as RelayConfiguration from "../Config.ts";
import * as RelayDb from "../db.ts";
import {
  relayWorkjetBusinessOsInstances,
  relayWorkjetDeviceSessionGrants,
} from "../persistence/schema.ts";

export const DEVICE_SESSION_ACCESS_TTL = { minutes: 30 } as const;
export const DEVICE_SESSION_REFRESH_TTL = { days: 30 } as const;

export function hashCredential(value: string): string {
  return NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");
}

export function deriveBootstrapCredential(secret: string, grantId: string): string {
  return NodeCrypto.createHmac("sha256", secret)
    .update(`workjet-device-bootstrap:v1:${grantId}`, "utf8")
    .digest("base64url");
}

function randomCredential(): string {
  return NodeCrypto.randomBytes(32).toString("base64url");
}

export interface DeviceSessionIssueInput {
  readonly businessOsInstanceId: string;
  readonly devicePairingId: string;
  readonly deviceId: string;
  readonly proofKeyThumbprint: string;
  readonly relayUserId: string;
  readonly ttlSeconds: number;
}

export interface DeviceSessionGrantCandidate {
  readonly grantId: string;
  readonly relayUserId: string;
  readonly businessOsInstanceId: string;
  readonly deviceId: string;
  readonly proofKeyThumbprint: string;
  readonly accessGeneration: number;
}

export class WorkjetDeviceSessionPrincipal extends Context.Service<
  WorkjetDeviceSessionPrincipal,
  DeviceSessionGrantCandidate
>()("t3code-relay/workjet/DeviceSessions/WorkjetDeviceSessionPrincipal") {}

export interface DeviceSessionAuthorization extends DeviceSessionGrantCandidate {
  readonly accessToken: string;
  readonly accessExpiresAt: string;
  readonly refreshGrant: string;
  readonly refreshExpiresAt: string;
}

export class DeviceSessionRejected extends Schema.TaggedErrorClass<DeviceSessionRejected>()(
  "DeviceSessionRejected",
  {
    reason: Schema.Literals([
      "not-found",
      "expired",
      "revoked",
      "already-consumed",
      "identity-mismatch",
      "idempotency-conflict",
      "owner-mismatch",
    ]),
  },
) {}

export class DeviceSessionPersistenceError extends Schema.TaggedErrorClass<DeviceSessionPersistenceError>()(
  "DeviceSessionPersistenceError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class DeviceSessionConfigurationError extends Schema.TaggedErrorClass<DeviceSessionConfigurationError>()(
  "DeviceSessionConfigurationError",
  { reason: Schema.Literal("secret-unavailable") },
) {}

type DeviceSessionError =
  | DeviceSessionRejected
  | DeviceSessionPersistenceError
  | DeviceSessionConfigurationError;

export class DeviceSessions extends Context.Service<
  DeviceSessions,
  {
    readonly issue: (
      input: DeviceSessionIssueInput,
    ) => Effect.Effect<
      {
        readonly grantId: string;
        readonly bootstrapCredential: string;
        readonly expiresAt: string;
      },
      DeviceSessionError
    >;
    readonly revoke: (input: {
      readonly businessOsInstanceId: string;
      readonly grantId: string;
    }) => Effect.Effect<boolean, DeviceSessionPersistenceError>;
    readonly findBootstrap: (
      bootstrapCredential: string,
    ) => Effect.Effect<DeviceSessionGrantCandidate | null, DeviceSessionPersistenceError>;
    readonly exchangeBootstrap: (input: {
      readonly bootstrapCredential: string;
      readonly businessOsInstanceId: string;
      readonly deviceId: string;
    }) => Effect.Effect<DeviceSessionAuthorization, DeviceSessionError>;
    readonly findRefresh: (
      refreshGrant: string,
    ) => Effect.Effect<DeviceSessionGrantCandidate | null, DeviceSessionPersistenceError>;
    readonly renew: (input: {
      readonly refreshGrant: string;
      readonly businessOsInstanceId: string;
      readonly deviceId: string;
    }) => Effect.Effect<DeviceSessionAuthorization, DeviceSessionError>;
    readonly authorizeAccess: (
      claims: RelayDpopAccessTokenClaims,
    ) => Effect.Effect<DeviceSessionGrantCandidate | null, DeviceSessionPersistenceError>;
  }
>()("t3code-relay/workjet/DeviceSessions") {}

const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const db = yield* RelayDb.RelayDb;
  const transactions = yield* RelayDb.RelayTransactions;
  const tokens = yield* RelayTokens.RelayTokens;
  const secret = config.workjetDeviceSessionSecret;

  const requireSecret = Effect.sync(() =>
    secret === undefined ? null : Redacted.value(secret),
  ).pipe(
    Effect.flatMap((value) =>
      value === null
        ? Effect.fail(new DeviceSessionConfigurationError({ reason: "secret-unavailable" }))
        : Effect.succeed(value),
    ),
  );

  const rowCandidate = (row: typeof relayWorkjetDeviceSessionGrants.$inferSelect) => ({
    grantId: row.grantId,
    relayUserId: row.relayUserId,
    businessOsInstanceId: row.businessOsInstanceId,
    deviceId: row.deviceId,
    proofKeyThumbprint: row.proofKeyThumbprint,
    accessGeneration: row.accessGeneration,
  });

  const issueAccess = Effect.fn("relay.workjet.device_sessions.issue_access")(function* (
    grant: DeviceSessionGrantCandidate,
  ) {
    const now = yield* DateTime.now;
    const accessExpiresAt = DateTime.add(now, DEVICE_SESSION_ACCESS_TTL);
    const refreshExpiresAt = DateTime.add(now, DEVICE_SESSION_REFRESH_TTL);
    const accessToken = yield* tokens
      .issueDpopAccessToken({
        userId: grant.relayUserId,
        proofKeyThumbprint: grant.proofKeyThumbprint,
        jti: randomCredential(),
        issuedAtEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
        expiresAtEpochSeconds: Math.floor(accessExpiresAt.epochMilliseconds / 1_000),
        clientId: "t3-mobile",
        scopes: ["environment:connect", "environment:status"],
        workjet: {
          grantId: grant.grantId,
          businessOsInstanceId: grant.businessOsInstanceId,
          deviceId: grant.deviceId,
          accessGeneration: grant.accessGeneration,
        },
      })
      .pipe(
        Effect.mapError(
          (cause) => new DeviceSessionPersistenceError({ operation: "issue-access-token", cause }),
        ),
      );
    return { accessToken, accessExpiresAt, refreshExpiresAt };
  });

  const findByHash = Effect.fn("relay.workjet.device_sessions.find_by_hash")(function* (input: {
    readonly column: "bootstrap" | "refresh";
    readonly credential: string;
  }) {
    const column =
      input.column === "bootstrap"
        ? relayWorkjetDeviceSessionGrants.bootstrapCredentialHash
        : relayWorkjetDeviceSessionGrants.refreshGrantHash;
    const rows = yield* db
      .select()
      .from(relayWorkjetDeviceSessionGrants)
      .where(eq(column, hashCredential(input.credential)))
      .limit(1)
      .pipe(
        Effect.mapError(
          (cause) =>
            new DeviceSessionPersistenceError({ operation: `find-${input.column}`, cause }),
        ),
      );
    const row = rows[0];
    return row && row.revokedAt === null ? rowCandidate(row) : null;
  });

  const issue: DeviceSessions["Service"]["issue"] = Effect.fn(
    "relay.workjet.device_sessions.issue",
  )(function* (input) {
    const hmacSecret = yield* requireSecret;
    return yield* transactions
      .withTransaction(
        Effect.gen(function* () {
          const existingRows = yield* db
            .select()
            .from(relayWorkjetDeviceSessionGrants)
            .where(eq(relayWorkjetDeviceSessionGrants.devicePairingId, input.devicePairingId))
            .limit(1)
            .pipe(
              Effect.mapError(
                (cause) => new DeviceSessionPersistenceError({ operation: "issue-lookup", cause }),
              ),
            );
          const existing = existingRows[0];
          if (existing) {
            if (
              existing.businessOsInstanceId !== input.businessOsInstanceId ||
              existing.relayUserId !== input.relayUserId ||
              existing.deviceId !== input.deviceId ||
              existing.proofKeyThumbprint !== input.proofKeyThumbprint ||
              existing.revokedAt !== null
            ) {
              return yield* new DeviceSessionRejected({ reason: "idempotency-conflict" });
            }
            return {
              grantId: existing.grantId,
              bootstrapCredential: deriveBootstrapCredential(hmacSecret, existing.grantId),
              expiresAt: existing.bootstrapExpiresAt,
            };
          }
          const owners = yield* db
            .select({ relayUserId: relayWorkjetBusinessOsInstances.relayUserId })
            .from(relayWorkjetBusinessOsInstances)
            .where(
              eq(relayWorkjetBusinessOsInstances.businessOsInstanceId, input.businessOsInstanceId),
            )
            .limit(1)
            .pipe(
              Effect.mapError(
                (cause) => new DeviceSessionPersistenceError({ operation: "issue-owner", cause }),
              ),
            );
          if (owners[0] && owners[0].relayUserId !== input.relayUserId) {
            return yield* new DeviceSessionRejected({ reason: "owner-mismatch" });
          }
          const now = yield* DateTime.now;
          const nowIso = DateTime.formatIso(now);
          if (!owners[0]) {
            yield* db
              .insert(relayWorkjetBusinessOsInstances)
              .values({
                businessOsInstanceId: input.businessOsInstanceId,
                relayUserId: input.relayUserId,
                membershipVersion: 0,
                createdAt: nowIso,
                updatedAt: nowIso,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new DeviceSessionPersistenceError({ operation: "issue-create-owner", cause }),
                ),
              );
          }
          const grantId = randomCredential();
          const bootstrapCredential = deriveBootstrapCredential(hmacSecret, grantId);
          const expiresAt = DateTime.formatIso(DateTime.add(now, { seconds: input.ttlSeconds }));
          yield* db
            .insert(relayWorkjetDeviceSessionGrants)
            .values({
              grantId,
              devicePairingId: input.devicePairingId,
              businessOsInstanceId: input.businessOsInstanceId,
              relayUserId: input.relayUserId,
              deviceId: input.deviceId,
              proofKeyThumbprint: input.proofKeyThumbprint,
              bootstrapCredentialHash: hashCredential(bootstrapCredential),
              bootstrapExpiresAt: expiresAt,
              bootstrapConsumedAt: null,
              refreshGrantHash: null,
              refreshExpiresAt: null,
              accessGeneration: 0,
              revokedAt: null,
              createdAt: nowIso,
              updatedAt: nowIso,
            })
            .pipe(
              Effect.mapError(
                (cause) => new DeviceSessionPersistenceError({ operation: "issue-insert", cause }),
              ),
            );
          return { grantId, bootstrapCredential, expiresAt };
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(new DeviceSessionPersistenceError({ operation: "issue-transaction", cause })),
        ),
      );
  });

  const exchangeBootstrap: DeviceSessions["Service"]["exchangeBootstrap"] = Effect.fn(
    "relay.workjet.device_sessions.exchange_bootstrap",
  )(function* (input) {
    return yield* transactions
      .withTransaction(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const nowIso = DateTime.formatIso(now);
          const refreshGrant = randomCredential();
          const refreshExpiresAt = DateTime.formatIso(
            DateTime.add(now, DEVICE_SESSION_REFRESH_TTL),
          );
          const updated = yield* db
            .update(relayWorkjetDeviceSessionGrants)
            .set({
              bootstrapConsumedAt: nowIso,
              refreshGrantHash: hashCredential(refreshGrant),
              refreshExpiresAt,
              accessGeneration: 1,
              updatedAt: nowIso,
            })
            .where(
              and(
                eq(
                  relayWorkjetDeviceSessionGrants.bootstrapCredentialHash,
                  hashCredential(input.bootstrapCredential),
                ),
                eq(
                  relayWorkjetDeviceSessionGrants.businessOsInstanceId,
                  input.businessOsInstanceId,
                ),
                eq(relayWorkjetDeviceSessionGrants.deviceId, input.deviceId),
                isNull(relayWorkjetDeviceSessionGrants.bootstrapConsumedAt),
                isNull(relayWorkjetDeviceSessionGrants.revokedAt),
                gt(relayWorkjetDeviceSessionGrants.bootstrapExpiresAt, nowIso),
              ),
            )
            .returning()
            .pipe(
              Effect.mapError(
                (cause) => new DeviceSessionPersistenceError({ operation: "exchange", cause }),
              ),
            );
          const row = updated[0];
          if (!row) return yield* new DeviceSessionRejected({ reason: "not-found" });
          const grant = rowCandidate(row);
          const access = yield* issueAccess(grant);
          return {
            ...grant,
            accessToken: access.accessToken,
            accessExpiresAt: DateTime.formatIso(access.accessExpiresAt),
            refreshGrant,
            refreshExpiresAt,
          };
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            new DeviceSessionPersistenceError({ operation: "exchange-transaction", cause }),
          ),
        ),
      );
  });

  const renew: DeviceSessions["Service"]["renew"] = Effect.fn(
    "relay.workjet.device_sessions.renew",
  )(function* (input) {
    return yield* transactions
      .withTransaction(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const nowIso = DateTime.formatIso(now);
          const nextRefreshGrant = randomCredential();
          const nextRefreshExpiresAt = DateTime.formatIso(
            DateTime.add(now, DEVICE_SESSION_REFRESH_TTL),
          );
          const updated = yield* db
            .update(relayWorkjetDeviceSessionGrants)
            .set({
              refreshGrantHash: hashCredential(nextRefreshGrant),
              refreshExpiresAt: nextRefreshExpiresAt,
              accessGeneration: sql`${relayWorkjetDeviceSessionGrants.accessGeneration} + 1`,
              updatedAt: nowIso,
            })
            .where(
              and(
                eq(
                  relayWorkjetDeviceSessionGrants.refreshGrantHash,
                  hashCredential(input.refreshGrant),
                ),
                eq(
                  relayWorkjetDeviceSessionGrants.businessOsInstanceId,
                  input.businessOsInstanceId,
                ),
                eq(relayWorkjetDeviceSessionGrants.deviceId, input.deviceId),
                isNull(relayWorkjetDeviceSessionGrants.revokedAt),
                gt(relayWorkjetDeviceSessionGrants.refreshExpiresAt, nowIso),
              ),
            )
            .returning()
            .pipe(
              Effect.mapError(
                (cause) => new DeviceSessionPersistenceError({ operation: "renew", cause }),
              ),
            );
          const row = updated[0];
          if (!row) return yield* new DeviceSessionRejected({ reason: "not-found" });
          const grant = rowCandidate(row);
          const access = yield* issueAccess(grant);
          return {
            ...grant,
            accessToken: access.accessToken,
            accessExpiresAt: DateTime.formatIso(access.accessExpiresAt),
            refreshGrant: nextRefreshGrant,
            refreshExpiresAt: nextRefreshExpiresAt,
          };
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(new DeviceSessionPersistenceError({ operation: "renew-transaction", cause })),
        ),
      );
  });

  const authorizeAccess: DeviceSessions["Service"]["authorizeAccess"] = Effect.fn(
    "relay.workjet.device_sessions.authorize_access",
  )(function* (claims) {
    if (!claims.workjet) return null;
    const rows = yield* db
      .select()
      .from(relayWorkjetDeviceSessionGrants)
      .where(
        and(
          eq(relayWorkjetDeviceSessionGrants.grantId, claims.workjet.grantId),
          eq(relayWorkjetDeviceSessionGrants.relayUserId, claims.sub),
          eq(
            relayWorkjetDeviceSessionGrants.businessOsInstanceId,
            claims.workjet.businessOsInstanceId,
          ),
          eq(relayWorkjetDeviceSessionGrants.deviceId, claims.workjet.deviceId),
          eq(relayWorkjetDeviceSessionGrants.proofKeyThumbprint, claims.cnf.jkt),
          eq(relayWorkjetDeviceSessionGrants.accessGeneration, claims.workjet.accessGeneration),
          isNull(relayWorkjetDeviceSessionGrants.revokedAt),
        ),
      )
      .limit(1)
      .pipe(
        Effect.mapError(
          (cause) => new DeviceSessionPersistenceError({ operation: "authorize-access", cause }),
        ),
      );
    return rows[0] ? rowCandidate(rows[0]) : null;
  });

  return DeviceSessions.of({
    issue,
    revoke: Effect.fn("relay.workjet.device_sessions.revoke")(function* (input) {
      const now = DateTime.formatIso(yield* DateTime.now);
      const updated = yield* db
        .update(relayWorkjetDeviceSessionGrants)
        .set({ revokedAt: now, refreshGrantHash: null, updatedAt: now })
        .where(
          and(
            eq(relayWorkjetDeviceSessionGrants.grantId, input.grantId),
            eq(relayWorkjetDeviceSessionGrants.businessOsInstanceId, input.businessOsInstanceId),
            isNull(relayWorkjetDeviceSessionGrants.revokedAt),
          ),
        )
        .returning({ grantId: relayWorkjetDeviceSessionGrants.grantId })
        .pipe(
          Effect.mapError(
            (cause) => new DeviceSessionPersistenceError({ operation: "revoke", cause }),
          ),
        );
      return updated.length > 0;
    }),
    findBootstrap: (credential) => findByHash({ column: "bootstrap", credential }),
    exchangeBootstrap,
    findRefresh: (credential) => findByHash({ column: "refresh", credential }),
    renew,
    authorizeAccess,
  });
});

export const layer = Layer.effect(DeviceSessions, make);
