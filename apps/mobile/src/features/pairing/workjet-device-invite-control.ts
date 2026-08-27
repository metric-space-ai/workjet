import type {
  WorkjetDeviceInviteCreateInput,
  WorkjetDeviceInviteCreateResult,
  WorkjetDeviceInviteRevokeInput,
  WorkjetDeviceInviteRevokeResult,
} from "@t3tools/contracts";

import type { SavedRemoteConnection } from "../../lib/connection";
import {
  encodeWorkjetDevicePairLink,
  parseWorkjetDevicePairingLink,
} from "./workjet-device-invite";

export interface CreatedWorkjetDeviceInvite {
  readonly inviteId: string;
  readonly link: string;
  readonly expiresAt: string;
  readonly displayName: string;
}

export interface WorkjetDeviceInviteControlPort {
  readonly create: (input: {
    readonly connection: SavedRemoteConnection;
    readonly businessOsInstanceId: string;
    readonly displayName: string;
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
  environmentId: SavedRemoteConnection["environmentId"] | null,
  connections: readonly SavedRemoteConnection[],
): SavedRemoteConnection | null {
  if (!environmentId) return null;
  return connections.find((connection) => connection.environmentId === environmentId) ?? null;
}

function shareableConnectionUrl(connection: SavedRemoteConnection): string {
  let url: URL;
  try {
    url = new URL(connection.httpBaseUrl);
  } catch {
    throw new WorkjetDeviceInviteControlUnavailableError();
  }
  if (
    url.protocol !== "https:" ||
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
    async create({ connection, businessOsInstanceId, displayName, ttlSeconds = 300 }) {
      if (!businessOsInstanceId.trim() || !displayName.trim()) {
        throw new WorkjetDeviceInviteControlUnavailableError();
      }
      const response = await http.create({
        ttlSeconds,
        connectionUrl: shareableConnectionUrl(connection),
        businessOsInstanceId,
      });
      const link = encodeWorkjetDevicePairLink(response.reference);
      const parsedReference = parseWorkjetDevicePairingLink(link, { now: options.now?.() });
      if (
        parsedReference.kind !== "reference" ||
        Date.parse(response.expiresAt) !== Date.parse(parsedReference.reference.expiresAt)
      ) {
        throw new Error("Device invite response expiry does not match its reference.");
      }
      return Object.freeze({
        inviteId: response.inviteId,
        link,
        expiresAt: parsedReference.reference.expiresAt,
        displayName: displayName.trim(),
      });
    },
    async revoke({ inviteId }) {
      const response = await http.revoke({ inviteId });
      if (response.revoked !== true) throw new Error("Device invite revoke response is invalid.");
    },
  };
}
