// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const NoAsciiControlCharacters = Schema.makeFilter((input: string) => {
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return "Value must not contain ASCII control characters.";
    }
  }
  return true;
});
const CtoxManagedInstanceDisplayName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  NoAsciiControlCharacters,
);
const CtoxManagedInstanceId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  NoAsciiControlCharacters,
);
const CtoxManagedInstanceTenantId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);
const CtoxManagedInstanceRole = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  NoAsciiControlCharacters,
);
const CtoxManagedInstanceHostname = TrimmedNonEmptyString.check(
  Schema.isMaxLength(253),
  Schema.isPattern(
    /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/,
  ),
);

/** The supported origins for CTOX instances visible in the Workjet shell. */
export const CtoxManagedInstanceSource = Schema.Literals([
  "ctox_dev",
  "local_daemon",
  "ssh_managed",
  "pairing_invite",
]);
export type CtoxManagedInstanceSource = typeof CtoxManagedInstanceSource.Type;

export const CtoxManagedInstanceStatus = Schema.Literals([
  "available",
  "offline",
  "needs_auth",
  "pairing_expired",
  "installing",
  "error",
]);
export type CtoxManagedInstanceStatus = typeof CtoxManagedInstanceStatus.Type;

/**
 * Renderer-safe health metadata. CTOX Business OS data always remains on its
 * native RxDB/WebRTC plane; Workjet must never introduce an HTTP data proxy.
 */
export const CtoxManagedInstanceHealth = Schema.Struct({
  dataPlane: Schema.Literal("rxdb-webrtc"),
  dataPlaneReady: Schema.Boolean,
  httpDataProxy: Schema.Literal(false),
  nativePeerObserved: Schema.Boolean,
});
export type CtoxManagedInstanceHealth = typeof CtoxManagedInstanceHealth.Type;

export const CtoxManagedInstanceSessionPartition = TrimmedNonEmptyString.check(
  Schema.isPattern(
    /^persist:workjet-ctox-(?:ctox_dev|local_daemon|ssh_managed|pairing_invite)-[a-f0-9]{64}$/,
  ),
);
export type CtoxManagedInstanceSessionPartition = typeof CtoxManagedInstanceSessionPartition.Type;

/**
 * The deliberately small instance descriptor which may cross into the
 * renderer. It contains no cookies, pairing material, launch tokens, or raw
 * control-plane payload.
 */
export const CtoxManagedInstance = Schema.Struct({
  id: CtoxManagedInstanceId,
  source: CtoxManagedInstanceSource,
  displayName: CtoxManagedInstanceDisplayName,
  status: CtoxManagedInstanceStatus,
  sessionPartition: CtoxManagedInstanceSessionPartition,
  domain: Schema.optionalKey(CtoxManagedInstanceHostname),
  tenantId: Schema.optionalKey(CtoxManagedInstanceTenantId),
  role: Schema.optionalKey(CtoxManagedInstanceRole),
  healthSummary: CtoxManagedInstanceHealth,
});
export type CtoxManagedInstance = typeof CtoxManagedInstance.Type;

export const CtoxManagedDiscoveryFailureCode = Schema.Literals([
  "invalid_base_url",
  "network_error",
  "http_error",
  "invalid_response",
]);
export type CtoxManagedDiscoveryFailureCode = typeof CtoxManagedDiscoveryFailureCode.Type;

const CtoxManagedDiscoveryHttpStatus = Schema.Int.check(
  Schema.isBetween({ minimum: 100, maximum: 599 }),
);

/**
 * Complete, IPC-safe discovery state. Failures expose only a fixed code and an
 * optional HTTP status: never a response body, thrown cause, URL, or payload.
 */
export const CtoxManagedDiscoveryResult = Schema.Union([
  Schema.TaggedStruct("ready", {
    instances: Schema.Array(CtoxManagedInstance).check(Schema.isMaxLength(1_000)),
  }),
  Schema.TaggedStruct("signed_out", {}),
  Schema.TaggedStruct("failed", {
    code: CtoxManagedDiscoveryFailureCode,
    httpStatus: Schema.optionalKey(CtoxManagedDiscoveryHttpStatus),
  }),
]);
export type CtoxManagedDiscoveryResult = typeof CtoxManagedDiscoveryResult.Type;
