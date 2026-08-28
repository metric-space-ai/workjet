import {
  WorkjetDeviceInviteRefV1,
  WorkjetDeviceInviteV1,
  WorkjetDeviceInviteV2,
  type BusinessOsInstanceId,
  type WorkjetDeviceSessionBootstrapCredential,
  type WorkjetManagedIssuerOrigin,
} from "@t3tools/contracts";
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
const decodeDeviceInviteV1 = Schema.decodeUnknownSync(WorkjetDeviceInviteV1);
const decodeDeviceInviteV2 = Schema.decodeUnknownSync(WorkjetDeviceInviteV2);
const decodeDeviceInviteReference = Schema.decodeUnknownSync(WorkjetDeviceInviteRefV1);

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

export interface ValidatedWorkjetDeviceInviteReference {
  readonly endpoint: string;
  readonly code: string;
  readonly expiresAt: string;
  readonly expiresAtMs: number;
}

export interface ValidatedWorkjetDeviceInviteV2 {
  readonly devicePairingId: string;
  readonly businessOsInstanceId: BusinessOsInstanceId;
  readonly workjetSession: {
    readonly issuer: WorkjetManagedIssuerOrigin;
    readonly bootstrapCredential: WorkjetDeviceSessionBootstrapCredential;
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

export type ParsedWorkjetDevicePairingLink =
  | {
      readonly kind: "invite";
      readonly attemptId: string;
      readonly invite: ValidatedWorkjetDeviceInvite;
    }
  | {
      readonly kind: "reference";
      readonly attemptId: string;
      readonly reference: ValidatedWorkjetDeviceInviteReference;
    };

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

export function encodeWorkjetDevicePairLink(
  input: typeof WorkjetDeviceInviteV1.Type | typeof WorkjetDeviceInviteRefV1.Type,
): string {
  const payload = encodeBase64Url(JSON.stringify(input));
  const search = new URLSearchParams([["payload", payload]]);
  const link = `workjet://pair?${search.toString()}`;
  if (new TextEncoder().encode(link).byteLength > 2_300) {
    throw new Error("Workjet device invite is too large for a reliable QR code.");
  }
  return link;
}

function decodeWorkjetDevicePairPayload(raw: string): unknown {
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
  return decodeBase64UrlJson(encoded);
}

function validateEnvironmentBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("environment_url", "Workjet environment URL is invalid.");
  }
  const hostname = url.hostname.toLowerCase();
  const httpLoopback =
    url.protocol === "http:" &&
    (hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/u.test(hostname));
  if (
    (url.protocol !== "https:" && !httpLoopback) ||
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
  const payload = decodeWorkjetDevicePairPayload(raw);
  let invite: typeof WorkjetDeviceInviteV1.Type;
  try {
    invite = decodeDeviceInviteV1(payload);
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

function validateReferenceEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("reference_endpoint", "Workjet pairing server is invalid.");
  }
  const hostname = url.hostname.toLowerCase();
  const httpLoopback =
    url.protocol === "http:" &&
    (hostname === "localhost" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/u.test(hostname));
  if (
    (url.protocol !== "https:" && !httpLoopback) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail("reference_endpoint", "Workjet pairing server is not allowed.");
  }
  return url.toString().replace(/\/$/u, "");
}

export function parseWorkjetDevicePairingLink(
  raw: string,
  options: { readonly now?: number } = {},
): ParsedWorkjetDevicePairingLink {
  const now = options.now ?? Date.now();
  const payload = decodeWorkjetDevicePairPayload(raw);
  try {
    const invite = decodeDeviceInviteV1(payload);
    const parsed = parseWorkjetDevicePairLink(raw, { now });
    return Object.freeze({
      kind: "invite" as const,
      attemptId: `invite:${invite.device_pairing_id}`,
      invite: parsed,
    });
  } catch (error) {
    if (error instanceof WorkjetDeviceInviteValidationError && error.code !== "schema") {
      throw error;
    }
  }

  let reference: typeof WorkjetDeviceInviteRefV1.Type;
  try {
    reference = decodeDeviceInviteReference(payload);
  } catch {
    return fail("schema", "Workjet pairing payload has an unsupported schema.");
  }
  const expiresAtMs = Date.parse(reference.expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
    fail("expired", "Workjet pairing link is expired.");
  }
  return Object.freeze({
    kind: "reference" as const,
    attemptId: `reference:${reference.code}`,
    reference: Object.freeze({
      endpoint: validateReferenceEndpoint(reference.endpoint),
      code: reference.code,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
    }),
  });
}

export function toWorkjetDeviceInviteReferenceContract(
  reference: ValidatedWorkjetDeviceInviteReference,
): typeof WorkjetDeviceInviteRefV1.Type {
  return {
    type: "workjet-device-invite-ref",
    version: 1,
    endpoint: reference.endpoint,
    code: reference.code,
    expires_at: reference.expiresAt,
  };
}

export function validateRedeemedWorkjetDeviceInvite(
  invite: typeof WorkjetDeviceInviteV1.Type,
  options: { readonly now?: number } = {},
): ValidatedWorkjetDeviceInvite {
  return parseWorkjetDevicePairLink(encodeWorkjetDevicePairLink(invite), options);
}

export function validateRedeemedWorkjetDeviceInviteV2(
  rawInvite: unknown,
  options: { readonly now?: number } = {},
): ValidatedWorkjetDeviceInviteV2 {
  const now = options.now ?? Date.now();
  let invite: typeof WorkjetDeviceInviteV2.Type;
  try {
    invite = decodeDeviceInviteV2(rawInvite);
  } catch {
    return fail("schema", "Workjet pairing response has an unsupported schema.");
  }
  const expiresAtMs = Date.parse(invite.workjet_session.expires_at);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
    fail("expired", "Workjet pairing response is expired.");
  }
  const businessOs = validateBusinessOsInviteV1(invite.business_os, { now });
  if (businessOs.instanceId !== invite.business_os_instance_id) {
    fail("instance", "Workjet pairing response names different Business OS instances.");
  }
  return Object.freeze({
    devicePairingId: invite.device_pairing_id,
    businessOsInstanceId: invite.business_os_instance_id,
    workjetSession: Object.freeze({
      issuer: invite.workjet_session.issuer,
      bootstrapCredential: invite.workjet_session.bootstrap_credential,
      expiresAt: new Date(expiresAtMs).toISOString(),
      expiresAtMs,
    }),
    businessOs,
    confirmation: Object.freeze({
      displayName: businessOs.displayName,
      expiresAt: new Date(Math.min(expiresAtMs, businessOs.expiresAtMs)).toISOString(),
      signalingHosts: Object.freeze(
        businessOs.signalingUrls.map((signalingUrl) => new URL(signalingUrl).host),
      ),
    }),
  });
}
