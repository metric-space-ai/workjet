import type { CtoxBusinessOsInviteV1, WorkjetDeviceInviteRefV1 } from "@t3tools/contracts";

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
  const payload = encodeBase64Url(JSON.stringify(invite));
  const search = new URLSearchParams([["payload", payload]]);
  const link = `workjet://business-os/pair?${search.toString()}`;
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
  if (!Number.isFinite(milliseconds)) return "Unknown";
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(milliseconds));
}
