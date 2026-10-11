import type { CtoxBusinessOsInviteV1, WorkjetDeviceInviteRefV1 } from "@workjet/contracts";

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

export function encodeWorkjetBusinessOsPairingLink(invite: CtoxBusinessOsInviteV1): string {
  const compact = [
    "w2",
    invite.display_name,
    invite.instance_id,
    invite.sync_room,
    invite.native_peer_id,
    invite.signaling_urls,
    invite.signaling_auth_version,
    invite.signaling_browser_token,
    invite.signaling_browser_token_hash,
    invite.signaling_native_token_hash,
    invite.expires_at,
    invite.session.capability_token,
    invite.session.capability_expires_at_ms,
    invite.session.user.id,
    invite.session.user.display_name,
    invite.session.user.role,
    invite.session.source,
  ] as const;
  const payload = encodeBase64Url(JSON.stringify(compact));
  const search = new URLSearchParams([["payload", payload]]);
  const link = `workjet://pair?${search.toString()}`;
  if (new TextEncoder().encode(link).byteLength > 2_300) {
    throw new Error("The pairing invite is too large for a reliable QR code.");
  }
  return link;
}

export function encodeWorkjetDevicePairingLink(reference: WorkjetDeviceInviteRefV1): string {
  const payload = encodeBase64Url(JSON.stringify(reference));
  const search = new URLSearchParams([["payload", payload]]);
  const link = `workjet://pair?${search.toString()}`;
  if (new TextEncoder().encode(link).byteLength > 320) {
    throw new Error("The device pairing reference is too large for a reliable QR code.");
  }
  return link;
}

export function formatMobileInviteExpiry(expiresAt: string, locale?: string): string {
  const milliseconds = Date.parse(expiresAt);
  if (!Number.isFinite(milliseconds)) return "—";
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(milliseconds));
}

function decodeBase64Url(value: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    buffer = (buffer << 6) | BASE64URL_ALPHABET.indexOf(character);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

const WORKJET_PAIR_LINK = /^workjet(?:-dev|-preview)?:\/\/pair\/?\?/i;

/**
 * Ein `workjet://pair?payload=…`-Link aus einem CTOX-Sync-QR-Code trägt die
 * Einladung kompakt (`["w2", …]`, base64url). Der Desktop-Import erwartet
 * das Einladungsobjekt als JSON; diese Funktion erweitert die Kurzform.
 * Alles andere bleibt unverändert, damit der Import selbst entscheidet.
 */
export function expandWorkjetPairingInvite(rawInvite: string): string {
  const input = rawInvite.trim();
  if (!WORKJET_PAIR_LINK.test(input)) return rawInvite;
  let url: URL;
  try {
    url = new URL(input.replace(/^[^:]+:/, "https:"));
  } catch {
    return rawInvite;
  }
  const payloads = url.searchParams.getAll("payload");
  if (url.hostname !== "pair" || payloads.length !== 1) return rawInvite;
  const decoded = decodeBase64Url(payloads[0] ?? "");
  if (decoded === null) return rawInvite;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    return rawInvite;
  }
  if (!Array.isArray(parsed)) {
    return parsed !== null && typeof parsed === "object" ? JSON.stringify(parsed) : rawInvite;
  }
  if (parsed[0] !== "w2" || parsed.length !== 17 || !Array.isArray(parsed[5])) return rawInvite;
  const role = parsed[15];
  return JSON.stringify({
    type: "ctox-business-os-invite",
    version: 1,
    display_name: parsed[1],
    instance_id: parsed[2],
    sync_room: parsed[3],
    native_peer_id: parsed[4],
    signaling_urls: parsed[5],
    signaling_auth_version: parsed[6],
    signaling_browser_token: parsed[7],
    signaling_browser_token_hash: parsed[8],
    signaling_native_token_hash: parsed[9],
    transport: "webrtc",
    expires_at: parsed[10],
    data_plane: "rxdb-webrtc",
    http_bridge_available: false,
    secret_value_in_payload: true,
    session: {
      authenticated: true,
      capability_token: parsed[11],
      capability_expires_at_ms: parsed[12],
      user: {
        id: parsed[13],
        display_name: parsed[14],
        role,
        is_admin: role === "chef" || role === "admin" || role === "founder",
      },
      source: parsed[16],
    },
  });
}
