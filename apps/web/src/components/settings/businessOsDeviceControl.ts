import {
  CtoxBusinessOsInviteV1,
  type DesktopCtoxBridge,
  type WorkjetDeviceBindingListResult,
  type WorkjetDeviceBindingSummary,
  type WorkjetManagedDeviceInviteManualConnectionResult,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";

import { encodeWorkjetBusinessOsPairingLink } from "./businessOsPairing";
import { getCtoxClient } from "../../ctox/ctoxClient";
import { readCtoxDevices } from "../../ctox/deviceData";

export interface BusinessOsWebRtcDeviceInvite {
  readonly inviteId: string;
  readonly link: string;
  readonly expiresAt: string;
  readonly manualConnection: WorkjetManagedDeviceInviteManualConnectionResult;
}

export function businessOsDeviceControlErrorMessage(error: unknown, fallback: string): string {
  const code = error instanceof Error ? error.message : "";
  switch (code) {
    case "unsupported":
    case "ctox_webrtc_unavailable":
      return "Instanz unterstützt die Geräteverwaltung noch nicht.";
    case "sync_unavailable":
      return "Instanz nicht erreichbar.";
    case "forbidden":
      return "Keine Berechtigung für Geräte dieser Instanz.";
    case "not_active":
      return "Instanz nicht verbunden.";
    default:
      return fallback;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CTOX device response is invalid.");
  }
  return value as Record<string, unknown>;
}

async function request(
  bridge: DesktopCtoxBridge,
  instanceId: string,
  input: Parameters<NonNullable<DesktopCtoxBridge["requestDeviceControl"]>>[1],
): Promise<unknown> {
  if (bridge.requestDeviceControl === undefined) throw new Error("ctox_webrtc_unavailable");
  const result = await bridge.requestDeviceControl(instanceId, input);
  if (result._tag !== "completed") throw new Error(result.code);
  return result.response;
}

export async function listBusinessOsDevices(
  _bridge: DesktopCtoxBridge,
  instanceId: string,
  businessOsInstanceId: string,
): Promise<WorkjetDeviceBindingListResult> {
  const api = getCtoxClient(instanceId);
  if (!api) throw new Error("not_active");
  const devices: WorkjetDeviceBindingSummary[] = readCtoxDevices(api).map((binding) => {
    return {
      devicePairingId: binding.id,
      // V4's canonical device identity is device_pairing_id (§16.43).
      deviceId: binding.id,
      businessOsInstanceId,
      pairedAtMillis: binding.created_at_ms,
    };
  });
  return { devices };
}

export async function createBusinessOsDeviceInvite(
  bridge: DesktopCtoxBridge,
  instanceId: string,
  displayName: string,
): Promise<BusinessOsWebRtcDeviceInvite> {
  const response = record(
    await request(bridge, instanceId, {
      action: "invite.create",
      ttlSeconds: 300,
      displayName,
    }),
  );
  if (typeof response.inviteId !== "string" || typeof response.expiresAt !== "string") {
    throw new Error("invalid_invite");
  }
  const invite = Schema.decodeUnknownSync(CtoxBusinessOsInviteV1)(response.invite, {
    onExcessProperty: "error",
  });
  return {
    inviteId: response.inviteId,
    link: encodeWorkjetBusinessOsPairingLink(invite),
    expiresAt: response.expiresAt,
    manualConnection: {
      signalingUrls: [...invite.signaling_urls],
      room: invite.sync_room,
      authVersion: invite.signaling_auth_version,
      browserToken: invite.signaling_browser_token,
      browserTokenHash: invite.signaling_browser_token_hash,
      nativeTokenHash: invite.signaling_native_token_hash,
      expiresAt: response.expiresAt,
    },
  };
}

export async function revokeBusinessOsDeviceInvite(
  bridge: DesktopCtoxBridge,
  instanceId: string,
  inviteId: string,
): Promise<void> {
  const response = record(await request(bridge, instanceId, { action: "invite.revoke", inviteId }));
  if (response.revoked !== true) throw new Error("invite_revoke_failed");
}

export async function revokeBusinessOsDevice(
  bridge: DesktopCtoxBridge,
  instanceId: string,
  bindingId: string,
): Promise<void> {
  const response = record(
    await request(bridge, instanceId, { action: "binding.revoke", bindingId }),
  );
  if (response.revoked !== true) throw new Error("binding_revoke_failed");
}
