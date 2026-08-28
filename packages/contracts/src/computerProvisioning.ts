// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const BoundedText = TrimmedNonEmptyString.check(Schema.isMaxLength(2_048));
const OpaqueId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
);
const ProvisioningSshTarget = Schema.Struct({
  alias: Schema.String,
  hostname: Schema.String,
  username: Schema.NullOr(Schema.String),
  port: Schema.NullOr(Schema.Number),
});

export const WorkjetProvisioningTarget = Schema.Union([
  Schema.TaggedStruct("local", {}),
  Schema.TaggedStruct("ssh", {
    ssh: ProvisioningSshTarget,
  }),
]);
export type WorkjetProvisioningTarget = typeof WorkjetProvisioningTarget.Type;

export const WorkjetProvisioningPlatform = Schema.Literals(["macos", "linux", "windows"]);
export type WorkjetProvisioningPlatform = typeof WorkjetProvisioningPlatform.Type;

export const WorkjetProvisioningArchitecture = Schema.Literals(["arm64", "x64"]);
export type WorkjetProvisioningArchitecture = typeof WorkjetProvisioningArchitecture.Type;

export const WorkjetProvisioningComponent = Schema.Literals(["ctox-backend", "workjet"]);
export type WorkjetProvisioningComponent = typeof WorkjetProvisioningComponent.Type;

export const WorkjetProvisioningAction = Schema.Literals([
  "install",
  "status",
  "start",
  "stop",
  "restart",
  "repair",
  "update",
  "rollback",
]);
export type WorkjetProvisioningAction = typeof WorkjetProvisioningAction.Type;

export const WorkjetSshHostKeyInspectInput = Schema.Struct({
  target: WorkjetProvisioningTarget,
});
export type WorkjetSshHostKeyInspectInput = typeof WorkjetSshHostKeyInspectInput.Type;

export const WorkjetSshHostKeyInspectResult = Schema.Union([
  Schema.TaggedStruct("not_required", {}),
  Schema.TaggedStruct("ready", {
    algorithm: BoundedText,
    fingerprint: BoundedText,
  }),
  Schema.TaggedStruct("failed", {
    code: Schema.Literals(["invalid_target", "host_unreachable", "host_key_unavailable"]),
    message: BoundedText,
  }),
]);
export type WorkjetSshHostKeyInspectResult = typeof WorkjetSshHostKeyInspectResult.Type;

export const WorkjetProvisioningPreflightInput = Schema.Struct({
  target: WorkjetProvisioningTarget,
  confirmedHostKeyFingerprint: Schema.optionalKey(BoundedText),
});
export type WorkjetProvisioningPreflightInput = typeof WorkjetProvisioningPreflightInput.Type;

export const WorkjetProvisioningPreflight = Schema.Struct({
  preflightId: OpaqueId,
  expiresAt: BoundedText,
  target: WorkjetProvisioningTarget,
  platform: WorkjetProvisioningPlatform,
  architecture: WorkjetProvisioningArchitecture,
  internetAvailable: Schema.Boolean,
  administratorCapable: Schema.Boolean,
  administratorPasswordRequired: Schema.Boolean,
  administratorElevationRequired: Schema.Boolean,
  graphicalSession: Schema.Boolean,
  ctoxInstalledVersion: Schema.NullOr(BoundedText),
  workjetInstalledVersion: Schema.NullOr(BoundedText),
  warnings: Schema.Array(BoundedText).check(Schema.isMaxLength(32)),
});
export type WorkjetProvisioningPreflight = typeof WorkjetProvisioningPreflight.Type;

export const WorkjetProvisioningPreflightResult = Schema.Union([
  Schema.TaggedStruct("ready", { preflight: WorkjetProvisioningPreflight }),
  Schema.TaggedStruct("failed", {
    code: Schema.Literals([
      "invalid_input",
      "host_key_confirmation_required",
      "host_key_changed",
      "authentication_cancelled",
      "authentication_failed",
      "unsupported_platform",
      "unsupported_architecture",
      "internet_unavailable",
      "administrator_unavailable",
      "required_tool_unavailable",
      "preflight_failed",
    ]),
    message: BoundedText,
  }),
]);
export type WorkjetProvisioningPreflightResult = typeof WorkjetProvisioningPreflightResult.Type;

export const WorkjetProvisioningStartInput = Schema.Struct({
  preflightId: OpaqueId,
  action: WorkjetProvisioningAction,
  components: Schema.Array(WorkjetProvisioningComponent).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2),
  ),
  channel: Schema.optionalKey(Schema.Literals(["stable", "nightly"])),
});
export type WorkjetProvisioningStartInput = typeof WorkjetProvisioningStartInput.Type;

export const WorkjetProvisioningEvent = Schema.Struct({
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  phase: Schema.Literals([
    "queued",
    "preflight",
    "authorization",
    "download",
    "verification",
    "installation",
    "service",
    "health",
    "pairing",
    "replication",
    "complete",
    "failed",
  ]),
  status: Schema.Literals(["pending", "running", "completed", "failed", "skipped"]),
  percent: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  message: BoundedText,
  timestamp: BoundedText,
});
export type WorkjetProvisioningEvent = typeof WorkjetProvisioningEvent.Type;

export const WorkjetProvisioningSnapshot = Schema.Struct({
  operationId: OpaqueId,
  state: Schema.Literals(["queued", "running", "completed", "failed", "cancelled"]),
  action: WorkjetProvisioningAction,
  components: Schema.Array(WorkjetProvisioningComponent).check(Schema.isMaxLength(2)),
  events: Schema.Array(WorkjetProvisioningEvent).check(Schema.isMaxLength(256)),
  installedVersion: Schema.NullOr(BoundedText),
  serviceState: Schema.Literals(["unknown", "stopped", "running", "failed"]),
  backendHealthy: Schema.Boolean,
  activeConnection: Schema.Boolean,
  errorCode: Schema.NullOr(
    Schema.Literals([
      "preflight_expired",
      "authorization_cancelled",
      "authorization_failed",
      "unsupported_operation",
      "download_failed",
      "verification_failed",
      "installation_failed",
      "service_failed",
      "health_failed",
      "replication_failed",
      "operation_failed",
    ]),
  ),
});
export type WorkjetProvisioningSnapshot = typeof WorkjetProvisioningSnapshot.Type;

export const WorkjetProvisioningStartResult = Schema.Union([
  Schema.TaggedStruct("started", { operation: WorkjetProvisioningSnapshot }),
  Schema.TaggedStruct("failed", {
    code: Schema.Literals([
      "invalid_input",
      "preflight_expired",
      "component_unavailable",
      "operation_unavailable",
    ]),
    message: BoundedText,
  }),
]);
export type WorkjetProvisioningStartResult = typeof WorkjetProvisioningStartResult.Type;

export const WorkjetProvisioningGetInput = Schema.Struct({ operationId: OpaqueId });
export type WorkjetProvisioningGetInput = typeof WorkjetProvisioningGetInput.Type;

export const WorkjetProvisioningGetResult = Schema.Union([
  Schema.TaggedStruct("found", { operation: WorkjetProvisioningSnapshot }),
  Schema.TaggedStruct("not_found", {}),
]);
export type WorkjetProvisioningGetResult = typeof WorkjetProvisioningGetResult.Type;
