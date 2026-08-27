// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Schema from "effect/Schema";
import * as HttpServerRespondable from "effect/unstable/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  WorkjetDeviceBindingListResult,
  WorkjetDeviceInviteCreateResult,
  WorkjetDeviceInviteRevokeResult,
} from "./ctox.ts";
import { BusinessOsInstanceId } from "./workjetBusinessOsComputers.ts";

const OpaqueBase64Url = Schema.String.check(
  Schema.isMinLength(43),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);

const Rfc3339Timestamp = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/),
);

/**
 * Short-lived, possession-bound handle into one managed Business OS control plane.
 *
 * The producer generates at least 256 random bits. The value is scoped server-side
 * to the authenticated Workjet user session, installation identity, DPoP key and
 * canonical Business OS authority identity. It is never an Environment/Computer id.
 */
export const WorkjetManagedBackendControlConnectionId = OpaqueBase64Url.pipe(
  Schema.brand("WorkjetManagedBackendControlConnectionId"),
);
export type WorkjetManagedBackendControlConnectionId =
  typeof WorkjetManagedBackendControlConnectionId.Type;

export const WorkjetInstallationId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
).pipe(Schema.brand("WorkjetInstallationId"));
export type WorkjetInstallationId = typeof WorkjetInstallationId.Type;

/** Maximum lifetime of a managed control handle. Producers may issue shorter handles. */
export const WORKJET_MANAGED_BACKEND_CONTROL_MAX_TTL_SECONDS = 600;

/** Mandatory producer response headers for every resolve/list/create/revoke response. */
export const WORKJET_MANAGED_BACKEND_CONTROL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
} as const;

export const WorkjetManagedBackendControlResolveInput = Schema.Struct({
  businessOsInstanceId: BusinessOsInstanceId,
  workjetInstallationId: WorkjetInstallationId,
});
export type WorkjetManagedBackendControlResolveInput =
  typeof WorkjetManagedBackendControlResolveInput.Type;

export const WorkjetManagedBackendControlResolveResult = Schema.Struct({
  backendControlConnectionId: WorkjetManagedBackendControlConnectionId,
  businessOsInstanceId: BusinessOsInstanceId,
  expiresAt: Rfc3339Timestamp,
});
export type WorkjetManagedBackendControlResolveResult =
  typeof WorkjetManagedBackendControlResolveResult.Type;

const WorkjetManagedBackendControlScope = {
  backendControlConnectionId: WorkjetManagedBackendControlConnectionId,
  businessOsInstanceId: BusinessOsInstanceId,
} as const;

export const WorkjetManagedDeviceBindingListInput = Schema.Struct({
  ...WorkjetManagedBackendControlScope,
});
export type WorkjetManagedDeviceBindingListInput = typeof WorkjetManagedDeviceBindingListInput.Type;

/**
 * Managed invite creation deliberately omits `connectionUrl`: the producer
 * chooses its own trusted redemption origin and the selected backend instance.
 */
export const WorkjetManagedDeviceInviteCreateInput = Schema.Struct({
  ...WorkjetManagedBackendControlScope,
  ttlSeconds: Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 3_600 })),
});
export type WorkjetManagedDeviceInviteCreateInput =
  typeof WorkjetManagedDeviceInviteCreateInput.Type;

export const WorkjetManagedDeviceInviteRevokeInput = Schema.Struct({
  ...WorkjetManagedBackendControlScope,
  inviteId: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
});
export type WorkjetManagedDeviceInviteRevokeInput =
  typeof WorkjetManagedDeviceInviteRevokeInput.Type;

/** Cookie-session CSRF and DPoP proof are both mandatory on every control request. */
export const WorkjetManagedBackendControlHeaders = Schema.Struct({
  dpop: TrimmedNonEmptyString.check(Schema.isMaxLength(8_192)),
  "x-workjet-csrf": TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
});
export type WorkjetManagedBackendControlHeaders = typeof WorkjetManagedBackendControlHeaders.Type;

export class WorkjetManagedBackendControlRejectedError extends Schema.TaggedErrorClass<WorkjetManagedBackendControlRejectedError>()(
  "WorkjetManagedBackendControlRejectedError",
  { code: Schema.Literal("managed_backend_control_rejected") },
  { httpApiStatus: 403 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(WorkjetManagedBackendControlRejectedError)(this, {
      status: 403,
    });
  }
}

export class WorkjetManagedBackendControlExpiredError extends Schema.TaggedErrorClass<WorkjetManagedBackendControlExpiredError>()(
  "WorkjetManagedBackendControlExpiredError",
  { code: Schema.Literal("managed_backend_control_expired") },
  { httpApiStatus: 410 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(WorkjetManagedBackendControlExpiredError)(this, {
      status: 410,
    });
  }
}

export class WorkjetManagedBackendControlUnavailableError extends Schema.TaggedErrorClass<WorkjetManagedBackendControlUnavailableError>()(
  "WorkjetManagedBackendControlUnavailableError",
  { code: Schema.Literal("managed_backend_control_unavailable") },
  { httpApiStatus: 503 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(WorkjetManagedBackendControlUnavailableError)(this, {
      status: 503,
    });
  }
}

const ManagedControlErrors = [
  WorkjetManagedBackendControlRejectedError,
  WorkjetManagedBackendControlExpiredError,
  WorkjetManagedBackendControlUnavailableError,
] as const;

export const WORKJET_MANAGED_BACKEND_CONTROL_RESOLVE_PATH =
  "/api/workjet/backend-control/connections";
export const WORKJET_MANAGED_DEVICE_BINDINGS_LIST_PATH =
  "/api/workjet/backend-control/device-bindings/list";
export const WORKJET_MANAGED_DEVICE_INVITES_CREATE_PATH =
  "/api/workjet/backend-control/device-invites/create";
export const WORKJET_MANAGED_DEVICE_INVITES_REVOKE_PATH =
  "/api/workjet/backend-control/device-invites/revoke";

export class WorkjetManagedBackendControlHttpGroup extends HttpApiGroup.make(
  "managedBackendControl",
)
  .add(
    HttpApiEndpoint.post("resolve", WORKJET_MANAGED_BACKEND_CONTROL_RESOLVE_PATH, {
      headers: WorkjetManagedBackendControlHeaders,
      payload: WorkjetManagedBackendControlResolveInput,
      success: WorkjetManagedBackendControlResolveResult,
      error: ManagedControlErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("listDeviceBindings", WORKJET_MANAGED_DEVICE_BINDINGS_LIST_PATH, {
      headers: WorkjetManagedBackendControlHeaders,
      payload: WorkjetManagedDeviceBindingListInput,
      success: WorkjetDeviceBindingListResult,
      error: ManagedControlErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("createDeviceInvite", WORKJET_MANAGED_DEVICE_INVITES_CREATE_PATH, {
      headers: WorkjetManagedBackendControlHeaders,
      payload: WorkjetManagedDeviceInviteCreateInput,
      success: WorkjetDeviceInviteCreateResult,
      error: ManagedControlErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("revokeDeviceInvite", WORKJET_MANAGED_DEVICE_INVITES_REVOKE_PATH, {
      headers: WorkjetManagedBackendControlHeaders,
      payload: WorkjetManagedDeviceInviteRevokeInput,
      success: WorkjetDeviceInviteRevokeResult,
      error: ManagedControlErrors,
    }),
  ) {}

/**
 * Contract for the ctox.dev producer. It is intentionally not registered on
 * the local Workjet EnvironmentHttpApi: doing so would reintroduce the forbidden
 * Primary Environment / Code-computer fallback.
 */
export class WorkjetManagedBackendControlHttpApi extends HttpApi.make(
  "workjetManagedBackendControl",
).add(WorkjetManagedBackendControlHttpGroup) {}
