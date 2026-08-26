// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  BusinessOsInstanceId,
  EnvironmentId,
  WorkjetBusinessOsComputerOwnershipError,
  type WorkjetBusinessOsComputerAssignInput,
  type WorkjetBusinessOsComputerAssignResult,
  type WorkjetBusinessOsComputerAssignment,
  type WorkjetBusinessOsComputerAssignmentAuthority,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

/**
 * The trusted, server-side source of instance and host facts.
 *
 * No live implementation is invented in this slice. Desktop/CTOX integration
 * must later provide one from authoritative discovery or an attestation. In
 * particular, an RPC payload or renderer state must never implement this port.
 */
export interface WorkjetBusinessOsComputerAuthorityResolverShape {
  readonly resolve: (input: {
    readonly businessOsInstanceId: BusinessOsInstanceId;
    readonly environmentId: EnvironmentId;
  }) => Effect.Effect<
    WorkjetBusinessOsComputerAssignmentAuthority,
    WorkjetBusinessOsComputerOwnershipError
  >;
}

export class WorkjetBusinessOsComputerAuthorityResolver extends Context.Service<
  WorkjetBusinessOsComputerAuthorityResolver,
  WorkjetBusinessOsComputerAuthorityResolverShape
>()(
  "t3/workjet/businessOs/WorkjetBusinessOsComputerOwnershipStore/WorkjetBusinessOsComputerAuthorityResolver",
) {}

export type WorkjetBusinessOsComputerOwnershipStoreError =
  | WorkjetBusinessOsComputerOwnershipError
  | PersistenceSqlError
  | PersistenceDecodeError;

export interface WorkjetBusinessOsComputerOwnershipStoreShape {
  /** Atomically create or replace one environment's sole Business OS owner. */
  readonly assign: (
    input: WorkjetBusinessOsComputerAssignInput,
  ) => Effect.Effect<
    WorkjetBusinessOsComputerAssignResult,
    WorkjetBusinessOsComputerOwnershipStoreError
  >;

  readonly getByEnvironment: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<
    Option.Option<WorkjetBusinessOsComputerAssignment>,
    PersistenceSqlError | PersistenceDecodeError
  >;

  readonly listByInstance: (
    businessOsInstanceId: BusinessOsInstanceId,
  ) => Effect.Effect<
    ReadonlyArray<WorkjetBusinessOsComputerAssignment>,
    PersistenceSqlError | PersistenceDecodeError
  >;
}

export class WorkjetBusinessOsComputerOwnershipStore extends Context.Service<
  WorkjetBusinessOsComputerOwnershipStore,
  WorkjetBusinessOsComputerOwnershipStoreShape
>()("t3/workjet/businessOs/WorkjetBusinessOsComputerOwnershipStore") {}

const OwnershipRow = Schema.Struct({
  businessOsInstanceId: BusinessOsInstanceId,
  environmentId: EnvironmentId,
  assignedAtMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  colocationRiskPolicyVersion: Schema.NullOr(Schema.Int),
  colocationRiskAcceptedAtMillis: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
type OwnershipRow = typeof OwnershipRow.Type;

const OWNERSHIP_COLUMNS = `
  business_os_instance_id AS "businessOsInstanceId",
  environment_id AS "environmentId",
  assigned_at_ms AS "assignedAtMillis",
  colocation_risk_policy_version AS "colocationRiskPolicyVersion",
  colocation_risk_accepted_at_ms AS "colocationRiskAcceptedAtMillis"
`;

const sqlFailure = (operation: string) => (cause: unknown) =>
  new PersistenceSqlError({ operation, cause });
const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);

const unavailable = () =>
  new WorkjetBusinessOsComputerOwnershipError({ reason: "authority-unavailable" });

type CoLocation = "co-located" | "external" | "ambiguous";

/**
 * Compare only attested identifiers. Hostnames, presentation kinds and CTOX
 * discovery-source labels are deliberately absent.
 */
function classifyCoLocation(authority: WorkjetBusinessOsComputerAssignmentAuthority): CoLocation {
  const sameEnvironment =
    authority.backendEnvironmentId !== null &&
    authority.backendEnvironmentId === authority.computerEnvironmentId;
  const backendHost = authority.backendHostIdentityId;
  const computerHost = authority.computerHostIdentityId;

  if (sameEnvironment) {
    // Two physical identities that contradict an identical environment make
    // the authority snapshot inconsistent; fail closed instead of choosing one.
    if (backendHost !== null && computerHost !== null && backendHost !== computerHost) {
      return "ambiguous";
    }
    return "co-located";
  }

  if (backendHost !== null) {
    if (computerHost === null) return "ambiguous";
    return backendHost === computerHost ? "co-located" : "external";
  }

  // An explicit, different backend environment is the minimal authoritative
  // external-host fact. Without either identity the server cannot decide.
  return authority.backendEnvironmentId === null ? "ambiguous" : "external";
}

function assertAuthorityMatches(
  input: WorkjetBusinessOsComputerAssignInput,
  authority: WorkjetBusinessOsComputerAssignmentAuthority,
): Effect.Effect<void, WorkjetBusinessOsComputerOwnershipError> {
  if (
    authority.businessOsInstanceId !== input.businessOsInstanceId ||
    authority.computerEnvironmentId !== input.environmentId
  ) {
    return Effect.fail(unavailable());
  }
  return Effect.void;
}

function acceptedRiskPolicy(
  input: WorkjetBusinessOsComputerAssignInput,
  authority: WorkjetBusinessOsComputerAssignmentAuthority,
): Effect.Effect<1 | null, WorkjetBusinessOsComputerOwnershipError> {
  // The authoritative managed backend environment is an unconditional deny.
  // Even a contradictory optional physical-host fact cannot downgrade it to a
  // warning or make a client confirmation relevant.
  if (
    authority.hostingMode === "managed" &&
    authority.backendEnvironmentId !== null &&
    authority.backendEnvironmentId === authority.computerEnvironmentId
  ) {
    return Effect.fail(
      new WorkjetBusinessOsComputerOwnershipError({ reason: "managed-backend-host" }),
    );
  }

  const coLocation = classifyCoLocation(authority);
  if (coLocation === "ambiguous") return Effect.fail(unavailable());
  if (coLocation === "external") return Effect.succeed(null);

  if (authority.hostingMode === "managed") {
    return Effect.fail(
      new WorkjetBusinessOsComputerOwnershipError({ reason: "managed-backend-host" }),
    );
  }
  if (
    input.coLocationRiskConfirmation?.policyVersion !== 1 ||
    input.coLocationRiskConfirmation.confirmed !== true
  ) {
    return Effect.fail(
      new WorkjetBusinessOsComputerOwnershipError({
        reason: "colocation-confirmation-required",
      }),
    );
  }
  return Effect.succeed(1);
}

function assignmentFromRow(
  row: OwnershipRow,
): Effect.Effect<WorkjetBusinessOsComputerAssignment, PersistenceDecodeError> {
  const riskVersion = row.colocationRiskPolicyVersion;
  const riskAcceptedAt = row.colocationRiskAcceptedAtMillis;
  if (
    (riskVersion === null && riskAcceptedAt !== null) ||
    (riskVersion !== null && (riskVersion !== 1 || riskAcceptedAt === null))
  ) {
    return Effect.fail(
      new PersistenceDecodeError({
        operation: "WorkjetBusinessOsComputerOwnershipStore.decodeRow",
        issue: "Invalid co-location risk evidence",
      }),
    );
  }
  return Effect.succeed({
    businessOsInstanceId: row.businessOsInstanceId,
    environmentId: row.environmentId,
    assignedAtMillis: row.assignedAtMillis,
    coLocationRiskAcceptance:
      riskVersion === 1 && riskAcceptedAt !== null
        ? { policyVersion: 1, confirmedAtMillis: riskAcceptedAt }
        : null,
  });
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const authorityResolver = yield* WorkjetBusinessOsComputerAuthorityResolver;

  const decodeRow = (
    row: unknown,
  ): Effect.Effect<WorkjetBusinessOsComputerAssignment, PersistenceDecodeError> =>
    Schema.decodeUnknownEffect(OwnershipRow)(row).pipe(
      Effect.mapError((cause) =>
        PersistenceDecodeError.fromSchemaError(
          "WorkjetBusinessOsComputerOwnershipStore.decodeRow",
          cause,
        ),
      ),
      Effect.flatMap(assignmentFromRow),
    );

  const getByEnvironment: WorkjetBusinessOsComputerOwnershipStoreShape["getByEnvironment"] = (
    environmentId,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql
        .unsafe(
          `
            SELECT ${OWNERSHIP_COLUMNS}
            FROM workjet_business_os_computer_owners
            WHERE environment_id = ?
          `,
          [environmentId],
        )
        .pipe(
          Effect.mapError(
            sqlFailure("WorkjetBusinessOsComputerOwnershipStore.getByEnvironment:select"),
          ),
        );
      const row = rows[0];
      return row === undefined ? Option.none() : Option.some(yield* decodeRow(row));
    });

  const listByInstance: WorkjetBusinessOsComputerOwnershipStoreShape["listByInstance"] = (
    businessOsInstanceId,
  ) =>
    Effect.gen(function* () {
      const rows = yield* sql
        .unsafe(
          `
            SELECT ${OWNERSHIP_COLUMNS}
            FROM workjet_business_os_computer_owners
            WHERE business_os_instance_id = ?
            ORDER BY environment_id ASC
          `,
          [businessOsInstanceId],
        )
        .pipe(
          Effect.mapError(
            sqlFailure("WorkjetBusinessOsComputerOwnershipStore.listByInstance:select"),
          ),
        );
      return yield* Effect.forEach(rows, decodeRow);
    });

  const assign: WorkjetBusinessOsComputerOwnershipStoreShape["assign"] = (input) =>
    Effect.gen(function* () {
      const authority = yield* authorityResolver.resolve({
        businessOsInstanceId: input.businessOsInstanceId,
        environmentId: input.environmentId,
      });
      yield* assertAuthorityMatches(input, authority);
      const riskPolicyVersion = yield* acceptedRiskPolicy(input, authority);
      const assignedAtMillis = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
      const riskAcceptedAtMillis = riskPolicyVersion === null ? null : assignedAtMillis;

      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const previousRows = yield* sql<{
              readonly businessOsInstanceId: BusinessOsInstanceId;
            }>`
              SELECT business_os_instance_id AS "businessOsInstanceId"
              FROM workjet_business_os_computer_owners
              WHERE environment_id = ${input.environmentId}
            `;
            const previousBusinessOsInstanceId = previousRows[0]?.businessOsInstanceId ?? null;

            const rows = yield* sql`
              INSERT INTO workjet_business_os_computer_owners (
                environment_id,
                business_os_instance_id,
                assigned_at_ms,
                colocation_risk_policy_version,
                colocation_risk_accepted_at_ms
              ) VALUES (
                ${input.environmentId},
                ${input.businessOsInstanceId},
                ${assignedAtMillis},
                ${riskPolicyVersion},
                ${riskAcceptedAtMillis}
              )
              ON CONFLICT(environment_id) DO UPDATE SET
                business_os_instance_id = excluded.business_os_instance_id,
                assigned_at_ms = excluded.assigned_at_ms,
                colocation_risk_policy_version = excluded.colocation_risk_policy_version,
                colocation_risk_accepted_at_ms = excluded.colocation_risk_accepted_at_ms
              RETURNING
                business_os_instance_id AS "businessOsInstanceId",
                environment_id AS "environmentId",
                assigned_at_ms AS "assignedAtMillis",
                colocation_risk_policy_version AS "colocationRiskPolicyVersion",
                colocation_risk_accepted_at_ms AS "colocationRiskAcceptedAtMillis"
            `;
            const row = rows[0];
            if (row === undefined) {
              return yield* new PersistenceDecodeError({
                operation: "WorkjetBusinessOsComputerOwnershipStore.assign:returning",
                issue: "Assignment write returned no row",
              });
            }
            return {
              assignment: yield* decodeRow(row),
              previousBusinessOsInstanceId,
            } satisfies WorkjetBusinessOsComputerAssignResult;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isPersistenceDecodeError(cause)
              ? cause
              : sqlFailure("WorkjetBusinessOsComputerOwnershipStore.assign:transaction")(cause),
          ),
        );
    });

  return {
    assign,
    getByEnvironment,
    listByInstance,
  } satisfies WorkjetBusinessOsComputerOwnershipStoreShape;
});

export const WorkjetBusinessOsComputerOwnershipStoreLive = Layer.effect(
  WorkjetBusinessOsComputerOwnershipStore,
  make,
);
