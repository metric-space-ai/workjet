import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { and, eq } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import {
  relayWorkjetBusinessOsEnvironments,
  relayWorkjetBusinessOsInstances,
} from "../persistence/schema.ts";

export interface BusinessOsMembershipSnapshot {
  readonly businessOsInstanceId: string;
  readonly relayUserId: string;
  readonly membershipVersion: number;
  readonly environmentIds: ReadonlyArray<string>;
}

export class BusinessOsMembershipConflict extends Schema.TaggedErrorClass<BusinessOsMembershipConflict>()(
  "BusinessOsMembershipConflict",
  { reason: Schema.Literals(["owner-mismatch", "stale-version", "version-conflict"]) },
) {}

export class BusinessOsMembershipPersistenceError extends Schema.TaggedErrorClass<BusinessOsMembershipPersistenceError>()(
  "BusinessOsMembershipPersistenceError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class BusinessOsMemberships extends Context.Service<
  BusinessOsMemberships,
  {
    readonly replace: (
      input: BusinessOsMembershipSnapshot,
    ) => Effect.Effect<
      BusinessOsMembershipSnapshot,
      BusinessOsMembershipConflict | BusinessOsMembershipPersistenceError
    >;
    readonly read: (input: {
      readonly businessOsInstanceId: string;
      readonly relayUserId: string;
    }) => Effect.Effect<BusinessOsMembershipSnapshot | null, BusinessOsMembershipPersistenceError>;
    readonly isMember: (input: {
      readonly businessOsInstanceId: string;
      readonly relayUserId: string;
      readonly environmentId: string;
    }) => Effect.Effect<boolean, BusinessOsMembershipPersistenceError>;
  }
>()("t3code-relay/workjet/BusinessOsMemberships") {}

function sameSet(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

export function normalizeMembershipEnvironmentIds(
  environmentIds: ReadonlyArray<string>,
): ReadonlyArray<string> | null {
  const normalized = [...new Set(environmentIds)].sort();
  return normalized.length === environmentIds.length ? normalized : null;
}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const transactions = yield* RelayDb.RelayTransactions;

  const read: BusinessOsMemberships["Service"]["read"] = Effect.fn(
    "relay.workjet.memberships.read",
  )(function* (input) {
    const roots = yield* db
      .select({
        relayUserId: relayWorkjetBusinessOsInstances.relayUserId,
        membershipVersion: relayWorkjetBusinessOsInstances.membershipVersion,
      })
      .from(relayWorkjetBusinessOsInstances)
      .where(eq(relayWorkjetBusinessOsInstances.businessOsInstanceId, input.businessOsInstanceId))
      .limit(1)
      .pipe(
        Effect.mapError(
          (cause) => new BusinessOsMembershipPersistenceError({ operation: "read-root", cause }),
        ),
      );
    const root = roots[0];
    if (!root || root.relayUserId !== input.relayUserId) return null;
    const rows = yield* db
      .select({ environmentId: relayWorkjetBusinessOsEnvironments.environmentId })
      .from(relayWorkjetBusinessOsEnvironments)
      .where(
        eq(relayWorkjetBusinessOsEnvironments.businessOsInstanceId, input.businessOsInstanceId),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new BusinessOsMembershipPersistenceError({ operation: "read-environments", cause }),
        ),
      );
    return {
      businessOsInstanceId: input.businessOsInstanceId,
      relayUserId: root.relayUserId,
      membershipVersion: root.membershipVersion,
      environmentIds: rows.map((row) => row.environmentId).sort(),
    };
  });

  const replace: BusinessOsMemberships["Service"]["replace"] = Effect.fn(
    "relay.workjet.memberships.replace",
  )(function* (input) {
    const uniqueEnvironmentIds = normalizeMembershipEnvironmentIds(input.environmentIds);
    if (uniqueEnvironmentIds === null) {
      return yield* new BusinessOsMembershipConflict({ reason: "version-conflict" });
    }
    return yield* transactions
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* read({
            businessOsInstanceId: input.businessOsInstanceId,
            relayUserId: input.relayUserId,
          });
          const anyOwner = yield* db
            .select({ relayUserId: relayWorkjetBusinessOsInstances.relayUserId })
            .from(relayWorkjetBusinessOsInstances)
            .where(
              eq(relayWorkjetBusinessOsInstances.businessOsInstanceId, input.businessOsInstanceId),
            )
            .limit(1)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new BusinessOsMembershipPersistenceError({ operation: "replace-owner", cause }),
              ),
            );
          if (anyOwner[0] && anyOwner[0].relayUserId !== input.relayUserId) {
            return yield* new BusinessOsMembershipConflict({ reason: "owner-mismatch" });
          }
          if (current) {
            if (input.membershipVersion < current.membershipVersion) {
              return yield* new BusinessOsMembershipConflict({ reason: "stale-version" });
            }
            if (input.membershipVersion === current.membershipVersion) {
              if (!sameSet(uniqueEnvironmentIds, current.environmentIds)) {
                return yield* new BusinessOsMembershipConflict({ reason: "version-conflict" });
              }
              return current;
            }
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* db
            .insert(relayWorkjetBusinessOsInstances)
            .values({
              businessOsInstanceId: input.businessOsInstanceId,
              relayUserId: input.relayUserId,
              membershipVersion: input.membershipVersion,
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: relayWorkjetBusinessOsInstances.businessOsInstanceId,
              set: { membershipVersion: input.membershipVersion, updatedAt: now },
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new BusinessOsMembershipPersistenceError({ operation: "replace-root", cause }),
              ),
            );
          yield* db
            .delete(relayWorkjetBusinessOsEnvironments)
            .where(
              eq(
                relayWorkjetBusinessOsEnvironments.businessOsInstanceId,
                input.businessOsInstanceId,
              ),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new BusinessOsMembershipPersistenceError({ operation: "replace-delete", cause }),
              ),
            );
          if (uniqueEnvironmentIds.length > 0) {
            yield* db
              .insert(relayWorkjetBusinessOsEnvironments)
              .values(
                uniqueEnvironmentIds.map((environmentId) => ({
                  businessOsInstanceId: input.businessOsInstanceId,
                  environmentId,
                  createdAt: now,
                })),
              )
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new BusinessOsMembershipPersistenceError({
                      operation: "replace-insert",
                      cause,
                    }),
                ),
              );
          }
          return {
            ...input,
            environmentIds: uniqueEnvironmentIds,
          };
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", (cause) =>
          Effect.fail(
            new BusinessOsMembershipPersistenceError({ operation: "replace-transaction", cause }),
          ),
        ),
      );
  });

  const isMember: BusinessOsMemberships["Service"]["isMember"] = Effect.fn(
    "relay.workjet.memberships.is_member",
  )(function* (input) {
    const rows = yield* db
      .select({ environmentId: relayWorkjetBusinessOsEnvironments.environmentId })
      .from(relayWorkjetBusinessOsEnvironments)
      .innerJoin(
        relayWorkjetBusinessOsInstances,
        eq(
          relayWorkjetBusinessOsEnvironments.businessOsInstanceId,
          relayWorkjetBusinessOsInstances.businessOsInstanceId,
        ),
      )
      .where(
        and(
          eq(relayWorkjetBusinessOsEnvironments.businessOsInstanceId, input.businessOsInstanceId),
          eq(relayWorkjetBusinessOsEnvironments.environmentId, input.environmentId),
          eq(relayWorkjetBusinessOsInstances.relayUserId, input.relayUserId),
        ),
      )
      .limit(1)
      .pipe(
        Effect.mapError(
          (cause) => new BusinessOsMembershipPersistenceError({ operation: "is-member", cause }),
        ),
      );
    return rows.length === 1;
  });

  return BusinessOsMemberships.of({ replace, read, isMember });
});

export const layer = Layer.effect(BusinessOsMemberships, make);
