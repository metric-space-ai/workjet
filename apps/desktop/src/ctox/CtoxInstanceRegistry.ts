// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  CtoxManagedInstance as CtoxManagedInstanceSchema,
  CtoxPairedInstanceMutationFailureCode,
  type CtoxDiscoveryResult,
  type CtoxManagedDiscoveryResult,
  type CtoxManagedInstance,
  type CtoxManagedInstanceSource,
  type CtoxManualPairingImportInput,
  type CtoxPairedInstanceMutationFailureCode as CtoxPairedInstanceMutationFailureCodeType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import type { CtoxBusinessOsLaunchConfig } from "./CtoxBusinessOsShell.ts";
import { buildCtoxBusinessOsLaunchConfig } from "./CtoxLaunchConfig.ts";
import {
  discoverCtoxLocalDaemonInstances,
  isLaunchableCtoxLocalDaemon,
  type CtoxLocalDaemonDiscoveryOptions,
} from "./CtoxLocalDaemonSource.ts";

const REGISTRY_VERSION = 1;
const MAX_INVITE_BYTES = 65_536;
const MAX_PUBLIC_DOCUMENT_BYTES = 1_048_576;
const MAX_SECRET_DOCUMENT_BYTES = 16_777_216;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 4_096;
const MAX_INVITE_ARRAY_LENGTH = 64;
const PUBLIC_REGISTRY_FILE = "instances.json";
const SECRET_REGISTRY_FILE = "secrets.json";
const PAIRING_ROOM_PREFIX = "ctox-business-os:";
const textEncoder = new TextEncoder();

const NoAsciiControlCharacters = Schema.makeFilter((value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return "Control characters are not allowed.";
    }
  }
  return true;
});
const SafeText = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(16_384),
  NoAsciiControlCharacters,
);
const DisplayName = SafeText.check(Schema.isMaxLength(256));
const InstanceIdentity = SafeText.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
);
const SyncRoom = SafeText.check(
  Schema.isMaxLength(273),
  Schema.isPattern(/^ctox-business-os:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/),
);
const SignalingUrl = SafeText.check(Schema.isMaxLength(2_048));
const RoomSecret = SafeText.check(Schema.isMaxLength(4_096));
const CapabilityToken = SafeText.check(Schema.isMaxLength(16_384));
const Role = SafeText.check(Schema.isMaxLength(128));
const UserDisplayName = SafeText.check(Schema.isMaxLength(256));
const UserId = SafeText.check(Schema.isMaxLength(256));
const NativePeerId = SafeText.check(Schema.isMaxLength(256));
const DesktopInviteLink = SafeText.check(Schema.isMaxLength(MAX_INVITE_BYTES));
const Expiration = Schema.Int.check(Schema.isGreaterThan(0));
const PairedSource = Schema.Literals(["pairing_invite", "manual_pairing"]);
type PairedSource = typeof PairedSource.Type;

const InviteSessionUser = Schema.Struct({
  id: Schema.optionalKey(UserId),
  display_name: Schema.optionalKey(UserDisplayName),
  displayName: Schema.optionalKey(UserDisplayName),
  role: Schema.optionalKey(Role),
  is_admin: Schema.optionalKey(Schema.Boolean),
});
const InviteSession = Schema.Struct({
  authenticated: Schema.optionalKey(Schema.Literal(true)),
  source: Schema.optionalKey(Schema.Literal("desktop_invite")),
  capability_token: Schema.optionalKey(CapabilityToken),
  capability_expires_at_ms: Schema.optionalKey(Expiration),
  user: Schema.optionalKey(InviteSessionUser),
});
const InvitePayload = Schema.Struct({
  type: Schema.Literal("ctox-business-os-invite"),
  version: Schema.Literal(1),
  display_name: DisplayName,
  instance_id: Schema.optionalKey(InstanceIdentity),
  native_peer_id: Schema.optionalKey(NativePeerId),
  sync_room: SyncRoom,
  signaling_urls: Schema.Array(SignalingUrl).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  signaling_room_password: RoomSecret,
  transport: Schema.optionalKey(Schema.Literal("webrtc")),
  expires_at: Schema.optionalKey(SafeText.check(Schema.isMaxLength(64))),
  expires_at_ms: Schema.optionalKey(Expiration),
  data_plane: Schema.optionalKey(Schema.Literal("rxdb-webrtc")),
  capability_token: Schema.optionalKey(CapabilityToken),
  capability_expires_at_ms: Schema.optionalKey(Expiration),
  http_bridge_available: Schema.optionalKey(Schema.Literal(false)),
  secret_value_in_payload: Schema.optionalKey(Schema.Literal(true)),
  desktop_link: Schema.optionalKey(DesktopInviteLink),
  session: Schema.optionalKey(InviteSession),
});
type InvitePayload = typeof InvitePayload.Type;

const PublicRegistryDocument = Schema.Struct({
  version: Schema.Literal(REGISTRY_VERSION),
  instances: Schema.Array(CtoxManagedInstanceSchema).check(Schema.isMaxLength(1_000)),
});
type PublicRegistryDocument = typeof PublicRegistryDocument.Type;

const SecretRegistryRecord = Schema.Struct({
  id: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(512)),
  ciphertext: Schema.String.check(
    Schema.isTrimmed(),
    Schema.isNonEmpty(),
    Schema.isMaxLength(131_072),
  ),
});
const SecretRegistryDocument = Schema.Struct({
  version: Schema.Literal(REGISTRY_VERSION),
  records: Schema.Array(SecretRegistryRecord).check(Schema.isMaxLength(1_000)),
});
type SecretRegistryDocument = typeof SecretRegistryDocument.Type;

const PairingSecretPayload = Schema.Struct({
  version: Schema.Literal(1),
  source: PairedSource,
  instanceIdentity: InstanceIdentity,
  syncRoom: SyncRoom,
  signalingUrls: Schema.Array(SignalingUrl).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  roomSecret: RoomSecret,
  expiresAtMs: Schema.optionalKey(Expiration),
  capabilityToken: Schema.optionalKey(CapabilityToken),
  capabilityExpiresAtMs: Schema.optionalKey(Expiration),
  user: Schema.optionalKey(
    Schema.Struct({
      id: Schema.optionalKey(UserId),
      displayName: Schema.optionalKey(UserDisplayName),
      role: Schema.optionalKey(Role),
    }),
  ),
});
type PairingSecretPayload = typeof PairingSecretPayload.Type;

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const PublicRegistryDocumentJson = Schema.fromJsonString(PublicRegistryDocument);
const SecretRegistryDocumentJson = Schema.fromJsonString(SecretRegistryDocument);
const PairingSecretPayloadJson = Schema.fromJsonString(PairingSecretPayload);
const JwtPayloadJson = Schema.fromJsonString(
  Schema.Struct({ exp: Schema.optionalKey(Schema.Number.check(Schema.isFinite())) }),
);

export class CtoxInstanceRegistryError extends Schema.TaggedErrorClass<CtoxInstanceRegistryError>()(
  "CtoxInstanceRegistryError",
  { code: CtoxPairedInstanceMutationFailureCode },
) {
  override get message(): string {
    return "The CTOX paired instance registry operation failed.";
  }
}

/** Pairing material validated by the one invite/manual decoder in this module. */
export interface ValidatedPairing {
  readonly source: PairedSource;
  readonly displayName: string;
  readonly instanceIdentity: string;
  readonly syncRoom: string;
  readonly signalingUrls: readonly string[];
  readonly roomSecret: string;
  readonly expiresAtMs?: number;
  readonly capabilityToken?: string;
  readonly capabilityExpiresAtMs?: number;
  readonly role?: string;
  readonly userId?: string;
  readonly userDisplayName?: string;
}

export interface CtoxInstanceRegistryOptions {
  readonly nowEpochMs?: () => number;
  /** Overrides for read-only local-daemon discovery; the defaults are derived here. */
  readonly localDaemon?: CtoxLocalDaemonDiscoveryOptions;
}

export interface CtoxPairedLaunchDescriptor {
  readonly descriptor: CtoxManagedInstance;
  readonly config: CtoxBusinessOsLaunchConfig;
}

/**
 * A local daemon the main process may launch, together with the identity facts
 * the renderer never sees. `discoveredCount` lets the launch path decide
 * whether a freshly minted invite can be attributed to this daemon at all.
 */
export interface CtoxLocalDaemonTarget {
  readonly descriptor: CtoxManagedInstance;
  readonly daemonInstanceId: string;
  readonly discoveredCount: number;
}

export interface CtoxPairedInstanceRemoval {
  readonly descriptor: CtoxManagedInstance;
  readonly secretRecordRemoved: boolean;
}

export class CtoxInstanceRegistry extends Context.Service<
  CtoxInstanceRegistry,
  {
    readonly merge: (managed: CtoxManagedDiscoveryResult) => Effect.Effect<CtoxDiscoveryResult>;
    readonly importInvite: (
      invite: string,
    ) => Effect.Effect<CtoxManagedInstance, CtoxInstanceRegistryError>;
    readonly importManualPairing: (
      input: CtoxManualPairingImportInput,
    ) => Effect.Effect<CtoxManagedInstance, CtoxInstanceRegistryError>;
    readonly removePairedInstance: (
      instanceId: string,
    ) => Effect.Effect<CtoxPairedInstanceRemoval, CtoxInstanceRegistryError>;
    /**
     * Main-process-only identity of the paired CTOX instance behind a registry
     * id. The result is an opaque digest of the instance identity, so it stays
     * equal across re-pairing and across the two pairing sources while never
     * exposing the identity itself.
     */
    readonly stableIdentityKey: (
      instanceId: string,
    ) => Effect.Effect<string, CtoxInstanceRegistryError>;
    /** Main-process-only launch resolution; its secret-bearing result never crosses IPC. */
    readonly resolvePairedLaunch: (
      instanceId: string,
    ) => Effect.Effect<CtoxPairedLaunchDescriptor, CtoxInstanceRegistryError>;
    /**
     * Main-process-only re-discovery of one local daemon. It carries no secret:
     * local pairing material is minted per activation by the launch service.
     */
    readonly resolveLocalDaemonTarget: (
      instanceId: string,
    ) => Effect.Effect<CtoxLocalDaemonTarget, CtoxInstanceRegistryError>;
  }
>()("@t3tools/desktop/ctox/CtoxInstanceRegistry") {}

function registryError(code: CtoxPairedInstanceMutationFailureCodeType): CtoxInstanceRegistryError {
  return new CtoxInstanceRegistryError({ code });
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "[::1]") {
    return true;
  }
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

function normalizeSignalingUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.search !== "" ||
    /%(?:0[0-9a-f]|7f)/i.test(url.pathname)
  ) {
    return undefined;
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && isLoopbackHostname(hostname))) {
    return undefined;
  }
  return url.toString();
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

function bridgeValueIsEnabled(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (Predicate.isString(value)) {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "enabled" || normalized === "on";
  }
  if (Array.isArray(value)) return value.some(bridgeValueIsEnabled);
  if (!Predicate.isObject(value)) return false;
  return Object.entries(value).some(([key, entry]) => {
    const keyName = normalizedKey(key);
    return (
      ((keyName === "enabled" || keyName === "available" || keyName === "active") &&
        bridgeValueIsEnabled(entry)) ||
      bridgeValueIsEnabled(entry)
    );
  });
}

interface JsonInspectionOptions {
  readonly maxArrayLength: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly rejectHttpBridge: boolean;
  readonly rejectForbiddenPublicMetadata: boolean;
}

const FORBIDDEN_PUBLIC_KEYS = new Set([
  "authorizationref",
  "capabilitytoken",
  "ciphertext",
  "connection",
  "credential",
  "instanceidentity",
  "instanceid",
  "launchurl",
  "pairing",
  "partition",
  "roompassword",
  "roomsecret",
  "secretref",
  "secretrefs",
  "signalingroompassword",
  "signalingurl",
  "signalingurls",
  "syncroom",
  "tenantid",
  "token",
]);

function inspectJson(value: unknown, options: JsonInspectionOptions): boolean {
  const pending: Array<{ readonly depth: number; readonly value: unknown }> = [{ depth: 0, value }];
  let nodes = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || current.depth > options.maxDepth) return false;
    nodes += 1;
    if (nodes > options.maxNodes) return false;

    if (Predicate.isString(current.value)) {
      if (current.value.length > 16_384 || !Schema.is(SafeText)(current.value)) return false;
      continue;
    }
    if (Array.isArray(current.value)) {
      if (current.value.length > options.maxArrayLength) return false;
      for (const entry of current.value) {
        pending.push({ depth: current.depth + 1, value: entry });
      }
      continue;
    }
    if (!Predicate.isObject(current.value)) continue;

    const entries = Object.entries(current.value);
    if (entries.length > 64) return false;
    for (const [key, entry] of entries) {
      if (key.length > 256 || !Schema.is(SafeText)(key)) return false;
      const keyName = normalizedKey(key);
      if (
        options.rejectHttpBridge &&
        (keyName.includes("httpbridge") || keyName === "httpdataproxy") &&
        bridgeValueIsEnabled(entry)
      ) {
        return false;
      }
      if (
        options.rejectForbiddenPublicMetadata &&
        (FORBIDDEN_PUBLIC_KEYS.has(keyName) ||
          keyName.includes("password") ||
          keyName.includes("secret") ||
          keyName.includes("credential") ||
          keyName.includes("cipher"))
      ) {
        return false;
      }
      pending.push({ depth: current.depth + 1, value: entry });
    }
  }
  return true;
}

function parseDateTimeEpoch(value: string): number | undefined {
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.toEpochMillis(parsed.value) : undefined;
}

type JwtExpiration =
  | { readonly _tag: "not_jwt" }
  | { readonly _tag: "invalid" }
  | { readonly _tag: "valid"; readonly expiresAtMs?: number };

function jwtExpiration(token: string): JwtExpiration {
  const parts = token.split(".");
  if (parts.length !== 3) return { _tag: "not_jwt" };
  const payload = Result.getOrUndefined(Encoding.decodeBase64UrlString(parts[1] ?? ""));
  if (payload === undefined) return { _tag: "invalid" };
  const decoded = Schema.decodeUnknownOption(JwtPayloadJson)(payload, {
    onExcessProperty: "preserve",
  });
  if (Option.isNone(decoded)) return { _tag: "invalid" };
  if (decoded.value.exp === undefined) return { _tag: "valid" };
  const expiresAtMs = decoded.value.exp * 1_000;
  return Number.isSafeInteger(expiresAtMs) && expiresAtMs > 0
    ? { _tag: "valid", expiresAtMs }
    : { _tag: "invalid" };
}

function pairingIsUnexpired(pairing: ValidatedPairing, nowEpochMs: number): boolean {
  if (pairing.expiresAtMs !== undefined && pairing.expiresAtMs <= nowEpochMs) return false;
  if (pairing.capabilityExpiresAtMs !== undefined && pairing.capabilityToken === undefined) {
    return false;
  }
  if (pairing.capabilityExpiresAtMs !== undefined && pairing.capabilityExpiresAtMs <= nowEpochMs) {
    return false;
  }
  if (pairing.capabilityToken === undefined) return true;
  const expiration = jwtExpiration(pairing.capabilityToken);
  return (
    expiration._tag !== "invalid" &&
    (expiration._tag !== "valid" ||
      expiration.expiresAtMs === undefined ||
      expiration.expiresAtMs > nowEpochMs)
  );
}

function normalizePairing(
  input: ValidatedPairing,
  nowEpochMs: number,
): ValidatedPairing | undefined {
  const normalizedUrls = new Set<string>();
  for (const rawUrl of input.signalingUrls) {
    const url = normalizeSignalingUrl(rawUrl);
    if (url === undefined) return undefined;
    normalizedUrls.add(url);
  }
  const signalingUrls = [...normalizedUrls].sort();
  if (signalingUrls.length === 0 || !pairingIsUnexpired(input, nowEpochMs)) return undefined;
  return { ...input, signalingUrls };
}

function inviteInputText(rawInvite: string): string | undefined {
  const input = rawInvite.trim();
  if (input.length === 0 || textEncoder.encode(input).length > MAX_INVITE_BYTES) return undefined;
  if (!input.startsWith("ctox-business-os-desktop://")) return input;

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "ctox-business-os-desktop:" ||
    url.hostname !== "pair" ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    return undefined;
  }
  const payloadValues = url.searchParams.getAll("payload");
  if (payloadValues.length !== 1 || [...url.searchParams.keys()].some((key) => key !== "payload")) {
    return undefined;
  }
  const decoded = Result.getOrUndefined(Encoding.decodeBase64UrlString(payloadValues[0] ?? ""));
  return decoded !== undefined && textEncoder.encode(decoded).length <= MAX_INVITE_BYTES
    ? decoded
    : undefined;
}

function pairingFromInvite(
  payload: InvitePayload,
  nowEpochMs: number,
): ValidatedPairing | undefined {
  const expirationCandidates: number[] = [];
  if (payload.expires_at !== undefined) {
    const parsed = parseDateTimeEpoch(payload.expires_at);
    if (parsed === undefined) return undefined;
    expirationCandidates.push(parsed);
  }
  if (payload.expires_at_ms !== undefined) expirationCandidates.push(payload.expires_at_ms);
  const expiresAtMs =
    expirationCandidates.length === 0 ? undefined : Math.min(...expirationCandidates);
  const capabilityTokens = [payload.capability_token, payload.session?.capability_token].filter(
    (token): token is string => token !== undefined,
  );
  if (new Set(capabilityTokens).size > 1) return undefined;
  const capabilityToken = capabilityTokens[0];
  const capabilityExpirationCandidates = [
    payload.capability_expires_at_ms,
    payload.session?.capability_expires_at_ms,
  ].filter((expiration): expiration is number => expiration !== undefined);
  const capabilityExpiresAtMs =
    capabilityExpirationCandidates.length === 0
      ? undefined
      : Math.min(...capabilityExpirationCandidates);
  const user = payload.session?.user;
  const userDisplayName = user?.display_name ?? user?.displayName;
  const instanceIdentity =
    payload.instance_id ?? payload.sync_room.slice(PAIRING_ROOM_PREFIX.length);
  return normalizePairing(
    {
      source: "pairing_invite",
      displayName: payload.display_name,
      instanceIdentity,
      syncRoom: payload.sync_room,
      signalingUrls: payload.signaling_urls,
      roomSecret: payload.signaling_room_password,
      ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
      ...(capabilityToken === undefined ? {} : { capabilityToken }),
      ...(capabilityExpiresAtMs === undefined ? {} : { capabilityExpiresAtMs }),
      ...(user?.role === undefined ? {} : { role: user.role }),
      ...(user?.id === undefined ? {} : { userId: user.id }),
      ...(userDisplayName === undefined ? {} : { userDisplayName }),
    },
    nowEpochMs,
  );
}

export function parseCtoxPairingInvite(
  rawInvite: string,
  nowEpochMs: number,
): Effect.Effect<ValidatedPairing, CtoxInstanceRegistryError> {
  const json = inviteInputText(rawInvite);
  if (json === undefined) return Effect.fail(registryError("invalid_invite"));
  return Schema.decodeUnknownEffect(UnknownJson)(json).pipe(
    Effect.filterOrFail(
      (value) =>
        inspectJson(value, {
          maxArrayLength: MAX_INVITE_ARRAY_LENGTH,
          maxDepth: MAX_JSON_DEPTH,
          maxNodes: MAX_JSON_NODES,
          rejectHttpBridge: true,
          rejectForbiddenPublicMetadata: false,
        }),
      () => registryError("invalid_invite"),
    ),
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(InvitePayload)(value, { onExcessProperty: "error" }),
    ),
    Effect.flatMap((payload) => {
      const pairing = pairingFromInvite(payload, nowEpochMs);
      return pairing === undefined
        ? Effect.fail(registryError("invalid_invite"))
        : Effect.succeed(pairing);
    }),
    Effect.mapError(() => registryError("invalid_invite")),
  );
}

function pairingFromManual(
  input: CtoxManualPairingImportInput,
  nowEpochMs: number,
): ValidatedPairing | undefined {
  const instanceIdentity = input.instanceId ?? input.syncRoom.slice(PAIRING_ROOM_PREFIX.length);
  return normalizePairing(
    {
      source: "manual_pairing",
      displayName: input.displayName,
      instanceIdentity,
      syncRoom: input.syncRoom,
      signalingUrls: input.signalingUrls,
      roomSecret: input.roomSecret,
      ...(input.capabilityToken === undefined ? {} : { capabilityToken: input.capabilityToken }),
      ...(input.capabilityExpiresAtMs === undefined
        ? {}
        : { capabilityExpiresAtMs: input.capabilityExpiresAtMs }),
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.userId === undefined ? {} : { userId: input.userId }),
    },
    nowEpochMs,
  );
}

function sourceOrder(source: CtoxManagedInstanceSource): number {
  switch (source) {
    case "ctox_dev":
      return 0;
    case "pairing_invite":
      return 1;
    case "manual_pairing":
      return 2;
    case "local_daemon":
      return 3;
    case "ssh_managed":
      return 4;
  }
}

function compareInstances(left: CtoxManagedInstance, right: CtoxManagedInstance): number {
  const sourceDifference = sourceOrder(left.source) - sourceOrder(right.source);
  if (sourceDifference !== 0) return sourceDifference;
  const leftName = left.displayName.toLowerCase();
  const rightName = right.displayName.toLowerCase();
  if (leftName !== rightName) return leftName < rightName ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

/**
 * The one registry result. Locally discovered daemons join the same merge as
 * managed and paired entries: deduplicated by source and id, capacity-bounded
 * with the persisted local sources first, and sorted deterministically.
 */
export function mergeCtoxInstanceSources(
  managed: CtoxManagedDiscoveryResult,
  paired: readonly CtoxManagedInstance[],
  local: readonly CtoxManagedInstance[] = [],
): CtoxDiscoveryResult {
  if (paired.length === 0 && local.length === 0) return managed;

  const ownedBySourceAndId = new Map<string, CtoxManagedInstance>();
  for (const instance of [...paired, ...local]) {
    ownedBySourceAndId.set(`${instance.source}\0${instance.id}`, instance);
  }
  const retainedOwned = [...ownedBySourceAndId.values()].sort(compareInstances).slice(0, 1_000);
  const capacityForManaged = 1_000 - retainedOwned.length;
  const managedInstances = managed._tag === "ready" ? managed.instances : [];
  const managedBySourceAndId = new Map<string, CtoxManagedInstance>();
  for (const instance of managedInstances) {
    const key = `${instance.source}\0${instance.id}`;
    if (!ownedBySourceAndId.has(key)) managedBySourceAndId.set(key, instance);
  }
  const retainedManaged = [...managedBySourceAndId.values()]
    .sort(compareInstances)
    .slice(0, capacityForManaged);

  return {
    _tag: "ready",
    instances: [...retainedManaged, ...retainedOwned].sort(compareInstances),
    managedState: managed._tag,
    ...(managed._tag === "failed" ? { managedFailureCode: managed.code } : {}),
  };
}

function emptyPublicDocument(): PublicRegistryDocument {
  return { version: REGISTRY_VERSION, instances: [] };
}

function emptySecretDocument(): SecretRegistryDocument {
  return { version: REGISTRY_VERSION, records: [] };
}

function readFileOrEmpty(
  fileSystem: FileSystem.FileSystem,
  filePath: string,
  maximumBytes: number,
): Effect.Effect<string | undefined, CtoxInstanceRegistryError> {
  return fileSystem.readFileString(filePath).pipe(
    Effect.filterOrFail(
      (raw) => textEncoder.encode(raw).length <= maximumBytes,
      () => registryError("persistence_failed"),
    ),
    Effect.map((raw) => raw as string | undefined),
    Effect.catch((error) => {
      if (error instanceof PlatformError.PlatformError && error.reason._tag === "NotFound") {
        return Effect.succeed(undefined);
      }
      return Effect.fail(registryError("persistence_failed"));
    }),
  );
}

function isSafePersistedPairedInstance(instance: CtoxManagedInstance): boolean {
  const pairedSource = instance.source === "pairing_invite" || instance.source === "manual_pairing";
  return (
    pairedSource &&
    instance.id.startsWith(`paired:${instance.source}:`) &&
    /^paired:(?:pairing_invite|manual_pairing):[A-Za-z0-9_-]{22}$/.test(instance.id) &&
    instance.domain === undefined &&
    instance.status === "paired" &&
    instance.healthSummary.dataPlaneReady === false &&
    instance.healthSummary.httpDataProxy === false &&
    instance.healthSummary.nativePeerObserved === false
  );
}

function readPublicDocument(
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<PublicRegistryDocument, CtoxInstanceRegistryError> {
  return readFileOrEmpty(fileSystem, filePath, MAX_PUBLIC_DOCUMENT_BYTES).pipe(
    Effect.flatMap((raw) => {
      if (raw === undefined) return Effect.succeed(emptyPublicDocument());
      return Schema.decodeUnknownEffect(UnknownJson)(raw).pipe(
        Effect.filterOrFail(
          (value) =>
            inspectJson(value, {
              maxArrayLength: 1_000,
              maxDepth: 8,
              maxNodes: 12_000,
              rejectHttpBridge: false,
              rejectForbiddenPublicMetadata: true,
            }),
          () => registryError("persistence_failed"),
        ),
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(PublicRegistryDocument)(value, {
            onExcessProperty: "error",
          }),
        ),
        Effect.filterOrFail(
          (document) => {
            const ids = new Set<string>();
            return document.instances.every((instance) => {
              const unique = !ids.has(instance.id);
              ids.add(instance.id);
              return isSafePersistedPairedInstance(instance) && unique;
            });
          },
          () => registryError("persistence_failed"),
        ),
        Effect.mapError(() => registryError("persistence_failed")),
      );
    }),
  );
}

function readSecretDocument(
  fileSystem: FileSystem.FileSystem,
  filePath: string,
): Effect.Effect<SecretRegistryDocument, CtoxInstanceRegistryError> {
  return readFileOrEmpty(fileSystem, filePath, MAX_SECRET_DOCUMENT_BYTES).pipe(
    Effect.flatMap((raw) =>
      raw === undefined
        ? Effect.succeed(emptySecretDocument())
        : Schema.decodeUnknownEffect(SecretRegistryDocumentJson)(raw, {
            onExcessProperty: "error",
          }).pipe(
            Effect.filterOrFail(
              (document) => {
                const ids = document.records.map((record) => record.id);
                return new Set(ids).size === ids.length;
              },
              () => registryError("persistence_failed"),
            ),
            Effect.mapError(() => registryError("persistence_failed")),
          ),
    ),
  );
}

function assertRegistryConsistency(
  publicDocument: PublicRegistryDocument,
  secretDocument: SecretRegistryDocument,
): Effect.Effect<void, CtoxInstanceRegistryError> {
  const secretIds = new Set(secretDocument.records.map((record) => record.id));
  return publicDocument.instances.every((instance) => secretIds.has(instance.id))
    ? Effect.void
    : Effect.fail(registryError("persistence_failed"));
}

const writeDocument = Effect.fn("CtoxInstanceRegistry.writeDocument")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly crypto: Crypto.Crypto;
  readonly filePath: string;
  readonly contents: string;
}) {
  const suffix = yield* input.crypto.randomUUIDv4.pipe(
    Effect.map((uuid) => uuid.replaceAll("-", "")),
    Effect.mapError(() => registryError("persistence_failed")),
  );
  const directory = input.path.dirname(input.filePath);
  const temporaryPath = `${input.filePath}.${process.pid}.${suffix}.tmp`;
  yield* input.fileSystem
    .makeDirectory(directory, { recursive: true })
    .pipe(Effect.mapError(() => registryError("persistence_failed")));
  yield* input.fileSystem
    .writeFileString(temporaryPath, `${input.contents}\n`)
    .pipe(Effect.mapError(() => registryError("persistence_failed")));
  yield* input.fileSystem
    .rename(temporaryPath, input.filePath)
    .pipe(Effect.mapError(() => registryError("persistence_failed")));
});

export const make = Effect.fn("CtoxInstanceRegistry.make")(function* (
  options: CtoxInstanceRegistryOptions = {},
) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const registryLock = yield* Semaphore.make(1);
  const ctoxDirectory = path.join(environment.stateDir, "ctox");
  const publicRegistryPath = path.join(ctoxDirectory, PUBLIC_REGISTRY_FILE);
  const secretRegistryPath = path.join(ctoxDirectory, SECRET_REGISTRY_FILE);
  const currentTimeMillis =
    options.nowEpochMs === undefined
      ? DateTime.now.pipe(Effect.map(DateTime.toEpochMillis))
      : Effect.sync(options.nowEpochMs);
  // Health probing stays opt-in: no probe is injected yet, so discovery reads
  // only the descriptor. The probe arrives with the local launch path.
  const localDaemonOptions: CtoxLocalDaemonDiscoveryOptions = {
    homeDirectory: environment.homeDirectory,
    env: process.env,
    ...(options.nowEpochMs === undefined ? {} : { nowEpochMs: options.nowEpochMs }),
    ...options.localDaemon,
  };
  // Discovery runs with the services acquired here, never with the caller's.
  const discoverLocalInstances = discoverCtoxLocalDaemonInstances(localDaemonOptions).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  const writePublic = Effect.fn("CtoxInstanceRegistry.writePublic")(function* (
    document: PublicRegistryDocument,
  ) {
    const contents = yield* Schema.encodeEffect(PublicRegistryDocumentJson)(document).pipe(
      Effect.mapError(() => registryError("persistence_failed")),
    );
    yield* writeDocument({ fileSystem, path, crypto, filePath: publicRegistryPath, contents });
  });

  const writeSecrets = Effect.fn("CtoxInstanceRegistry.writeSecrets")(function* (
    document: SecretRegistryDocument,
  ) {
    const contents = yield* Schema.encodeEffect(SecretRegistryDocumentJson)(document).pipe(
      Effect.mapError(() => registryError("persistence_failed")),
    );
    yield* writeDocument({ fileSystem, path, crypto, filePath: secretRegistryPath, contents });
  });

  const assertSafeStorage = Effect.fn("CtoxInstanceRegistry.assertSafeStorage")(function* () {
    const available = yield* safeStorage.isEncryptionAvailable.pipe(
      Effect.mapError(() => registryError("unsafe_secret_storage")),
    );
    const backend = yield* safeStorage.selectedStorageBackend;
    const unsafeBackend =
      (Option.isSome(backend) && backend.value === "basic_text") ||
      (environment.platform === "linux" && Option.isNone(backend));
    if (!available || unsafeBackend) {
      return yield* registryError("unsafe_secret_storage");
    }
  });

  const stableId = Effect.fn("CtoxInstanceRegistry.stableId")(function* (
    source: PairedSource,
    instanceIdentity: string,
  ) {
    const digest = yield* crypto
      .digest("SHA-256", textEncoder.encode(`${source}\0${instanceIdentity}`))
      .pipe(Effect.mapError(() => registryError("persistence_failed")));
    return `paired:${source}:${Encoding.encodeBase64Url(digest).slice(0, 22)}`;
  });

  const instanceIdentityKey = Effect.fn("CtoxInstanceRegistry.instanceIdentityKey")(function* (
    instanceIdentity: string,
  ) {
    const digest = yield* crypto
      .digest("SHA-256", textEncoder.encode(`ctox-instance\0${instanceIdentity}`))
      .pipe(Effect.mapError(() => registryError("persistence_failed")));
    return `ctox:${Encoding.encodeBase64Url(digest).slice(0, 22)}`;
  });

  const decryptSecret = Effect.fn("CtoxInstanceRegistry.decryptSecret")(function* (
    record: SecretRegistryDocument["records"][number],
  ) {
    const encrypted = Result.getOrUndefined(Encoding.decodeBase64(record.ciphertext));
    if (encrypted === undefined) return yield* registryError("persistence_failed");
    const secretJson = yield* safeStorage
      .decryptString(encrypted)
      .pipe(Effect.mapError(() => registryError("unsafe_secret_storage")));
    return yield* Schema.decodeUnknownEffect(PairingSecretPayloadJson)(secretJson, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => registryError("persistence_failed")));
  });

  const readPairedInstances = Effect.fn("CtoxInstanceRegistry.readPairedInstances")(function* () {
    yield* assertSafeStorage();
    const [publicDocument, secretDocument] = yield* Effect.all([
      readPublicDocument(fileSystem, publicRegistryPath),
      readSecretDocument(fileSystem, secretRegistryPath),
    ]);
    yield* assertRegistryConsistency(publicDocument, secretDocument);
    const secretsById = new Map(secretDocument.records.map((record) => [record.id, record]));
    const now = yield* currentTimeMillis;
    const instances: CtoxManagedInstance[] = [];
    for (const instance of publicDocument.instances) {
      const record = secretsById.get(instance.id);
      if (record === undefined) return yield* registryError("persistence_failed");
      const secret = yield* decryptSecret(record);
      const expectedId = yield* stableId(secret.source, secret.instanceIdentity);
      if (expectedId !== instance.id || secret.source !== instance.source) {
        return yield* registryError("persistence_failed");
      }
      instances.push({
        ...instance,
        status: pairingIsUnexpired(
          {
            source: secret.source,
            displayName: instance.displayName,
            instanceIdentity: secret.instanceIdentity,
            syncRoom: secret.syncRoom,
            signalingUrls: secret.signalingUrls,
            roomSecret: secret.roomSecret,
            ...(secret.expiresAtMs === undefined ? {} : { expiresAtMs: secret.expiresAtMs }),
            ...(secret.capabilityToken === undefined
              ? {}
              : { capabilityToken: secret.capabilityToken }),
            ...(secret.capabilityExpiresAtMs === undefined
              ? {}
              : { capabilityExpiresAtMs: secret.capabilityExpiresAtMs }),
          },
          now,
        )
          ? "paired"
          : "pairing_expired",
      });
    }
    return instances.sort(compareInstances);
  });

  const resolvePairedLaunch = Effect.fn("CtoxInstanceRegistry.resolvePairedLaunch")(function* (
    instanceId: string,
  ) {
    if (!/^paired:(?:pairing_invite|manual_pairing):[A-Za-z0-9_-]{22}$/.test(instanceId)) {
      return yield* registryError("not_found");
    }
    yield* assertSafeStorage();
    const [publicDocument, secretDocument] = yield* Effect.all([
      readPublicDocument(fileSystem, publicRegistryPath),
      readSecretDocument(fileSystem, secretRegistryPath),
    ]);
    yield* assertRegistryConsistency(publicDocument, secretDocument);
    const descriptor = publicDocument.instances.find((instance) => instance.id === instanceId);
    const record = secretDocument.records.find((entry) => entry.id === instanceId);
    if (
      descriptor === undefined ||
      record === undefined ||
      !isSafePersistedPairedInstance(descriptor)
    ) {
      return yield* registryError("not_found");
    }

    const secret = yield* decryptSecret(record);
    const expectedId = yield* stableId(secret.source, secret.instanceIdentity);
    if (
      expectedId !== descriptor.id ||
      secret.source !== descriptor.source ||
      descriptor.role !== secret.user?.role
    ) {
      return yield* registryError("persistence_failed");
    }
    const now = yield* currentTimeMillis;
    const pairing = normalizePairing(
      {
        source: secret.source,
        displayName: descriptor.displayName,
        instanceIdentity: secret.instanceIdentity,
        syncRoom: secret.syncRoom,
        signalingUrls: secret.signalingUrls,
        roomSecret: secret.roomSecret,
        ...(secret.expiresAtMs === undefined ? {} : { expiresAtMs: secret.expiresAtMs }),
        ...(secret.capabilityToken === undefined
          ? {}
          : { capabilityToken: secret.capabilityToken }),
        ...(secret.capabilityExpiresAtMs === undefined
          ? {}
          : { capabilityExpiresAtMs: secret.capabilityExpiresAtMs }),
        ...(secret.user?.role === undefined ? {} : { role: secret.user.role }),
        ...(secret.user?.id === undefined ? {} : { userId: secret.user.id }),
        ...(secret.user?.displayName === undefined
          ? {}
          : { userDisplayName: secret.user.displayName }),
      },
      now,
    );
    if (pairing === undefined) return yield* registryError("not_found");

    const user = secret.user;
    const config: CtoxBusinessOsLaunchConfig = buildCtoxBusinessOsLaunchConfig({
      instanceId: descriptor.id,
      displayName: descriptor.displayName,
      source: pairing.source,
      material: {
        syncRoom: pairing.syncRoom,
        signalingUrls: pairing.signalingUrls,
        roomSecret: pairing.roomSecret,
        ...(pairing.capabilityToken === undefined
          ? {}
          : { capabilityToken: pairing.capabilityToken }),
        ...(pairing.capabilityExpiresAtMs === undefined
          ? {}
          : { capabilityExpiresAtMs: pairing.capabilityExpiresAtMs }),
        ...(user === undefined ? {} : { user }),
      },
    });
    return { descriptor, config };
  });

  const resolveLocalDaemonTarget = Effect.fn("CtoxInstanceRegistry.resolveLocalDaemonTarget")(
    function* (instanceId: string) {
      const discovered = yield* discoverLocalInstances;
      const target = discovered.find((entry) => entry.instance.id === instanceId);
      if (target === undefined || !isLaunchableCtoxLocalDaemon(target.instance)) {
        return yield* registryError("not_found");
      }
      return {
        descriptor: target.instance,
        daemonInstanceId: target.daemonInstanceId,
        discoveredCount: discovered.length,
      };
    },
  );

  const stableIdentityKey = Effect.fn("CtoxInstanceRegistry.stableIdentityKey")(function* (
    instanceId: string,
  ) {
    if (!/^paired:(?:pairing_invite|manual_pairing):[A-Za-z0-9_-]{22}$/.test(instanceId)) {
      return yield* registryError("not_found");
    }
    yield* assertSafeStorage();
    const [publicDocument, secretDocument] = yield* Effect.all([
      readPublicDocument(fileSystem, publicRegistryPath),
      readSecretDocument(fileSystem, secretRegistryPath),
    ]);
    const descriptor = publicDocument.instances.find((instance) => instance.id === instanceId);
    const record = secretDocument.records.find((entry) => entry.id === instanceId);
    if (
      descriptor === undefined ||
      record === undefined ||
      !isSafePersistedPairedInstance(descriptor)
    ) {
      return yield* registryError("not_found");
    }
    const secret = yield* decryptSecret(record);
    const expectedId = yield* stableId(secret.source, secret.instanceIdentity);
    if (expectedId !== descriptor.id || secret.source !== descriptor.source) {
      return yield* registryError("persistence_failed");
    }
    return yield* instanceIdentityKey(secret.instanceIdentity);
  });

  const importPairing = Effect.fn("CtoxInstanceRegistry.importPairing")(function* (
    pairing: ValidatedPairing,
  ) {
    yield* assertSafeStorage();
    const [publicDocument, secretDocument] = yield* Effect.all([
      readPublicDocument(fileSystem, publicRegistryPath),
      readSecretDocument(fileSystem, secretRegistryPath),
    ]);
    yield* assertRegistryConsistency(publicDocument, secretDocument);

    const id = yield* stableId(pairing.source, pairing.instanceIdentity);
    const publicInstance: CtoxManagedInstance = {
      id,
      source: pairing.source,
      displayName: pairing.displayName,
      status: "paired",
      ...(pairing.role === undefined ? {} : { role: pairing.role }),
      healthSummary: {
        dataPlane: "rxdb-webrtc",
        dataPlaneReady: false,
        httpDataProxy: false,
        nativePeerObserved: false,
      },
    };
    const secretPayload: PairingSecretPayload = {
      version: 1,
      source: pairing.source,
      instanceIdentity: pairing.instanceIdentity,
      syncRoom: pairing.syncRoom,
      signalingUrls: pairing.signalingUrls,
      roomSecret: pairing.roomSecret,
      ...(pairing.expiresAtMs === undefined ? {} : { expiresAtMs: pairing.expiresAtMs }),
      ...(pairing.capabilityToken === undefined
        ? {}
        : { capabilityToken: pairing.capabilityToken }),
      ...(pairing.capabilityExpiresAtMs === undefined
        ? {}
        : { capabilityExpiresAtMs: pairing.capabilityExpiresAtMs }),
      ...(pairing.userId === undefined &&
      pairing.userDisplayName === undefined &&
      pairing.role === undefined
        ? {}
        : {
            user: {
              ...(pairing.userId === undefined ? {} : { id: pairing.userId }),
              ...(pairing.userDisplayName === undefined
                ? {}
                : { displayName: pairing.userDisplayName }),
              ...(pairing.role === undefined ? {} : { role: pairing.role }),
            },
          }),
    };
    const secretJson = yield* Schema.encodeEffect(PairingSecretPayloadJson)(secretPayload).pipe(
      Effect.mapError(() => registryError("persistence_failed")),
    );
    const ciphertext = Encoding.encodeBase64(
      yield* safeStorage
        .encryptString(secretJson)
        .pipe(Effect.mapError(() => registryError("unsafe_secret_storage"))),
    );
    const nextPublic: PublicRegistryDocument = {
      version: REGISTRY_VERSION,
      instances: [
        ...publicDocument.instances.filter((instance) => instance.id !== id),
        publicInstance,
      ].sort(compareInstances),
    };
    const nextSecrets: SecretRegistryDocument = {
      version: REGISTRY_VERSION,
      records: [
        ...secretDocument.records.filter((record) => record.id !== id),
        { id, ciphertext },
      ].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
    };

    // Remove any prior public target before changing its secret. Every failure
    // point therefore leaves either the old untouched pair or no public target.
    yield* writePublic({
      version: REGISTRY_VERSION,
      instances: publicDocument.instances.filter((instance) => instance.id !== id),
    });
    yield* writeSecrets(nextSecrets);
    yield* writePublic(nextPublic);
    return publicInstance;
  });

  return CtoxInstanceRegistry.of({
    resolvePairedLaunch: (instanceId) => registryLock.withPermit(resolvePairedLaunch(instanceId)),
    resolveLocalDaemonTarget: (instanceId) =>
      registryLock.withPermit(resolveLocalDaemonTarget(instanceId)),
    stableIdentityKey: (instanceId) => registryLock.withPermit(stableIdentityKey(instanceId)),
    merge: (managed) =>
      registryLock.withPermit(
        Effect.gen(function* () {
          // A failed or missing pairing store must not hide local daemons, and
          // local discovery cannot fail, so both degrade to an empty source.
          const paired = yield* readPairedInstances().pipe(
            Effect.orElseSucceed((): readonly CtoxManagedInstance[] => []),
          );
          const local = yield* discoverLocalInstances;
          return mergeCtoxInstanceSources(
            managed,
            paired,
            local.map((entry) => entry.instance),
          );
        }).pipe(Effect.withSpan("CtoxInstanceRegistry.merge")),
      ),
    importInvite: (invite) =>
      registryLock.withPermit(
        Effect.gen(function* () {
          const now = yield* currentTimeMillis;
          return yield* importPairing(yield* parseCtoxPairingInvite(invite, now));
        }),
      ),
    importManualPairing: (input) =>
      registryLock.withPermit(
        Effect.gen(function* () {
          const pairing = pairingFromManual(input, yield* currentTimeMillis);
          if (pairing === undefined) {
            return yield* registryError("invalid_input");
          }
          return yield* importPairing(pairing);
        }),
      ),
    removePairedInstance: (instanceId) =>
      registryLock.withPermit(
        Effect.gen(function* () {
          if (!instanceId.startsWith("paired:")) {
            return yield* registryError("managed_not_removable");
          }
          if (!/^paired:(?:pairing_invite|manual_pairing):[A-Za-z0-9_-]{22}$/.test(instanceId)) {
            return yield* registryError("not_found");
          }
          const [publicDocument, secretDocument] = yield* Effect.all([
            readPublicDocument(fileSystem, publicRegistryPath),
            readSecretDocument(fileSystem, secretRegistryPath),
          ]);
          yield* assertRegistryConsistency(publicDocument, secretDocument);
          const descriptor = publicDocument.instances.find(
            (instance) => instance.id === instanceId,
          );
          if (descriptor === undefined || !isSafePersistedPairedInstance(descriptor)) {
            return yield* registryError("not_found");
          }

          // Metadata is removed first. A later secret failure leaves only an
          // encrypted orphan and cannot leave a launchable public descriptor.
          yield* writePublic({
            version: REGISTRY_VERSION,
            instances: publicDocument.instances.filter((instance) => instance.id !== instanceId),
          });
          const secretRecordRemoved = yield* writeSecrets({
            version: REGISTRY_VERSION,
            records: secretDocument.records.filter((record) => record.id !== instanceId),
          }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
          return { descriptor, secretRecordRemoved };
        }),
      ),
  });
});

export const layer = (options: CtoxInstanceRegistryOptions = {}) =>
  Layer.effect(CtoxInstanceRegistry, make(options));
