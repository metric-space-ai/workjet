import { encodeWorkjetBusinessOsPairLink, validateBusinessOsInviteV1 } from "../pairing/invite";
import type { BusinessOsInstance } from "../registry/business-os-registry";

export interface CreatedBusinessOsMobileInvite {
  readonly inviteId: string;
  readonly link: string;
  readonly expiresAt: string;
}

export interface BusinessOsMobileInviteControlPort {
  readonly create: (input: {
    readonly backend: BusinessOsInstance;
    readonly ttlSeconds?: number;
  }) => Promise<CreatedBusinessOsMobileInvite>;
  readonly revoke: (input: {
    readonly backend: BusinessOsInstance;
    readonly inviteId: string;
  }) => Promise<void>;
}

export class BusinessOsInviteControlUnavailableError extends Error {
  constructor() {
    super("Mobile invite controls are not available for this backend yet.");
    this.name = "BusinessOsInviteControlUnavailableError";
  }
}

export const unavailableBusinessOsMobileInviteControl: BusinessOsMobileInviteControlPort = {
  async create() {
    throw new BusinessOsInviteControlUnavailableError();
  },
  async revoke() {
    throw new BusinessOsInviteControlUnavailableError();
  },
};

export function decodeCreatedBusinessOsMobileInvite(
  input: unknown,
  options: { readonly now?: number } = {},
): CreatedBusinessOsMobileInvite {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Mobile invite response is invalid.");
  }
  const response = input as Record<string, unknown>;
  if (typeof response.inviteId !== "string" || !response.inviteId.trim()) {
    throw new Error("Mobile invite response has no invite identifier.");
  }
  const invite = validateBusinessOsInviteV1(response.invite, options);
  if (
    typeof response.expiresAt !== "string" ||
    Date.parse(response.expiresAt) !== invite.expiresAtMs
  ) {
    throw new Error("Mobile invite response expiry does not match its credential.");
  }
  const link = encodeWorkjetBusinessOsPairLink(response.invite, options);
  if (new TextEncoder().encode(link).byteLength > 2_300) {
    throw new Error("Mobile invite is too large for a reliable QR code.");
  }
  return Object.freeze({
    inviteId: response.inviteId,
    link,
    expiresAt: invite.expiresAt,
  });
}
