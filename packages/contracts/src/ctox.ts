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
export const CtoxManagedInstanceId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(512),
  NoAsciiControlCharacters,
);
export type CtoxManagedInstanceId = typeof CtoxManagedInstanceId.Type;
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
  "manual_pairing",
]);
export type CtoxManagedInstanceSource = typeof CtoxManagedInstanceSource.Type;

export const CtoxManagedInstanceStatus = Schema.Literals([
  "available",
  "offline",
  "needs_auth",
  "pairing_expired",
  "paired",
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

/**
 * The deliberately small instance descriptor which may cross into the
 * renderer. Session partitions and tenant launch identifiers are derived and
 * retained by the main process; this value contains no cookies, pairing
 * material, launch tokens, raw URLs, or control-plane payload.
 */
export const CtoxManagedInstance = Schema.Struct({
  id: CtoxManagedInstanceId,
  source: CtoxManagedInstanceSource,
  displayName: CtoxManagedInstanceDisplayName,
  status: CtoxManagedInstanceStatus,
  domain: Schema.optionalKey(CtoxManagedInstanceHostname),
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
const CtoxDiscoveryInstances = Schema.Array(CtoxManagedInstance).check(Schema.isMaxLength(1_000));

export const CtoxManagedDiscoveryResult = Schema.Union([
  Schema.TaggedStruct("ready", { instances: CtoxDiscoveryInstances }),
  Schema.TaggedStruct("signed_out", {}),
  Schema.TaggedStruct("failed", {
    code: CtoxManagedDiscoveryFailureCode,
    httpStatus: Schema.optionalKey(CtoxManagedDiscoveryHttpStatus),
  }),
]);
export type CtoxManagedDiscoveryResult = typeof CtoxManagedDiscoveryResult.Type;

/** Unified managed and accountless-pairing discovery state exposed to the renderer. */
export const CtoxDiscoveryResult = Schema.Union([
  Schema.TaggedStruct("ready", {
    instances: CtoxDiscoveryInstances,
    managedState: Schema.optionalKey(Schema.Literals(["ready", "signed_out", "failed"])),
    managedFailureCode: Schema.optionalKey(CtoxManagedDiscoveryFailureCode),
  }),
  Schema.TaggedStruct("signed_out", {}),
  Schema.TaggedStruct("failed", {
    code: CtoxManagedDiscoveryFailureCode,
    httpStatus: Schema.optionalKey(CtoxManagedDiscoveryHttpStatus),
  }),
]);
export type CtoxDiscoveryResult = typeof CtoxDiscoveryResult.Type;

const CtoxPairingInputText = TrimmedNonEmptyString.check(NoAsciiControlCharacters);
const CtoxPairingDisplayName = CtoxPairingInputText.check(Schema.isMaxLength(256));
const CtoxPairingInstanceIdentity = CtoxPairingInputText.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
);
const CtoxPairingSyncRoom = CtoxPairingInputText.check(
  Schema.isMaxLength(273),
  Schema.isPattern(/^ctox-business-os:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
);
const CtoxPairingSignalingUrl = CtoxPairingInputText.check(Schema.isMaxLength(2_048));
const CtoxPairingRoomSecret = CtoxPairingInputText.check(Schema.isMaxLength(4_096));
const CtoxPairingCapabilityToken = CtoxPairingInputText.check(Schema.isMaxLength(16_384));
const CtoxPairingUserId = CtoxPairingInputText.check(Schema.isMaxLength(256));
const CtoxPairingExpirationMs = Schema.Int.check(Schema.isGreaterThan(0));

/** A bounded raw invite JSON document or CTOX desktop invite link. */
export const CtoxPairingInviteImportInput = Schema.Struct({
  invite: Schema.String.check(Schema.isMaxLength(65_536)),
});
export type CtoxPairingInviteImportInput = typeof CtoxPairingInviteImportInput.Type;

/** Manual WebRTC pairing input. Secret-bearing fields are main-process only. */
export const CtoxManualPairingImportInput = Schema.Struct({
  displayName: CtoxPairingDisplayName,
  instanceId: Schema.optionalKey(CtoxPairingInstanceIdentity),
  syncRoom: CtoxPairingSyncRoom,
  signalingUrls: Schema.Array(CtoxPairingSignalingUrl).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
  roomSecret: CtoxPairingRoomSecret,
  capabilityToken: Schema.optionalKey(CtoxPairingCapabilityToken),
  capabilityExpiresAtMs: Schema.optionalKey(CtoxPairingExpirationMs),
  role: Schema.optionalKey(CtoxManagedInstanceRole),
  userId: Schema.optionalKey(CtoxPairingUserId),
});
export type CtoxManualPairingImportInput = typeof CtoxManualPairingImportInput.Type;

export const CtoxPairedInstanceRemoveInput = Schema.Struct({
  instanceId: CtoxManagedInstanceId,
});
export type CtoxPairedInstanceRemoveInput = typeof CtoxPairedInstanceRemoveInput.Type;

export const CtoxPairedInstanceMutationFailureCode = Schema.Literals([
  "invalid_input",
  "invalid_invite",
  "unsafe_secret_storage",
  "persistence_failed",
  "not_found",
  "managed_not_removable",
]);
export type CtoxPairedInstanceMutationFailureCode =
  typeof CtoxPairedInstanceMutationFailureCode.Type;

export const CtoxPairedInstanceImportResult = Schema.Union([
  Schema.TaggedStruct("completed", { instance: CtoxManagedInstance }),
  Schema.TaggedStruct("failed", { code: CtoxPairedInstanceMutationFailureCode }),
]);
export type CtoxPairedInstanceImportResult = typeof CtoxPairedInstanceImportResult.Type;

export const CtoxPairedInstanceRemoveResult = Schema.Union([
  Schema.TaggedStruct("completed", {}),
  Schema.TaggedStruct("failed", { code: CtoxPairedInstanceMutationFailureCode }),
]);
export type CtoxPairedInstanceRemoveResult = typeof CtoxPairedInstanceRemoveResult.Type;

const CtoxGuestBoundCoordinate = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(2_147_483_647),
);

/** Browser content coordinates in Electron device-independent pixels. */
export const CtoxGuestBounds = Schema.Struct({
  x: CtoxGuestBoundCoordinate,
  y: CtoxGuestBoundCoordinate,
  width: CtoxGuestBoundCoordinate,
  height: CtoxGuestBoundCoordinate,
});
export type CtoxGuestBounds = typeof CtoxGuestBounds.Type;

export const CtoxManagedActivationInput = Schema.Struct({
  instanceId: CtoxManagedInstanceId,
  bounds: CtoxGuestBounds,
});
export type CtoxManagedActivationInput = typeof CtoxManagedActivationInput.Type;

export const CtoxGuestBoundsInput = Schema.Struct({ bounds: CtoxGuestBounds });
export type CtoxGuestBoundsInput = typeof CtoxGuestBoundsInput.Type;

export const CtoxManagedActionFailureCode = Schema.Literals([
  "invalid_input",
  "authentication_failed",
  "launch_failed",
  "guest_failed",
  "not_active",
]);
export type CtoxManagedActionFailureCode = typeof CtoxManagedActionFailureCode.Type;

export const CtoxManagedActionResult = Schema.Union([
  Schema.TaggedStruct("completed", {}),
  Schema.TaggedStruct("failed", { code: CtoxManagedActionFailureCode }),
]);
export type CtoxManagedActionResult = typeof CtoxManagedActionResult.Type;

/**
 * A Business OS module surfaced in the sidebar as a directly selectable app —
 * the CTOX analog of a T3 chat session under its project. Docked apps are
 * user-pinned to the rail (taskbar model) and stay listed even while closed
 * or disconnected; undocked apps appear only while open in the guest.
 */
export const CtoxAppModuleId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
);
export type CtoxAppModuleId = typeof CtoxAppModuleId.Type;

const CtoxAppTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(128), NoAsciiControlCharacters);

export const CtoxInstanceApp = Schema.Struct({
  id: CtoxAppModuleId,
  title: Schema.optional(CtoxAppTitle),
  docked: Schema.Boolean,
  open: Schema.Boolean,
  /** Epoch milliseconds of the last time this app was observed on the guest. */
  lastSeenAt: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type CtoxInstanceApp = typeof CtoxInstanceApp.Type;

export const CtoxInstanceAppsInput = Schema.Struct({
  instanceId: CtoxManagedInstanceId,
});
export type CtoxInstanceAppsInput = typeof CtoxInstanceAppsInput.Type;

export const CtoxAppActionFailureCode = Schema.Literals([
  "invalid_input",
  "not_active",
  "guest_failed",
  "persistence_failed",
  "not_found",
]);
export type CtoxAppActionFailureCode = typeof CtoxAppActionFailureCode.Type;

export const CtoxInstanceAppsResult = Schema.Union([
  Schema.TaggedStruct("completed", {
    instanceId: CtoxManagedInstanceId,
    /** "live" when read from the active guest; "cache" for the persisted last known state. */
    source: Schema.Literals(["live", "cache"]),
    /** Human workspace name observed on the guest (e.g. workspace branding). */
    workspaceName: Schema.optional(CtoxAppTitle),
    apps: Schema.Array(CtoxInstanceApp),
  }),
  Schema.TaggedStruct("failed", { code: CtoxAppActionFailureCode }),
]);
export type CtoxInstanceAppsResult = typeof CtoxInstanceAppsResult.Type;

export const CtoxOpenAppInput = Schema.Struct({
  instanceId: CtoxManagedInstanceId,
  moduleId: CtoxAppModuleId,
  bounds: CtoxGuestBounds,
});
export type CtoxOpenAppInput = typeof CtoxOpenAppInput.Type;

export const CtoxSetAppDockedInput = Schema.Struct({
  instanceId: CtoxManagedInstanceId,
  moduleId: CtoxAppModuleId,
  docked: Schema.Boolean,
});
export type CtoxSetAppDockedInput = typeof CtoxSetAppDockedInput.Type;

export const CtoxAppActionResult = Schema.Union([
  Schema.TaggedStruct("completed", {}),
  Schema.TaggedStruct("failed", { code: CtoxAppActionFailureCode }),
]);
export type CtoxAppActionResult = typeof CtoxAppActionResult.Type;

/** Allowlisted theme token keys the guest shell understands (--ctox-host-*). */
export const CtoxHostThemeTokenKey = Schema.Literals([
  "bg",
  "surface",
  "surface-2",
  "surface-3",
  "line",
  "hairline",
  "text",
  "text-strong",
  "muted",
  "accent",
  "accent-foreground",
  "accent-soft",
]);
export type CtoxHostThemeTokenKey = typeof CtoxHostThemeTokenKey.Type;

/** A bounded CSS color value; never arbitrary CSS. */
export const CtoxHostThemeColor = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(72),
  Schema.isPattern(
    /^(#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\([^;{}<>"'`\\]{1,64}\))$/,
  ),
);

/**
 * The Workjet appearance theme projected into the Business OS guest. The
 * renderer derives it from its own resolved CSS variables, so built-in and
 * user-created themes translate identically.
 */
const CtoxHostThemeTokenValue = Schema.optionalKey(CtoxHostThemeColor);
export const CtoxHostThemeInput = Schema.Struct({
  scheme: Schema.Literals(["light", "dark"]),
  tokens: Schema.Struct({
    bg: CtoxHostThemeTokenValue,
    surface: CtoxHostThemeTokenValue,
    "surface-2": CtoxHostThemeTokenValue,
    "surface-3": CtoxHostThemeTokenValue,
    line: CtoxHostThemeTokenValue,
    hairline: CtoxHostThemeTokenValue,
    text: CtoxHostThemeTokenValue,
    "text-strong": CtoxHostThemeTokenValue,
    muted: CtoxHostThemeTokenValue,
    accent: CtoxHostThemeTokenValue,
    "accent-foreground": CtoxHostThemeTokenValue,
    "accent-soft": CtoxHostThemeTokenValue,
  }),
});
export type CtoxHostThemeInput = typeof CtoxHostThemeInput.Type;

export const CtoxManagedLoginResult = Schema.Union([
  Schema.TaggedStruct("completed", { discovery: CtoxDiscoveryResult }),
  Schema.TaggedStruct("cancelled", { reason: Schema.Literals(["closed", "timeout"]) }),
  Schema.TaggedStruct("failed", { code: Schema.Literal("authentication_failed") }),
]);
export type CtoxManagedLoginResult = typeof CtoxManagedLoginResult.Type;

export const CtoxManagedGuestResult = Schema.Union([
  Schema.TaggedStruct("ready", { instanceId: CtoxManagedInstanceId }),
  Schema.TaggedStruct("revoked", {}),
  Schema.TaggedStruct("failed", {
    code: Schema.Literals(["invalid_input", "launch_failed", "guest_failed", "not_active"]),
  }),
]);
export type CtoxManagedGuestResult = typeof CtoxManagedGuestResult.Type;
