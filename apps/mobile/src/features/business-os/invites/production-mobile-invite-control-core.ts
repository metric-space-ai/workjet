import type {
  CtoxMobileInviteCreateInput,
  CtoxMobileInviteCreateResult,
  CtoxMobileInviteRevokeInput,
  CtoxMobileInviteRevokeResult,
} from "@t3tools/contracts";

import type { SavedRemoteConnection } from "../../../lib/connection";
import type { BusinessOsInstance } from "../registry/business-os-registry";
import {
  decodeCreatedBusinessOsMobileInvite,
  type BusinessOsMobileInviteControlPort,
} from "./mobile-invite-control";

export interface BusinessOsInviteHttpPort {
  readonly create: (input: CtoxMobileInviteCreateInput) => Promise<CtoxMobileInviteCreateResult>;
  readonly revoke: (input: CtoxMobileInviteRevokeInput) => Promise<CtoxMobileInviteRevokeResult>;
}

export function resolveBusinessOsControlConnection(
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

export function makeBusinessOsMobileInviteControl(
  http: BusinessOsInviteHttpPort,
  options: { readonly now?: () => number } = {},
): BusinessOsMobileInviteControlPort {
  return {
    async create({ ttlSeconds = 300 }) {
      const response = await http.create({ ttlSeconds });
      return decodeCreatedBusinessOsMobileInvite(response, { now: options.now?.() });
    },
    async revoke({ inviteId }) {
      const response = await http.revoke({ inviteId });
      if (response.revoked !== true) throw new Error("Mobile invite revoke response is invalid.");
    },
  };
}
