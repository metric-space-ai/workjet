// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics preferSchemaOverJson:off -- assertions inspect the public JSON-safe response shape and forbidden secret field names.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as References from "./WorkjetDeviceInviteReferenceService.ts";

const NOW = Date.parse("2099-08-27T12:00:00.000Z");
const EXPIRES_AT = "2099-08-27T12:05:00.000Z";
const RATE_LIMIT_BUCKETS = 64 ** 2;

const randomBytesFactory = () => {
  let call = 0;
  return (size: number) => {
    call += 1;
    return new Uint8Array(size).fill(call % 256);
  };
};

const withDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  effect.pipe(Effect.provide(NodeSqliteClient.layerMemory()));

const prepare = (nowEpochMs: () => number = () => NOW) =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 58 });
    return yield* References.make({ nowEpochMs, randomBytes: randomBytesFactory() });
  });

type ReferenceService = Effect.Success<ReturnType<typeof References.make>>;

const issue = (service: ReferenceService) =>
  service.issue({
    endpoint: "https://workjet.example.test",
    expiresAt: EXPIRES_AT,
    businessOsInstanceId: "business-os-a",
  });

const binding = (overrides: Partial<References.WorkjetDeviceBindingRecord> = {}) => ({
  devicePairingId: "pairing-a",
  deviceId: "device-a",
  proofKeyThumbprint: "thumbprint-a",
  businessOsInstanceId: "business-os-a",
  environmentPairingLinkId: "environment-link-a",
  ctoxInviteId: "ctox-invite-a",
  createdAtMs: NOW,
  ...overrides,
});

describe("WorkjetDeviceInviteReferenceService", () => {
  it.effect("issues a secret-free reference and stores only a hash plus intent", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const service = yield* prepare();
        const result = yield* issue(service);

        assert.deepEqual(Object.keys(result).sort(), ["inviteId", "reference"]);
        assert.deepEqual(Object.keys(result.reference).sort(), [
          "code",
          "endpoint",
          "expires_at",
          "type",
          "version",
        ]);
        assert.equal(result.reference.code.length, 43);
        assert.equal(result.reference.endpoint, "https://workjet.example.test");

        const serialized = JSON.stringify(result);
        assert.notProperty(result, "invite");
        for (const secretName of [
          "bootstrap-secret",
          "room-secret",
          "capability-secret",
          "bootstrap_credential",
          "signaling_room_password",
          "capability_token",
          "sync_room",
        ]) {
          assert.notInclude(serialized, secretName);
        }

        const rows = yield* sql<{
          readonly inviteId: string;
          readonly codeHash: string;
          readonly endpoint: string;
          readonly businessOsInstanceId: string;
        }>`
          SELECT
            invite_id AS "inviteId",
            code_hash AS "codeHash",
            endpoint,
            business_os_instance_id AS "businessOsInstanceId"
          FROM workjet_device_invite_references
        `;
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.inviteId, result.inviteId);
        assert.notEqual(rows[0]?.codeHash, result.reference.code);
        assert.equal(rows[0]?.codeHash.length, 43);
        assert.equal(rows[0]?.endpoint, result.reference.endpoint);
        assert.equal(rows[0]?.businessOsInstanceId, "business-os-a");
      }),
    ),
  );

  it.effect("consumes a reference exactly once, including a concurrent redemption race", () =>
    withDatabase(
      Effect.gen(function* () {
        const service = yield* prepare();
        const result = yield* issue(service);

        const attempts = yield* Effect.all(
          [
            Effect.exit(
              service.consume({ code: result.reference.code, rateLimitKey: "race-client-a" }),
            ),
            Effect.exit(
              service.consume({ code: result.reference.code, rateLimitKey: "race-client-b" }),
            ),
          ],
          { concurrency: "unbounded" },
        );
        assert.equal(attempts.filter((attempt) => attempt._tag === "Success").length, 1);
        assert.equal(attempts.filter((attempt) => attempt._tag === "Failure").length, 1);

        const replay = yield* Effect.flip(
          service.consume({ code: result.reference.code, rateLimitKey: "race-client-c" }),
        );
        assert.equal(replay.reason, "rejected");
      }),
    ),
  );

  it.effect("rejects revoked and expired references without exposing secret material", () => {
    let now = NOW;
    return withDatabase(
      Effect.gen(function* () {
        const service = yield* prepare(() => now);
        const revoked = yield* issue(service);
        assert.deepEqual(yield* service.beginRevocation(revoked.inviteId), { _tag: "pending" });
        const revokedError = yield* Effect.flip(
          service.consume({ code: revoked.reference.code, rateLimitKey: "revoked-client" }),
        );
        assert.equal(revokedError.reason, "rejected");
        assert.notInclude(revokedError.message, "signaling_room_password");

        const expired = yield* issue(service);
        now = Date.parse(EXPIRES_AT) + 1;
        const expiredError = yield* Effect.flip(
          service.consume({ code: expired.reference.code, rateLimitKey: "expired-client" }),
        );
        assert.equal(expiredError.reason, "rejected");
        assert.notInclude(expiredError.message, expired.reference.code);
      }),
    );
  });

  it.effect("keeps references and bindings durable when the service is recreated", () =>
    withDatabase(
      Effect.gen(function* () {
        const firstService = yield* prepare();
        const created = yield* issue(firstService);
        const secondService = yield* References.make({
          nowEpochMs: () => NOW,
          randomBytes: randomBytesFactory(),
        });

        const intent = yield* secondService.consume({
          code: created.reference.code,
          rateLimitKey: "restart-client",
        });
        assert.equal(intent.inviteId, created.inviteId);
        assert.equal(intent.businessOsInstanceId, "business-os-a");

        yield* secondService.complete(binding());
        const thirdService = yield* References.make({ nowEpochMs: () => NOW });
        assert.deepEqual(yield* thirdService.listBindings("business-os-a"), [binding()]);
      }),
    ),
  );

  it.effect("bounds rate-limit state and caps repeated attempts per bucket", () =>
    withDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const service = yield* prepare();
        const key = "same-client";
        for (let attempt = 0; attempt < 12; attempt += 1) {
          const error = yield* Effect.flip(
            service.consume({ code: "not-a-valid-code", rateLimitKey: key }),
          );
          assert.equal(error.reason, "rejected");
        }
        const limited = yield* Effect.flip(
          service.consume({ code: "not-a-valid-code", rateLimitKey: key }),
        );
        assert.equal(limited.reason, "rate_limited");

        const keys = Array.from({ length: 5_000 }, (_, index) => `rotating-client-${index}`);
        yield* Effect.all(
          keys.map((rateLimitKey) =>
            service.consume({ code: "another-invalid-code", rateLimitKey }).pipe(Effect.exit),
          ),
          { concurrency: "unbounded" },
        );
        const rows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS "count" FROM workjet_device_invite_rate_limits
        `;
        assert.isAtMost(rows[0]?.count ?? Number.POSITIVE_INFINITY, RATE_LIMIT_BUCKETS);
        assert.isAbove(rows[0]?.count ?? 0, 1);
      }),
    ),
  );

  it.effect("enforces exact device-to-instance replacement and revocation", () =>
    withDatabase(
      Effect.gen(function* () {
        const service = yield* prepare();
        const first = binding();
        const replacement = binding({
          devicePairingId: "pairing-b",
          proofKeyThumbprint: "thumbprint-b",
          environmentPairingLinkId: "environment-link-b",
          ctoxInviteId: "ctox-invite-b",
          createdAtMs: NOW + 1,
        });
        const otherInstance = binding({
          devicePairingId: "pairing-c",
          businessOsInstanceId: "business-os-b",
          environmentPairingLinkId: "environment-link-c",
          ctoxInviteId: "ctox-invite-c",
        });

        assert.isNull(yield* service.complete(first));
        assert.deepEqual(yield* service.complete(replacement), first);
        assert.isNull(yield* service.complete(otherInstance));
        assert.deepEqual(yield* service.listBindings("business-os-a"), [replacement]);
        assert.deepEqual(yield* service.listBindings("business-os-b"), [otherInstance]);

        assert.deepEqual(yield* service.beginRevocation(first.devicePairingId), {
          _tag: "missing",
        });
        const revokePlan = yield* service.beginRevocation(replacement.devicePairingId);
        assert.deepEqual(revokePlan, { _tag: "binding", binding: replacement });
        assert.deepEqual(
          yield* service.listBindings("business-os-a"),
          [replacement],
          "a downstream revoke can be retried while the edge remains active",
        );
        assert.isTrue(yield* service.finalizeBindingRevocation(replacement.devicePairingId));
        assert.isFalse(yield* service.finalizeBindingRevocation(replacement.devicePairingId));
        assert.deepEqual(yield* service.listBindings("business-os-a"), []);
        assert.deepEqual(yield* service.listBindings("business-os-b"), [otherInstance]);

        assert.deepEqual(yield* service.beginRevocation(otherInstance.devicePairingId), {
          _tag: "binding",
          binding: otherInstance,
        });
        assert.deepEqual(yield* service.listBindings("business-os-b"), [otherInstance]);
        assert.isTrue(yield* service.finalizeBindingRevocation(otherInstance.devicePairingId));
        assert.deepEqual(yield* service.listBindings("business-os-b"), []);
      }),
    ),
  );
});
