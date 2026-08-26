import type {
  WorkjetDeviceInviteCreateInput,
  WorkjetDeviceInviteCreateResult,
  WorkjetDeviceInviteRevokeInput,
  WorkjetDeviceInviteRevokeResult,
} from "@t3tools/contracts";

import type { SavedRemoteConnection } from "../../lib/connection";
import type { BusinessOsInstance } from "../business-os/registry/business-os-registry";
import { encodeWorkjetDevicePairLink, parseWorkjetDevicePairLink } from "./workjet-device-invite";

export interface CreatedWorkjetDeviceInvite {
  readonly inviteId: string;
  readonly link: string;
  readonly expiresAt: string;
  readonly displayName: string;
}

export interface WorkjetDeviceInviteControlPort {
  readonly create: (input: {
    readonly connection: SavedRemoteConnection;
    readonly ttlSeconds?: number;
  }) => Promise<CreatedWorkjetDeviceInvite>;
  readonly revoke: (input: {
    readonly connection: SavedRemoteConnection;
    readonly inviteId: string;
  }) => Promise<void>;
}

export interface WorkjetDeviceInviteHttpPort {
  readonly create: (
    input: WorkjetDeviceInviteCreateInput,
  ) => Promise<WorkjetDeviceInviteCreateResult>;
  readonly revoke: (
    input: WorkjetDeviceInviteRevokeInput,
  ) => Promise<WorkjetDeviceInviteRevokeResult>;
}

export class WorkjetDeviceInviteControlUnavailableError extends Error {
  constructor() {
    super("Device invite controls are not available for this environment yet.");
    this.name = "WorkjetDeviceInviteControlUnavailableError";
  }
}

export const unavailableWorkjetDeviceInviteControl: WorkjetDeviceInviteControlPort = {
  async create() {
    throw new WorkjetDeviceInviteControlUnavailableError();
  },
  async revoke() {
    throw new WorkjetDeviceInviteControlUnavailableError();
  },
};

export function resolveWorkjetDevicePairingConnection(
  backend: BusinessOsInstance | null,
  connections: readonly SavedRemoteConnection[],
): SavedRemoteConnection | null {
  if (!backend) return null;
  const exact = connections.filter(
    (connection) =>
      connection.environmentLabel.trim().toLowerCase() === backend.displayName.trim().toLowerCase(),
  );
  if (exact.length === 1) return exact[0]!;
  return connections.length === 1 ? connections[0]! : null;
}

function shareableConnectionUrl(connection: SavedRemoteConnection): string {
  let url: URL;
  try {
    url = new URL(connection.httpBaseUrl);
  } catch {
    throw new WorkjetDeviceInviteControlUnavailableError();
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname)
  ) {
    throw new WorkjetDeviceInviteControlUnavailableError();
  }
  return url.toString().replace(/\/$/u, "");
}

export function makeWorkjetDeviceInviteControl(
  http: WorkjetDeviceInviteHttpPort,
  options: { readonly now?: () => number } = {},
): WorkjetDeviceInviteControlPort {
  return {
    async create({ connection, ttlSeconds = 300 }) {
      const response = await http.create({
        ttlSeconds,
        connectionUrl: shareableConnectionUrl(connection),
      });
      const link = encodeWorkjetDevicePairLink(response.invite);
      const parsed = parseWorkjetDevicePairLink(link, { now: options.now?.() });
      if (Date.parse(response.expiresAt) !== Date.parse(parsed.confirmation.expiresAt)) {
        throw new Error("Device invite response expiry does not match its credentials.");
      }
      return Object.freeze({
        inviteId: response.inviteId,
        link,
        expiresAt: parsed.confirmation.expiresAt,
        displayName: parsed.confirmation.displayName,
      });
    },
    async revoke({ inviteId }) {
      const response = await http.revoke({ inviteId });
      if (response.revoked !== true) throw new Error("Device invite revoke response is invalid.");
    },
  };
}
