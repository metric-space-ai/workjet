// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Schema from "effect/Schema";

import { EnvironmentId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const NoAsciiControlCharacters = Schema.makeFilter((value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return "Value must not contain ASCII control characters.";
    }
  }
  return true;
});

const OpaqueAuthorityId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  NoAsciiControlCharacters,
);

/**
 * Canonical Business OS authority identity.
 *
 * This is deliberately distinct from `CtoxManagedInstance.id`: the latter is
 * a Desktop presentation/launch row whose value changes with its discovery
 * source. Ownership must survive a re-pairing or a different launch source.
 */
export const BusinessOsInstanceId = OpaqueAuthorityId.pipe(Schema.brand("BusinessOsInstanceId"));
export type BusinessOsInstanceId = typeof BusinessOsInstanceId.Type;

/**
 * Optional opaque physical-host identity attested by the server-side authority
 * resolver. A client may never assert this value in an assignment request.
 */
export const WorkjetHostIdentityId = OpaqueAuthorityId.pipe(Schema.brand("WorkjetHostIdentityId"));
export type WorkjetHostIdentityId = typeof WorkjetHostIdentityId.Type;

export const BusinessOsBackendHostingMode = Schema.Literals(["managed", "self-hosted"]);
export type BusinessOsBackendHostingMode = typeof BusinessOsBackendHostingMode.Type;

/**
 * Server-attested facts used to decide whether an assignment would place Code
 * on the Business OS backend host.
 *
 * This shape is not part of `WorkjetBusinessOsComputerAssignInput`. It is
 * resolved behind the server's authority port so hosting mode and host identity
 * can never be supplied as dismissible client flags.
 */
export const WorkjetBusinessOsComputerAssignmentAuthority = Schema.Struct({
  businessOsInstanceId: BusinessOsInstanceId,
  hostingMode: BusinessOsBackendHostingMode,
  backendEnvironmentId: Schema.NullOr(EnvironmentId),
  backendHostIdentityId: Schema.NullOr(WorkjetHostIdentityId),
  computerEnvironmentId: EnvironmentId,
  computerHostIdentityId: Schema.NullOr(WorkjetHostIdentityId),
});
export type WorkjetBusinessOsComputerAssignmentAuthority =
  typeof WorkjetBusinessOsComputerAssignmentAuthority.Type;

export const WorkjetBusinessOsComputerCoLocationRiskConfirmation = Schema.Struct({
  policyVersion: Schema.Literal(1),
  confirmed: Schema.Literal(true),
});
export type WorkjetBusinessOsComputerCoLocationRiskConfirmation =
  typeof WorkjetBusinessOsComputerCoLocationRiskConfirmation.Type;

/** Caller intent only. Authority facts are intentionally unrepresentable. */
export const WorkjetBusinessOsComputerAssignInput = Schema.Struct({
  businessOsInstanceId: BusinessOsInstanceId,
  environmentId: EnvironmentId,
  coLocationRiskConfirmation: Schema.optionalKey(
    WorkjetBusinessOsComputerCoLocationRiskConfirmation,
  ),
});
export type WorkjetBusinessOsComputerAssignInput = typeof WorkjetBusinessOsComputerAssignInput.Type;

export const WorkjetBusinessOsComputerCoLocationRiskAcceptance = Schema.Struct({
  policyVersion: Schema.Literal(1),
  confirmedAtMillis: NonNegativeInt,
});
export type WorkjetBusinessOsComputerCoLocationRiskAcceptance =
  typeof WorkjetBusinessOsComputerCoLocationRiskAcceptance.Type;

export const WorkjetBusinessOsComputerAssignment = Schema.Struct({
  businessOsInstanceId: BusinessOsInstanceId,
  environmentId: EnvironmentId,
  assignedAtMillis: NonNegativeInt,
  coLocationRiskAcceptance: Schema.NullOr(WorkjetBusinessOsComputerCoLocationRiskAcceptance),
});
export type WorkjetBusinessOsComputerAssignment = typeof WorkjetBusinessOsComputerAssignment.Type;

export const WorkjetBusinessOsComputerAssignResult = Schema.Struct({
  assignment: WorkjetBusinessOsComputerAssignment,
  previousBusinessOsInstanceId: Schema.NullOr(BusinessOsInstanceId),
});
export type WorkjetBusinessOsComputerAssignResult =
  typeof WorkjetBusinessOsComputerAssignResult.Type;

/** Server-filtered inventory row safe to present in the assignment picker. */
export const WorkjetBusinessOsComputerCandidate = Schema.Struct({
  environmentId: EnvironmentId,
  currentBusinessOsInstanceId: Schema.NullOr(BusinessOsInstanceId),
  requiresCoLocationRiskConfirmation: Schema.Boolean,
});
export type WorkjetBusinessOsComputerCandidate = typeof WorkjetBusinessOsComputerCandidate.Type;

export const WorkjetBusinessOsComputerListInput = Schema.Struct({
  businessOsInstanceId: BusinessOsInstanceId,
});
export type WorkjetBusinessOsComputerListInput = typeof WorkjetBusinessOsComputerListInput.Type;

export const WorkjetBusinessOsComputerListResult = Schema.Struct({
  businessOsInstanceId: BusinessOsInstanceId,
  assigned: Schema.Array(WorkjetBusinessOsComputerAssignment).check(Schema.isMaxLength(1_000)),
  available: Schema.Array(WorkjetBusinessOsComputerCandidate).check(Schema.isMaxLength(1_000)),
});
export type WorkjetBusinessOsComputerListResult = typeof WorkjetBusinessOsComputerListResult.Type;

export const WorkjetBusinessOsComputerUnassignInput = Schema.Struct({
  businessOsInstanceId: BusinessOsInstanceId,
  environmentId: EnvironmentId,
});
export type WorkjetBusinessOsComputerUnassignInput =
  typeof WorkjetBusinessOsComputerUnassignInput.Type;

export const WorkjetBusinessOsComputerUnassignResult = Schema.Struct({
  businessOsInstanceId: BusinessOsInstanceId,
  environmentId: EnvironmentId,
  unassigned: Schema.Boolean,
});
export type WorkjetBusinessOsComputerUnassignResult =
  typeof WorkjetBusinessOsComputerUnassignResult.Type;

export const WorkjetBusinessOsComputerOwnershipFailureReason = Schema.Literals([
  "authority-unavailable",
  "managed-backend-host",
  "colocation-confirmation-required",
]);
export type WorkjetBusinessOsComputerOwnershipFailureReason =
  typeof WorkjetBusinessOsComputerOwnershipFailureReason.Type;

export class WorkjetBusinessOsComputerOwnershipError extends Schema.TaggedErrorClass<WorkjetBusinessOsComputerOwnershipError>()(
  "WorkjetBusinessOsComputerOwnershipError",
  { reason: WorkjetBusinessOsComputerOwnershipFailureReason },
) {
  override get message(): string {
    switch (this.reason) {
      case "managed-backend-host":
        return "A managed Business OS backend host cannot be assigned as a Code computer.";
      case "colocation-confirmation-required":
        return "Self-hosted backend and Code computer co-location requires explicit confirmation.";
      case "authority-unavailable":
        return "The server could not establish authoritative backend-host identity.";
    }
  }
}
