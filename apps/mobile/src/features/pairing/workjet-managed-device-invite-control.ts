import {
  BusinessOsInstanceId,
  WORKJET_MANAGED_BACKEND_CONTROL_MAX_TTL_SECONDS,
  WorkjetInstallationId,
  type WorkjetDeviceInviteCreateResult,
  type WorkjetDeviceInviteRevokeResult,
  type WorkjetManagedBackendControlResolveInput,
  type WorkjetManagedBackendControlResolveResult,
  type WorkjetManagedDeviceInviteCreateInput,
  type WorkjetManagedDeviceInviteRevokeInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  type CreatedWorkjetDeviceInvite,
  type WorkjetDeviceInviteControlPort,
  WorkjetDeviceInviteControlUnavailableError,
} from "./workjet-device-invite-control";
import {
  encodeWorkjetDevicePairLink,
  parseWorkjetDevicePairingLink,
} from "./workjet-device-invite";

export interface WorkjetManagedBackendControlTransportPort {
  readonly resolve: (
    input: WorkjetManagedBackendControlResolveInput,
  ) => Promise<WorkjetManagedBackendControlResolveResult>;
  readonly createDeviceInvite: (
    input: WorkjetManagedDeviceInviteCreateInput,
  ) => Promise<WorkjetDeviceInviteCreateResult>;
  readonly revokeDeviceInvite: (
    input: WorkjetManagedDeviceInviteRevokeInput,
  ) => Promise<WorkjetDeviceInviteRevokeResult>;
}

const decodeBusinessOsInstanceId = Schema.decodeUnknownSync(BusinessOsInstanceId);
const decodeWorkjetInstallationId = Schema.decodeUnknownSync(WorkjetInstallationId);
const MAX_ACTIVE_INVITES = 32;

function assertControlScope(
  resolved: WorkjetManagedBackendControlResolveResult,
  businessOsInstanceId: BusinessOsInstanceId,
  now: number,
): void {
  const expiresAt = Date.parse(resolved.expiresAt);
  if (
    resolved.businessOsInstanceId !== businessOsInstanceId ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + WORKJET_MANAGED_BACKEND_CONTROL_MAX_TTL_SECONDS * 1_000
  ) {
    throw new WorkjetDeviceInviteControlUnavailableError();
  }
}

export function makeManagedWorkjetDeviceInviteControl(
  transport: WorkjetManagedBackendControlTransportPort,
  options: {
    readonly loadInstallationId: () => Promise<string>;
    readonly now?: () => number;
  },
): WorkjetDeviceInviteControlPort {
  const inviteScopes = new Map<string, BusinessOsInstanceId>();
  const now = options.now ?? Date.now;

  const resolve = async (businessOsInstanceId: BusinessOsInstanceId) => {
    const workjetInstallationId = decodeWorkjetInstallationId(await options.loadInstallationId());
    const resolved = await transport.resolve({ businessOsInstanceId, workjetInstallationId });
    assertControlScope(resolved, businessOsInstanceId, now());
    return resolved;
  };

  return {
    async create({ businessOsInstanceId: rawInstanceId, displayName, ttlSeconds = 300 }) {
      const businessOsInstanceId = decodeBusinessOsInstanceId(rawInstanceId);
      const normalizedDisplayName = displayName.trim();
      if (!normalizedDisplayName || ttlSeconds < 60 || ttlSeconds > 3_600) {
        throw new WorkjetDeviceInviteControlUnavailableError();
      }

      const resolved = await resolve(businessOsInstanceId);
      const response = await transport.createDeviceInvite({
        backendControlConnectionId: resolved.backendControlConnectionId,
        businessOsInstanceId,
        ttlSeconds,
      });
      const link = encodeWorkjetDevicePairLink(response.reference);
      const parsedReference = parseWorkjetDevicePairingLink(link, { now: now() });
      if (
        parsedReference.kind !== "reference" ||
        Date.parse(response.expiresAt) !== Date.parse(parsedReference.reference.expiresAt)
      ) {
        throw new Error("Device invite response expiry does not match its reference.");
      }

      inviteScopes.set(response.inviteId, businessOsInstanceId);
      while (inviteScopes.size > MAX_ACTIVE_INVITES) {
        const oldestInviteId = inviteScopes.keys().next().value;
        if (oldestInviteId === undefined) break;
        inviteScopes.delete(oldestInviteId);
      }
      return Object.freeze({
        inviteId: response.inviteId,
        link,
        expiresAt: parsedReference.reference.expiresAt,
        displayName: normalizedDisplayName,
      } satisfies CreatedWorkjetDeviceInvite);
    },

    async revoke({ inviteId }) {
      const businessOsInstanceId = inviteScopes.get(inviteId);
      if (!businessOsInstanceId) throw new WorkjetDeviceInviteControlUnavailableError();
      const resolved = await resolve(businessOsInstanceId);
      const response = await transport.revokeDeviceInvite({
        backendControlConnectionId: resolved.backendControlConnectionId,
        businessOsInstanceId,
        inviteId,
      });
      if (response.revoked !== true) throw new Error("Device invite revoke response is invalid.");
      inviteScopes.delete(inviteId);
    },
  };
}
