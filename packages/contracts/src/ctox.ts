// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EnvironmentId } from "./baseSchemas.ts";
import { WorkjetConnectionId, WorkjetConnectionSummary } from "./workjet.ts";
import { BusinessOsShellUpdateStatus } from "./businessOsShell.ts";

const NoAsciiControlCharacters = Schema.makeFilter((input: string) => {
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return "Value must not contain ASCII control characters.";
    }
  }
  return true;
});
export const CtoxManagedInstanceDisplayName = TrimmedNonEmptyString.check(
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

export const CtoxHostPlatform = Schema.Literals(["macos", "linux", "windows", "unknown"]);
export type CtoxHostPlatform = typeof CtoxHostPlatform.Type;

export const CtoxHostArchitecture = Schema.Literals(["arm64", "x64", "unknown"]);
export type CtoxHostArchitecture = typeof CtoxHostArchitecture.Type;

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

export const CtoxDecisionHubAvailability = Schema.Struct({
  eligible: Schema.Boolean,
  mcpEnabled: Schema.Boolean,
  instanceId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  displayName: CtoxManagedInstanceDisplayName,
  reason: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type CtoxDecisionHubAvailability = typeof CtoxDecisionHubAvailability.Type;

export const CtoxDecisionHubProvisionInput = Schema.Struct({
  environmentId: EnvironmentId,
  target: Schema.Union([
    Schema.TaggedStruct("ctox_dev", {
      tenantId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    }),
    Schema.TaggedStruct("local_ctox", {
      instanceId: CtoxManagedInstanceId,
    }),
  ]),
});
export type CtoxDecisionHubProvisionInput = typeof CtoxDecisionHubProvisionInput.Type;

export const CtoxDecisionHubProvisionResult = Schema.Union([
  Schema.TaggedStruct("completed", { connection: WorkjetConnectionSummary }),
  Schema.TaggedStruct("failed", {
    code: Schema.Literals([
      "invalid_input",
      "signed_out",
      "grant_unavailable",
      "environment_unavailable",
      "provision_failed",
    ]),
  }),
]);
export type CtoxDecisionHubProvisionResult = typeof CtoxDecisionHubProvisionResult.Type;

export const CtoxDecisionHubDisconnectInput = Schema.Struct({
  environmentId: EnvironmentId,
  connectionId: WorkjetConnectionId,
});
export type CtoxDecisionHubDisconnectInput = typeof CtoxDecisionHubDisconnectInput.Type;

export const CtoxDecisionHubDisconnectResult = Schema.Union([
  Schema.TaggedStruct("completed", {}),
  Schema.TaggedStruct("failed", {
    code: Schema.Literals(["invalid_input", "environment_unavailable", "disconnect_failed"]),
  }),
]);
export type CtoxDecisionHubDisconnectResult = typeof CtoxDecisionHubDisconnectResult.Type;

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
  platform: Schema.optionalKey(CtoxHostPlatform),
  architecture: Schema.optionalKey(CtoxHostArchitecture),
  decisionHub: Schema.optionalKey(CtoxDecisionHubAvailability),
  shellUpdate: Schema.optionalKey(BusinessOsShellUpdateStatus),
  healthSummary: CtoxManagedInstanceHealth,
});
export type CtoxManagedInstance = typeof CtoxManagedInstance.Type;

export const CtoxShellFleetBlocker = Schema.Literals([
  "offline",
  "no_administrative_access",
  "backend_unavailable",
  "data_plane_degraded",
  "incompatible",
  "paused",
  "unknown_instance",
]);
export type CtoxShellFleetBlocker = typeof CtoxShellFleetBlocker.Type;

export const CtoxShellFleetRow = Schema.Struct({
  instanceId: CtoxManagedInstanceId,
  displayName: CtoxManagedInstanceDisplayName,
  source: CtoxManagedInstanceSource,
  reachable: Schema.Boolean,
  platform: CtoxHostPlatform,
  architecture: CtoxHostArchitecture,
  administrativeAccess: Schema.Literals([
    "available",
    "authentication_required",
    "unavailable",
    "unknown",
  ]),
  backendVersion: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  shell: BusinessOsShellUpdateStatus,
  blocker: Schema.NullOr(CtoxShellFleetBlocker),
  requiredOperatorStep: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type CtoxShellFleetRow = typeof CtoxShellFleetRow.Type;

export const CtoxShellFleetInventoryResult = Schema.Union([
  Schema.TaggedStruct("completed", {
    checkedAt: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    rows: Schema.Array(CtoxShellFleetRow).check(Schema.isMaxLength(1_000)),
  }),
  Schema.TaggedStruct("failed", {
    code: Schema.Literals(["inventory_failed", "invalid_response"]),
  }),
]);
export type CtoxShellFleetInventoryResult = typeof CtoxShellFleetInventoryResult.Type;

export const CtoxShellFleetActionInput = Schema.Struct({
  instanceId: CtoxManagedInstanceId,
  action: Schema.Literals(["check", "update", "rollback"]),
});
export type CtoxShellFleetActionInput = typeof CtoxShellFleetActionInput.Type;

export const CtoxShellFleetActionResult = Schema.Union([
  Schema.TaggedStruct("completed", { row: CtoxShellFleetRow }),
  Schema.TaggedStruct("failed", {
    code: Schema.Literals([
      "invalid_input",
      "unknown_instance",
      "not_administrable",
      "operation_failed",
      "health_check_failed",
    ]),
  }),
]);
export type CtoxShellFleetActionResult = typeof CtoxShellFleetActionResult.Type;

export const CtoxShellFleetPauseInput = Schema.Struct({
  instanceId: CtoxManagedInstanceId,
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  expiresAt: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type CtoxShellFleetPauseInput = typeof CtoxShellFleetPauseInput.Type;

export const CtoxShellFleetRolloutPhase = Schema.Literals([
  "idle",
  "inventory",
  "local_canary",
  "platform_canary",
  "wave",
  "observing",
  "completed",
  "paused",
  "failed",
]);
export type CtoxShellFleetRolloutPhase = typeof CtoxShellFleetRolloutPhase.Type;

export const CtoxShellFleetRolloutStatus = Schema.Struct({
  phase: CtoxShellFleetRolloutPhase,
  releaseVersion: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  startedAt: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
  updatedAt: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  currentWave: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  totalWaves: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  instanceIds: Schema.Array(CtoxManagedInstanceId).check(Schema.isMaxLength(1_000)),
  completedInstanceIds: Schema.Array(CtoxManagedInstanceId).check(Schema.isMaxLength(1_000)),
  failedInstanceId: Schema.NullOr(CtoxManagedInstanceId),
  errorCode: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  pauseReason: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  pausedAt: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
});
export type CtoxShellFleetRolloutStatus = typeof CtoxShellFleetRolloutStatus.Type;

export const CtoxShellFleetRolloutResult = Schema.Union([
  Schema.TaggedStruct("started", { status: CtoxShellFleetRolloutStatus }),
  Schema.TaggedStruct("already_running", { status: CtoxShellFleetRolloutStatus }),
  Schema.TaggedStruct("failed", {
    code: Schema.Literals(["inventory_failed", "no_eligible_instances", "rollout_failed"]),
  }),
]);
export type CtoxShellFleetRolloutResult = typeof CtoxShellFleetRolloutResult.Type;

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

export const CtoxBusinessOsInviteV1 = Schema.Struct({
  type: Schema.Literal("ctox-business-os-invite"),
  version: Schema.Literal(1),
  display_name: CtoxPairingDisplayName,
  instance_id: CtoxPairingInstanceIdentity,
  sync_room: CtoxPairingSyncRoom,
  native_peer_id: CtoxPairingInstanceIdentity,
  signaling_urls: Schema.Array(CtoxPairingSignalingUrl).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
  signaling_room_password: CtoxPairingRoomSecret,
  transport: Schema.Literal("webrtc"),
  expires_at: CtoxPairingInputText.check(Schema.isMaxLength(64)),
  data_plane: Schema.Literal("rxdb-webrtc"),
  http_bridge_available: Schema.Literal(false),
  secret_value_in_payload: Schema.optionalKey(Schema.Literal(true)),
  session: Schema.Struct({
    authenticated: Schema.Literal(true),
    source: Schema.Literal("mobile_invite"),
    capability_token: CtoxPairingCapabilityToken,
    capability_expires_at_ms: CtoxPairingExpirationMs,
    user: Schema.Struct({
      id: CtoxPairingUserId,
      display_name: CtoxPairingDisplayName,
      role: Schema.Literal("user"),
      is_admin: Schema.Literal(false),
    }),
  }),
});
export type CtoxBusinessOsInviteV1 = typeof CtoxBusinessOsInviteV1.Type;

export const CtoxMobileInviteCreateInput = Schema.Struct({
  ttlSeconds: Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 3_600 })),
});
export type CtoxMobileInviteCreateInput = typeof CtoxMobileInviteCreateInput.Type;

export const CtoxMobileInviteCreateResult = Schema.Struct({
  inviteId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  invite: CtoxBusinessOsInviteV1,
  expiresAt: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
});
export type CtoxMobileInviteCreateResult = typeof CtoxMobileInviteCreateResult.Type;

export const CtoxMobileInviteRevokeInput = Schema.Struct({
  inviteId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type CtoxMobileInviteRevokeInput = typeof CtoxMobileInviteRevokeInput.Type;

export const CtoxMobileInviteRevokeResult = Schema.Struct({
  revoked: Schema.Literal(true),
});
export type CtoxMobileInviteRevokeResult = typeof CtoxMobileInviteRevokeResult.Type;

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

/**
 * An SSH destination the user already trusts: an alias from their own SSH
 * config or a hostname. The pattern deliberately excludes whitespace, quotes,
 * and every shell metacharacter, so the value can never widen an argument
 * vector or a remote command line.
 */
export const CtoxSshManagedHost = TrimmedNonEmptyString.check(
  Schema.isMaxLength(255),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/),
);
export type CtoxSshManagedHost = typeof CtoxSshManagedHost.Type;

/**
 * An optional absolute CTOX state root on the remote host. Restricted to a
 * conservative POSIX path alphabet for the same reason as the host.
 */
export const CtoxSshManagedStateRoot = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1_024),
  Schema.isPattern(/^\/[A-Za-z0-9._\-/]{0,1023}$/),
);
export type CtoxSshManagedStateRoot = typeof CtoxSshManagedStateRoot.Type;

const CtoxSshManagedUsername = TrimmedNonEmptyString.check(
  Schema.isMaxLength(255),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/),
);
const CtoxSshManagedPort = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(65_535),
);
const CtoxSshKnownHostsLine = TrimmedNonEmptyString.check(
  Schema.isMaxLength(8_192),
  Schema.isPattern(/^[^\r\n]+$/),
);

/**
 * Configuration of one SSH-managed CTOX instance. It carries no credential:
 * authentication stays with the user's existing SSH agent, keys, and
 * `known_hosts`, exactly as the desktop's other SSH surfaces use them.
 */
export const CtoxSshManagedInstanceAddInput = Schema.Struct({
  host: CtoxSshManagedHost,
  displayName: Schema.optionalKey(CtoxManagedInstanceDisplayName),
  stateRoot: Schema.optionalKey(CtoxSshManagedStateRoot),
  username: Schema.optionalKey(CtoxSshManagedUsername),
  port: Schema.optionalKey(CtoxSshManagedPort),
  platform: Schema.optionalKey(CtoxHostPlatform),
  architecture: Schema.optionalKey(CtoxHostArchitecture),
  /** Credential-free host-key pin confirmed during the provisioning preflight. */
  knownHostsLine: Schema.optionalKey(CtoxSshKnownHostsLine),
});
export type CtoxSshManagedInstanceAddInput = typeof CtoxSshManagedInstanceAddInput.Type;

export const CtoxSshManagedInstanceRemoveInput = Schema.Struct({
  instanceId: CtoxManagedInstanceId,
});
export type CtoxSshManagedInstanceRemoveInput = typeof CtoxSshManagedInstanceRemoveInput.Type;

export const CtoxSshManagedInstanceAddResult = Schema.Union([
  Schema.TaggedStruct("completed", { instance: CtoxManagedInstance }),
  Schema.TaggedStruct("failed", { code: CtoxPairedInstanceMutationFailureCode }),
]);
export type CtoxSshManagedInstanceAddResult = typeof CtoxSshManagedInstanceAddResult.Type;

export const CtoxSshManagedInstanceRemoveResult = Schema.Union([
  Schema.TaggedStruct("completed", {}),
  Schema.TaggedStruct("failed", { code: CtoxPairedInstanceMutationFailureCode }),
]);
export type CtoxSshManagedInstanceRemoveResult = typeof CtoxSshManagedInstanceRemoveResult.Type;

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
 * Lifecycle of an instance's pooled native guest: "none" (no live guest),
 * "loading" (first load in progress), "warm" (loaded and instantly
 * attachable). Pushed main → renderer so the sidebar can show which instances
 * switch without a load.
 */
export const CtoxGuestLifecycleState = Schema.Literals(["none", "loading", "warm"]);
export type CtoxGuestLifecycleState = typeof CtoxGuestLifecycleState.Type;

/** Guest-state change event. Identity and state only — never guest content. */
export const CtoxGuestStateEvent = Schema.Struct({
  instanceId: CtoxManagedInstanceId,
  state: CtoxGuestLifecycleState,
});
export type CtoxGuestStateEvent = typeof CtoxGuestStateEvent.Type;

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

/**
 * The Business OS module's own `category` manifest field (e.g. "Workspace",
 * "Development", "REM Capital"), used to sub-group the sidebar app rail.
 * Absent when the guest module carries no category.
 */
export const CtoxAppCategory = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  NoAsciiControlCharacters,
);
export type CtoxAppCategory = typeof CtoxAppCategory.Type;

export const CtoxInstanceApp = Schema.Struct({
  id: CtoxAppModuleId,
  title: Schema.optional(CtoxAppTitle),
  category: Schema.optional(CtoxAppCategory),
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
