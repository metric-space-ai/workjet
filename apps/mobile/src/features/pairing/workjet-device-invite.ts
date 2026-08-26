import { WorkjetDeviceInviteV1 } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { buildPairingUrl } from "../connection/pairing";
import {
  validateBusinessOsInviteV1,
  type ValidatedBusinessOsInvite,
} from "../business-os/pairing/invite";
import { normalizeIncomingWorkjetUrl } from "../../lib/workjetLinks";

const MAX_ENCODED_PAYLOAD_LENGTH = 262_144;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const DEVICE_INVITE_ROUTE = "pair";
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export interface ValidatedWorkjetDeviceInvite {
  readonly devicePairingId: string;
  readonly environment: {
    readonly baseUrl: string;
    readonly pairingUrl: string;
    readonly expiresAt: string;
    readonly expiresAtMs: number;
  };
  readonly businessOs: ValidatedBusinessOsInvite;
  readonly confirmation: {
    readonly displayName: string;
    readonly expiresAt: string;
    readonly signalingHosts: readonly string[];
  };
}

export class WorkjetDeviceInviteValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WorkjetDeviceInviteValidationError";
  }
}

function fail(code: string, message: string): never {
  throw new WorkjetDeviceInviteValidationError(code, message);
}

function decodeBase64UrlJson(encoded: string): unknown {
  if (
    !encoded ||
    encoded.length > MAX_ENCODED_PAYLOAD_LENGTH ||
    encoded.length % 4 === 1 ||
    !BASE64URL_PATTERN.test(encoded)
  ) {
    fail("payload", "Workjet pairing payload is invalid.");
  }
  try {
    const normalized = encoded.replace(/-/gu, "+").replace(/_/gu, "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = globalThis.atob(`${normalized}${padding}`);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return fail("payload", "Workjet pairing payload is invalid.");
  }
}

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

export function encodeWorkjetDevicePairLink(invite: typeof WorkjetDeviceInviteV1.Type): string {
  const payload = encodeBase64Url(JSON.stringify(invite));
  const search = new URLSearchParams([["payload", payload]]);
  const link = `workjet://pair?${search.toString()}`;
  if (new TextEncoder().encode(link).byteLength > 2_300) {
    throw new Error("Workjet device invite is too large for a reliable QR code.");
  }
  return link;
}

function validateEnvironmentBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("environment_url", "Workjet environment URL is invalid.");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail("environment_url", "Workjet environment URL is not allowed.");
  }
  return url.toString().replace(/\/$/u, "");
}

export function parseWorkjetDevicePairLink(
  raw: string,
  options: { readonly now?: number } = {},
): ValidatedWorkjetDeviceInvite {
  const now = options.now ?? Date.now();
  let url: URL;
  try {
    url = new URL(normalizeIncomingWorkjetUrl(raw));
  } catch {
    return fail("url", "Workjet pairing link is invalid.");
  }
  if (!["workjet:", "workjet-dev:", "workjet-preview:"].includes(url.protocol)) {
    fail("scheme", "Workjet pairing scheme is unsupported.");
  }
  if (url.hostname !== DEVICE_INVITE_ROUTE || (url.pathname && url.pathname !== "/")) {
    fail("route", "Workjet pairing route is unsupported.");
  }
  if (url.username || url.password || url.hash) {
    fail("url", "Workjet pairing link contains unsupported components.");
  }
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "payload") {
    fail("query", "Workjet pairing link must contain only payload.");
  }
  const encoded = url.searchParams.get("payload");
  if (!encoded) fail("payload", "Workjet pairing payload is missing.");

  let invite: typeof WorkjetDeviceInviteV1.Type;
  try {
    invite = Schema.decodeUnknownSync(WorkjetDeviceInviteV1)(decodeBase64UrlJson(encoded));
  } catch {
    return fail("schema", "Workjet pairing payload has an unsupported schema.");
  }

  const expiresAtMs = Date.parse(invite.environment.expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
    fail("expired", "Workjet pairing link is expired.");
  }
  const baseUrl = validateEnvironmentBaseUrl(invite.environment.base_url);
  const businessOs = validateBusinessOsInviteV1(invite.business_os, { now });
  const expiresAt = new Date(Math.min(expiresAtMs, businessOs.expiresAtMs)).toISOString();

  return Object.freeze({
    devicePairingId: invite.device_pairing_id,
    environment: Object.freeze({
      baseUrl,
      pairingUrl: buildPairingUrl(baseUrl, invite.environment.bootstrap_credential),
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
    }),
    businessOs,
    confirmation: Object.freeze({
      displayName: businessOs.displayName,
      expiresAt,
      signalingHosts: Object.freeze(
        businessOs.signalingUrls.map((signalingUrl) => new URL(signalingUrl).host),
      ),
    }),
  });
}
