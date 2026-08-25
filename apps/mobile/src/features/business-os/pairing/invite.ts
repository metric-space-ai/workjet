import { buildWorkjetUrl, normalizeIncomingWorkjetUrl } from "../../../lib/workjetLinks";

export const BUSINESS_OS_INVITE_TYPE = "ctox-business-os-invite";
export const BUSINESS_OS_INVITE_VERSION = 1;
const ROOM_PREFIX = "ctox-business-os:";
const MAX_ENCODED_PAYLOAD_LENGTH = 262_144;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const SUPPORTED_ROLES = new Set(["chef", "admin", "founder", "user"] as const);

export type BusinessOsRole = "chef" | "admin" | "founder" | "user";

export interface ValidatedBusinessOsInvite {
  readonly type: typeof BUSINESS_OS_INVITE_TYPE;
  readonly version: typeof BUSINESS_OS_INVITE_VERSION;
  readonly displayName: string;
  readonly instanceId: string;
  readonly syncRoom: string;
  readonly nativePeerId: string;
  readonly signalingUrls: readonly string[];
  readonly password: string;
  readonly expiresAt: string;
  readonly expiresAtMs: number;
  readonly session: {
    readonly authenticated: true;
    readonly source: string;
    readonly capabilityToken: string;
    readonly capabilityExpiresAtMs: number;
    readonly user: {
      readonly id: string;
      readonly displayName: string;
      readonly role: BusinessOsRole;
      readonly isAdmin: boolean;
    };
  };
}

export class BusinessOsInviteValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BusinessOsInviteValidationError";
  }
}

function fail(code: string, message: string): never {
  throw new BusinessOsInviteValidationError(code, message);
}

function asRecord(value: unknown, code: string, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code, message);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, code: string, label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(code, `${label} is required`);
  return value.trim();
}

function parseTime(value: unknown, code: string, label: string): number {
  const text = requiredString(value, code, label);
  if (!RFC3339_PATTERN.test(text)) fail(code, `${label} must be RFC3339`);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) fail(code, `${label} must be RFC3339`);
  return milliseconds;
}

function validateSignalingUrl(value: unknown): string {
  const text = requiredString(value, "signaling_url", "signaling URL");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail("signaling_url", "signaling URL is invalid");
  }
  if (url.username || url.password || url.hash) {
    fail("signaling_url", "signaling URL contains unsupported components");
  }
  if (url.protocol !== "wss:" || !url.hostname) {
    fail("signaling_url", "signaling URLs must use wss");
  }
  return url.toString();
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += BASE64URL_ALPHABET[first >> 2];
    encoded += BASE64URL_ALPHABET[((first & 3) << 4) | ((second ?? 0) >> 4)];
    if (second !== undefined) {
      encoded += BASE64URL_ALPHABET[((second & 15) << 2) | ((third ?? 0) >> 6)];
    }
    if (third !== undefined) encoded += BASE64URL_ALPHABET[third & 63];
  }
  return encoded;
}

function decodeBase64Url(value: string): string {
  if (
    !/^[A-Za-z0-9_-]+$/u.test(value) ||
    value.length > MAX_ENCODED_PAYLOAD_LENGTH ||
    value.length % 4 === 1
  ) {
    fail("payload", "pairing payload is invalid");
  }
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const a = BASE64URL_ALPHABET.indexOf(value[index] ?? "");
    const b = BASE64URL_ALPHABET.indexOf(value[index + 1] ?? "");
    const c = value[index + 2] === undefined ? -1 : BASE64URL_ALPHABET.indexOf(value[index + 2]);
    const d = value[index + 3] === undefined ? -1 : BASE64URL_ALPHABET.indexOf(value[index + 3]);
    if (a < 0 || b < 0 || c < -1 || d < -1) fail("payload", "pairing payload is invalid");
    bytes.push((a << 2) | (b >> 4));
    if (c >= 0) bytes.push(((b & 15) << 4) | (c >> 2));
    if (d >= 0 && c >= 0) bytes.push(((c & 3) << 6) | d);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return fail("payload", "pairing payload is invalid");
  }
}

function decodePayload(encoded: string): unknown {
  const decoded = decodeBase64Url(encoded);
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    return fail("json", "pairing payload is not valid JSON");
  }
}

export function validateBusinessOsInviteV1(
  input: unknown,
  options: { readonly now?: number } = {},
): ValidatedBusinessOsInvite {
  const invite = asRecord(input, "object", "invite must be an object");
  const now = options.now ?? Date.now();
  if (invite.type !== BUSINESS_OS_INVITE_TYPE) fail("type", "unsupported invite type");
  if (invite.version !== BUSINESS_OS_INVITE_VERSION) fail("version", "unsupported invite version");

  const displayName = requiredString(invite.display_name, "display_name", "display_name");
  const instanceId = requiredString(invite.instance_id, "instance_id", "instance_id");
  const syncRoom = requiredString(invite.sync_room, "sync_room", "sync_room");
  if (!syncRoom.startsWith(ROOM_PREFIX) || syncRoom.length <= ROOM_PREFIX.length) {
    fail("sync_room", "sync_room must identify a CTOX Business OS room");
  }
  const nativePeerId = requiredString(invite.native_peer_id, "native_peer_id", "native_peer_id");
  if (!Array.isArray(invite.signaling_urls) || invite.signaling_urls.length === 0) {
    fail("signaling_urls", "signaling_urls are required");
  }
  const signalingUrls = invite.signaling_urls.map(validateSignalingUrl);
  const password = requiredString(
    invite.signaling_room_password,
    "password",
    "signaling_room_password",
  );
  if (invite.transport !== "webrtc") fail("transport", "invite transport must be webrtc");
  const expiresAtMs = parseTime(invite.expires_at, "expires_at", "expires_at");
  if (expiresAtMs <= now) fail("expired", "invite is expired");
  if (invite.data_plane !== "rxdb-webrtc") {
    fail("data_plane", "invite data_plane must be rxdb-webrtc");
  }
  if (invite.http_bridge_available !== false) fail("http_bridge", "HTTP bridge must be disabled");

  const session = asRecord(invite.session, "session", "authenticated session is required");
  if (session.authenticated !== true) fail("session", "authenticated session is required");
  const capabilityToken = requiredString(
    session.capability_token,
    "capability_token",
    "session capability_token",
  );
  if (
    !Number.isSafeInteger(session.capability_expires_at_ms) ||
    Number(session.capability_expires_at_ms) <= now
  ) {
    fail("capability_expired", "session capability is expired or invalid");
  }
  const capabilityExpiresAtMs = Number(session.capability_expires_at_ms);
  if (capabilityExpiresAtMs > expiresAtMs) {
    fail("capability_expiry", "session capability outlives the invite");
  }

  const user = asRecord(session.user, "user", "session user is required");
  const userId = requiredString(user.id, "user_id", "session user id");
  const userDisplayName = requiredString(
    user.display_name,
    "user_display_name",
    "session user display_name",
  );
  const role = requiredString(user.role, "user_role", "session user role") as BusinessOsRole;
  if (!SUPPORTED_ROLES.has(role)) fail("user_role", "session user role is unsupported");

  return Object.freeze({
    type: BUSINESS_OS_INVITE_TYPE,
    version: BUSINESS_OS_INVITE_VERSION,
    displayName,
    instanceId,
    syncRoom,
    nativePeerId,
    signalingUrls: Object.freeze(signalingUrls),
    password,
    expiresAt: new Date(expiresAtMs).toISOString(),
    expiresAtMs,
    session: Object.freeze({
      authenticated: true,
      source: typeof session.source === "string" ? session.source : "desktop_invite",
      capabilityToken,
      capabilityExpiresAtMs,
      user: Object.freeze({
        id: userId,
        displayName: userDisplayName,
        role,
        isAdmin: role === "chef" || role === "admin" || role === "founder",
      }),
    }),
  });
}

export function parseWorkjetBusinessOsPairLink(
  raw: string,
  options: { readonly now?: number } = {},
): ValidatedBusinessOsInvite {
  const input = normalizeIncomingWorkjetUrl(raw);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fail("url", "pairing link is invalid");
  }
  if (!["workjet:", "workjet-dev:", "workjet-preview:"].includes(url.protocol)) {
    fail("scheme", "unsupported pairing scheme");
  }
  if (url.hostname !== "business-os" || url.pathname !== "/pair") {
    fail("host", "unsupported pairing action");
  }
  if (url.username || url.password || url.hash) {
    fail("url", "pairing link contains unsupported components");
  }
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "payload") {
    fail("query", "pairing link must contain only payload");
  }
  const encoded = url.searchParams.get("payload");
  if (!encoded) fail("payload", "pairing link is missing payload");
  return validateBusinessOsInviteV1(decodePayload(encoded), options);
}

export function encodeWorkjetBusinessOsPairLink(
  input: unknown,
  options: { readonly now?: number } = {},
): string {
  validateBusinessOsInviteV1(input, options);
  const invite = { ...asRecord(input, "object", "invite must be an object") };
  delete invite.desktop_link;
  const encoded = encodeBase64Url(JSON.stringify(invite));
  return buildWorkjetUrl("business-os/pair", {
    query: new URLSearchParams([["payload", encoded]]),
  });
}

export function businessOsInviteConfirmationMetadata(
  input: unknown,
  options: { readonly now?: number } = {},
): {
  readonly displayName: string;
  readonly expiresAt: string;
  readonly signalingHosts: readonly string[];
} {
  const invite = validateBusinessOsInviteV1(input, options);
  return {
    displayName: invite.displayName,
    expiresAt: invite.expiresAt,
    signalingHosts: invite.signalingUrls.map((value) => new URL(value).host),
  };
}
