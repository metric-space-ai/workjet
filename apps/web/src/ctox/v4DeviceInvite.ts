// E54.4: redeem a Business OS device invitation. The link carries the instance, its signaling
// target, the invite id and the one-time secret. Workjet derives the proof locally, connects as a
// pairing peer over signaling (control lane only, no data) and sends `device.invite.redeem`. The
// answer is a V4LaunchContext (E41, carrying its E50 ticket) for this device. No HTTP path.
import { randomUUID } from "../lib/utils";
import { parseV4LaunchContext } from "./kernel/boot.mjs";
import type { V4LaunchContext } from "./kernel/index";

/** Rejections of the Core (`device_invite_v4::Reject`, ctox #927). */
export const V4_INVITE_REJECTIONS = [
  "invite_unknown",
  "invite_expired",
  "invite_used",
  "proof_invalid",
  "device_rejected",
  "rate_limited",
] as const;
export type V4InviteRejection = (typeof V4_INVITE_REJECTIONS)[number];

/** Client-side outcomes: link not readable, instance not reachable, answer not a launch context. */
export type V4InviteFailureCode =
  | V4InviteRejection
  | "invite_invalid"
  | "unreachable"
  | "launch_context_invalid";

export type V4InviteRedeemOutcome =
  | {
      readonly ok: true;
      readonly instanceId: string;
      /** The response object `{v4}` as received; the bootstrap re-validates it. */
      readonly payload: { readonly v4: unknown };
      readonly launchContext: Readonly<V4LaunchContext["v4"]>;
    }
  | { readonly ok: false; readonly code: V4InviteFailureCode };

export interface V4InviteSignalingTarget {
  readonly urls: ReadonlyArray<string>;
  readonly room: string;
  readonly nativePeerId: string;
  readonly token?: string;
  readonly iceServers: ReadonlyArray<RTCIceServer>;
}

export interface V4DeviceInvite {
  readonly instanceId: string;
  readonly signaling: V4InviteSignalingTarget;
  readonly inviteId: string;
  /** base64url (no padding) of the 32-byte one-time secret. */
  readonly oneTimeSecret: string;
  readonly expiresAtMs: number;
}

export const V4_INVITE_PAYLOAD_TYPE = "ctox-device-invite";
export const V4_INVITE_PAYLOAD_VERSION = 4;
export const V4_INVITE_MAX_TTL_MS = 86_400_000;

const PAIR_LINK = /^workjet(?:-dev|-preview)?:\/\/pair\/?\?payload=([A-Za-z0-9_-]{1,2300})$/u;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/u;
const textEncoder = new TextEncoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 512;
const onlyKeys = (value: Record<string, unknown>, allowed: ReadonlyArray<string>) =>
  Object.keys(value).every((key) => allowed.includes(key));

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length % 4 === 1) return null;
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/");
  try {
    return Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

/** Canonical unpadded base64url of exactly 32 bytes (secret, device key, proof). */
export function decodeCanonical32(value: string): Uint8Array | null {
  if (!BASE64URL_32.test(value)) return null;
  const bytes = base64UrlDecode(value);
  return bytes !== null && bytes.length === 32 && base64UrlEncode(bytes) === value ? bytes : null;
}

function signalingTarget(value: unknown): V4InviteSignalingTarget | null {
  if (!isRecord(value)) return null;
  if (!onlyKeys(value, ["urls", "room", "native_peer_id", "token", "ice_servers"])) return null;
  const { urls, room, native_peer_id: nativePeerId, token, ice_servers: iceServers } = value;
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > 8) return null;
  const valid = urls.every((url) => {
    if (typeof url !== "string") return false;
    try {
      return ["ws:", "wss:"].includes(new URL(url).protocol);
    } catch {
      return false;
    }
  });
  if (!valid || !nonEmpty(room) || !nonEmpty(nativePeerId)) return null;
  if (token !== undefined && !nonEmpty(token)) return null;
  const servers = iceServers ?? [];
  if (
    !Array.isArray(servers) ||
    !servers.every(
      (server) =>
        isRecord(server) &&
        (nonEmpty(server.urls) ||
          (Array.isArray(server.urls) && server.urls.length > 0 && server.urls.every(nonEmpty))) &&
        (server.username === undefined || typeof server.username === "string") &&
        (server.credential === undefined || typeof server.credential === "string"),
    )
  )
    return null;
  return {
    urls: [...(urls as string[])],
    room,
    nativePeerId,
    ...(token === undefined ? {} : { token }),
    iceServers: (servers as RTCIceServer[]).map((server) => ({ ...server })),
  };
}

export type V4InviteLinkResult =
  | { readonly ok: true; readonly invite: V4DeviceInvite }
  | { readonly ok: false; readonly code: "invite_invalid" | "invite_expired" };

/**
 * Reads a `workjet://pair?payload=…` V4 invitation. `null` when the link is not a V4 invitation
 * at all (a V3 pairing link keeps its existing import path).
 */
export function parseV4DeviceInviteLink(link: string, nowMs: number): V4InviteLinkResult | null {
  const payload = PAIR_LINK.exec(link.trim())?.[1];
  if (payload === undefined) return null;
  const bytes = base64UrlDecode(payload);
  if (bytes === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!isRecord(value) || value.type !== V4_INVITE_PAYLOAD_TYPE) return null;
  const invalid = { ok: false, code: "invite_invalid" } as const;
  if (
    value.version !== V4_INVITE_PAYLOAD_VERSION ||
    !onlyKeys(value, [
      "type",
      "version",
      "instance_id",
      "signaling",
      "invite_id",
      "one_time_secret",
      "expires_at_ms",
    ])
  )
    return invalid;
  const signaling = signalingTarget(value.signaling);
  const {
    instance_id: instanceId,
    invite_id: inviteId,
    one_time_secret: oneTimeSecret,
    expires_at_ms: expiresAtMs,
  } = value;
  if (
    signaling === null ||
    !nonEmpty(instanceId) ||
    typeof inviteId !== "string" ||
    !CANONICAL_UUID.test(inviteId) ||
    typeof oneTimeSecret !== "string" ||
    decodeCanonical32(oneTimeSecret) === null ||
    typeof expiresAtMs !== "number" ||
    !Number.isSafeInteger(expiresAtMs)
  )
    return invalid;
  // A link that is already past its expiry (or claims more than the 24 h bound) is never sent.
  if (expiresAtMs <= nowMs) return { ok: false, code: "invite_expired" };
  if (expiresAtMs - nowMs > V4_INVITE_MAX_TTL_MS) return invalid;
  return { ok: true, invite: { instanceId, signaling, inviteId, oneTimeSecret, expiresAtMs } };
}

/** True for a V4 invitation link, valid or not; a V3 pairing link answers false. */
export function isV4DeviceInviteLink(link: string): boolean {
  // The clock only decides expired vs. valid; recognition never depends on it.
  return parseV4DeviceInviteLink(link, 0) !== null;
}

/** Encodes an invitation as link (Core/test side of the same payload contract). */
export function encodeV4DeviceInviteLink(invite: V4DeviceInvite): string {
  const payload = {
    type: V4_INVITE_PAYLOAD_TYPE,
    version: V4_INVITE_PAYLOAD_VERSION,
    instance_id: invite.instanceId,
    signaling: {
      urls: [...invite.signaling.urls],
      room: invite.signaling.room,
      native_peer_id: invite.signaling.nativePeerId,
      ...(invite.signaling.token === undefined ? {} : { token: invite.signaling.token }),
      ...(invite.signaling.iceServers.length === 0
        ? {}
        : { ice_servers: invite.signaling.iceServers }),
    },
    invite_id: invite.inviteId,
    one_time_secret: invite.oneTimeSecret,
    expires_at_ms: invite.expiresAtMs,
  };
  return `workjet://pair?payload=${base64UrlEncode(textEncoder.encode(JSON.stringify(payload)))}`;
}

const KEY_DOMAIN = textEncoder.encode("ctox.device.invite.key.v1\0");
const PROOF_DOMAIN = textEncoder.encode("ctox.device.invite.redeem.v1\0");

function concat(...parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * ctox #927 proof contract:
 *   K = SHA256(UTF8("ctox.device.invite.key.v1") || 0x00 || S)
 *   M = UTF8("ctox.device.invite.redeem.v1") || 0x00 || U32BE(len(UTF8(invite_id)))
 *       || UTF8(invite_id) || raw32(device_pubkey)
 *   proof = base64url_no_pad(HMAC_SHA256(K, M))
 */
export async function deriveV4InviteProof(
  input: {
    readonly oneTimeSecret: string;
    readonly inviteId: string;
    readonly devicePubkey: string;
  },
  subtle: SubtleCrypto = globalThis.crypto.subtle,
): Promise<string> {
  const secret = decodeCanonical32(input.oneTimeSecret);
  const publicKey = decodeCanonical32(input.devicePubkey);
  if (secret === null || publicKey === null) throw new Error("invalid_proof_input");
  const key = new Uint8Array(await subtle.digest("SHA-256", concat(KEY_DOMAIN, secret)));
  const id = textEncoder.encode(input.inviteId);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, id.length);
  const hmacKey = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await subtle.sign("HMAC", hmacKey, concat(PROOF_DOMAIN, length, id, publicKey));
  return base64UrlEncode(new Uint8Array(mac));
}

/** Display-only device label (Core: nonempty, ≤128 UTF-8 bytes, no control characters). */
export function normalizeV4DeviceLabel(label: string): string {
  let text = label.replace(/\p{Cc}/gu, " ").trim();
  if (text === "") text = "Workjet";
  while (textEncoder.encode(text).length > 128) text = Array.from(text).slice(0, -1).join("");
  return text;
}

export interface V4DeviceInviteRedeemRequest {
  readonly invite_id: string;
  readonly proof: string;
  readonly device_pubkey: string;
  readonly device_label: string;
}

/** Exact control-lane request/response on the pairing peer. */
export const V4_PAIRING_METHOD = "device.invite.redeem";
export interface V4PairingControlRequest {
  readonly type: "pairing_request";
  readonly id: string;
  readonly method: typeof V4_PAIRING_METHOD;
  readonly params: readonly [V4DeviceInviteRedeemRequest];
}

/**
 * Sends one control request over a fresh pairing-peer connection and resolves its matching
 * response message. Rejects only when the instance cannot be reached or the response is missing.
 */
export type V4PairingControlExchange = (
  target: V4InviteSignalingTarget,
  request: V4PairingControlRequest,
) => Promise<unknown>;

/** The device key the invite binds: canonical base64url of the raw 32-byte Ed25519 public key. */
export interface V4DeviceKeySource {
  readonly publicKeyFor: (instanceId: string) => Promise<string>;
}

const isRejection = (value: unknown): value is V4InviteRejection =>
  typeof value === "string" && (V4_INVITE_REJECTIONS as ReadonlyArray<string>).includes(value);

export async function redeemV4DeviceInvite(options: {
  readonly link: string;
  readonly deviceKeys: V4DeviceKeySource;
  readonly deviceLabel: string;
  readonly exchange: V4PairingControlExchange;
  readonly now?: () => number;
  readonly requestId?: () => string;
  readonly subtle?: SubtleCrypto;
}): Promise<V4InviteRedeemOutcome> {
  const now = options.now ?? Date.now;
  const parsed = parseV4DeviceInviteLink(options.link, now());
  if (parsed === null) return { ok: false, code: "invite_invalid" };
  if (!parsed.ok) return parsed;
  const { invite } = parsed;
  let request: V4PairingControlRequest;
  try {
    const devicePubkey = await options.deviceKeys.publicKeyFor(invite.instanceId);
    if (decodeCanonical32(devicePubkey) === null) return { ok: false, code: "device_rejected" };
    const proof = await deriveV4InviteProof(
      { oneTimeSecret: invite.oneTimeSecret, inviteId: invite.inviteId, devicePubkey },
      options.subtle,
    );
    request = {
      type: "pairing_request",
      id: options.requestId?.() ?? randomUUID(),
      method: V4_PAIRING_METHOD,
      params: [
        {
          invite_id: invite.inviteId,
          proof,
          device_pubkey: devicePubkey,
          device_label: normalizeV4DeviceLabel(options.deviceLabel),
        },
      ],
    };
  } catch {
    return { ok: false, code: "device_rejected" };
  }
  // The expiry can pass while the device key is prepared; check once more before sending.
  if (invite.expiresAtMs <= now()) return { ok: false, code: "invite_expired" };
  let response: unknown;
  try {
    response = await options.exchange(invite.signaling, request);
  } catch {
    return { ok: false, code: "unreachable" };
  }
  if (!isRecord(response) || response.type !== "pairing_response" || response.id !== request.id)
    return { ok: false, code: "launch_context_invalid" };
  if (response.error !== undefined) {
    const code = isRecord(response.error) ? response.error.code : undefined;
    return { ok: false, code: isRejection(code) ? code : "launch_context_invalid" };
  }
  const result = response.result;
  if (!isRecord(result)) return { ok: false, code: "launch_context_invalid" };
  let launchContext: Readonly<V4LaunchContext["v4"]>;
  try {
    launchContext = parseV4LaunchContext(result);
  } catch {
    return { ok: false, code: "launch_context_invalid" };
  }
  // The context must name the instance the invitation was issued for.
  if (launchContext.instanceId !== invite.instanceId)
    return { ok: false, code: "launch_context_invalid" };
  return { ok: true, instanceId: invite.instanceId, payload: { v4: result.v4 }, launchContext };
}

/** German short texts and the single action per failure (UI contract: one line, one action). */
export const V4_INVITE_FAILURE_TEXT: Readonly<
  Record<V4InviteFailureCode, { readonly text: string; readonly action: "retry" | "new_link" }>
> = {
  invite_unknown: { text: "Einladung unbekannt.", action: "new_link" },
  invite_expired: { text: "Einladung abgelaufen.", action: "new_link" },
  invite_used: { text: "Einladung bereits verwendet.", action: "new_link" },
  proof_invalid: { text: "Einladung ungültig.", action: "new_link" },
  device_rejected: { text: "Gerät abgelehnt.", action: "new_link" },
  rate_limited: { text: "Zu viele Versuche.", action: "retry" },
  invite_invalid: { text: "Link ungültig.", action: "new_link" },
  unreachable: { text: "Instanz nicht erreichbar.", action: "retry" },
  launch_context_invalid: { text: "Antwort ungültig.", action: "new_link" },
};
