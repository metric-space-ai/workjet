// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type {
  CtoxBusinessOsLaunchConfig,
  CtoxBusinessOsLaunchSource,
} from "./CtoxBusinessOsShell.ts";

/**
 * The one place where WebRTC pairing material becomes a packed Business OS
 * launch config.
 *
 * Both launch paths converge here: the persisted pairing registry decrypts its
 * stored secret, and the local-daemon path re-derives an equivalent secret from
 * a freshly minted `ctox business-os desktop invite`. Neither may hand-roll the
 * config — a second copy is how the two paths would drift apart on exactly the
 * fields (`http_bridge_available`, the admin roles, the session shape) that
 * carry the security properties.
 *
 * The material is transient by contract: it is packed into a loopback launch
 * URL and never persisted, logged, or returned across IPC by any caller.
 */

/** Admin-equivalent CTOX roles. Kept here so both launch paths agree. */
const ADMIN_ROLES: ReadonlySet<string> = new Set(["chef", "admin", "founder"]);

export interface CtoxLaunchUser {
  readonly id?: string;
  readonly displayName?: string;
  readonly role?: string;
}

/** Room, role-bound signaling, and capability material for one launch. Never persisted here. */
export interface CtoxLaunchMaterial {
  readonly syncRoom: string;
  readonly signalingUrls: readonly string[];
  readonly signalingAuthVersion: "ctox-role-bound-v1";
  readonly browserToken: string;
  readonly browserTokenHash: string;
  readonly nativeTokenHash: string;
  readonly capabilityToken?: string;
  readonly capabilityExpiresAtMs?: number;
  readonly user?: CtoxLaunchUser;
}

export interface CtoxLaunchConfigInput {
  /** The renderer-visible instance id; it is the only identity in the config. */
  readonly instanceId: string;
  readonly displayName: string;
  readonly source: CtoxBusinessOsLaunchSource;
  readonly material: CtoxLaunchMaterial;
}

/**
 * A local daemon hands out the same document as a desktop invite (`ctox
 * business-os desktop invite`), so it authenticates as `desktop_invite`.
 */
function sessionSource(
  source: CtoxBusinessOsLaunchSource,
): "desktop_invite" | "desktop_manual_pairing" {
  return source === "manual_pairing" ? "desktop_manual_pairing" : "desktop_invite";
}

export function buildCtoxBusinessOsLaunchConfig(
  input: CtoxLaunchConfigInput,
): CtoxBusinessOsLaunchConfig {
  const { material } = input;
  const user = material.user;
  const role = user?.role;
  return {
    transport: "webrtc",
    sync_room: material.syncRoom,
    signaling_urls: material.signalingUrls,
    signaling_auth_version: material.signalingAuthVersion,
    signaling_browser_token: material.browserToken,
    signaling_browser_token_hash: material.browserTokenHash,
    signaling_native_token_hash: material.nativeTokenHash,
    http_bridge_available: false,
    desktop_instance: {
      id: input.instanceId,
      source: input.source,
      display_name: input.displayName,
      domain: "",
    },
    ...(material.capabilityToken === undefined
      ? {}
      : {
          session: {
            authenticated: true as const,
            source: sessionSource(input.source),
            capability_token: material.capabilityToken,
            ...(material.capabilityExpiresAtMs === undefined
              ? {}
              : { capability_expires_at_ms: material.capabilityExpiresAtMs }),
            ...(user === undefined
              ? {}
              : {
                  user: {
                    ...(user.id === undefined ? {} : { id: user.id }),
                    ...(user.displayName === undefined ? {} : { display_name: user.displayName }),
                    ...(role === undefined ? {} : { role }),
                    is_admin: role !== undefined && ADMIN_ROLES.has(role),
                  },
                }),
          },
        }),
  };
}
