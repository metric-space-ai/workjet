// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

import {
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentScopeRequiredError,
} from "./environmentHttp.ts";
import {
  WorkjetBusinessOsComputerAssignInput,
  WorkjetBusinessOsComputerAssignResult,
  WorkjetBusinessOsComputerListInput,
  WorkjetBusinessOsComputerListResult,
  WorkjetBusinessOsComputerUnassignInput,
  WorkjetBusinessOsComputerUnassignResult,
} from "./workjetBusinessOsComputers.ts";

export const WorkjetBusinessOsComputerMembershipPolicyReason = Schema.Literals([
  "managed-backend-host",
  "colocation-confirmation-required",
]);
export type WorkjetBusinessOsComputerMembershipPolicyReason =
  typeof WorkjetBusinessOsComputerMembershipPolicyReason.Type;

export class WorkjetBusinessOsComputerMembershipPolicyError extends Schema.TaggedErrorClass<WorkjetBusinessOsComputerMembershipPolicyError>()(
  "WorkjetBusinessOsComputerMembershipPolicyError",
  {
    code: Schema.Literal("computer_membership_rejected"),
    reason: WorkjetBusinessOsComputerMembershipPolicyReason,
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(WorkjetBusinessOsComputerMembershipPolicyError)(this, {
      status: 409,
    });
  }

  override get message(): string {
    return this.reason === "managed-backend-host"
      ? "A managed Business OS backend host cannot be assigned as a Code computer."
      : "Self-hosted backend and Code computer co-location requires explicit confirmation.";
  }
}

export class WorkjetBusinessOsComputerMembershipAuthorityUnavailableError extends Schema.TaggedErrorClass<WorkjetBusinessOsComputerMembershipAuthorityUnavailableError>()(
  "WorkjetBusinessOsComputerMembershipAuthorityUnavailableError",
  { code: Schema.Literal("computer_membership_authority_unavailable") },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(
      WorkjetBusinessOsComputerMembershipAuthorityUnavailableError,
    )(this, { status: 503 });
  }

  override get message(): string {
    return "The server could not establish authoritative computer membership facts.";
  }
}

export class WorkjetBusinessOsComputerMembershipInternalError extends Schema.TaggedErrorClass<WorkjetBusinessOsComputerMembershipInternalError>()(
  "WorkjetBusinessOsComputerMembershipInternalError",
  { code: Schema.Literal("computer_membership_failed") },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(WorkjetBusinessOsComputerMembershipInternalError)(this, {
      status: 500,
    });
  }

  override get message(): string {
    return "The server could not complete the computer membership operation.";
  }
}

const OptionalBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
  dpop: Schema.optionalKey(Schema.String),
});

const ReadErrors = [
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentScopeRequiredError,
  WorkjetBusinessOsComputerMembershipAuthorityUnavailableError,
  WorkjetBusinessOsComputerMembershipInternalError,
  WorkjetBusinessOsComputerMembershipPolicyError,
] as const;

export class WorkjetBusinessOsComputerMembershipHttpGroup extends HttpApiGroup.make(
  "businessOsComputers",
)
  .add(
    HttpApiEndpoint.post("list", "/api/workjet/business-os/computers/list", {
      headers: OptionalBearerHeaders,
      payload: WorkjetBusinessOsComputerListInput,
      success: WorkjetBusinessOsComputerListResult,
      error: ReadErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("assign", "/api/workjet/business-os/computers/assign", {
      headers: OptionalBearerHeaders,
      payload: WorkjetBusinessOsComputerAssignInput,
      success: WorkjetBusinessOsComputerAssignResult,
      error: ReadErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  )
  .add(
    HttpApiEndpoint.post("unassign", "/api/workjet/business-os/computers/unassign", {
      headers: OptionalBearerHeaders,
      payload: WorkjetBusinessOsComputerUnassignInput,
      success: WorkjetBusinessOsComputerUnassignResult,
      error: ReadErrors,
    }).middleware(EnvironmentAuthenticatedAuth),
  ) {}

/** Standalone scaffold; it is not added to EnvironmentHttpApi until an authority adapter exists. */
export class WorkjetBusinessOsComputerMembershipHttpApi extends HttpApi.make(
  "workjetBusinessOsComputerMembership",
).add(WorkjetBusinessOsComputerMembershipHttpGroup) {}
