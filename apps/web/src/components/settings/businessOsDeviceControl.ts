import {
  CtoxBusinessOsInviteV1,
  type DesktopCtoxBridge,
  type WorkjetDeviceBindingListResult,
  type WorkjetDeviceBindingSummary,
  type WorkjetManagedDeviceInviteManualConnectionResult,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";

import { encodeWorkjetBusinessOsPairingLink } from "./businessOsPairing";

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
  bridge: DesktopCtoxBridge,
  instanceId: string,
  businessOsInstanceId: string,
): Promise<WorkjetDeviceBindingListResult> {
  const response = record(await request(bridge, instanceId, { action: "binding.list" }));
  if (!Array.isArray(response.bindings) || response.bindings.length > 1_000) {
    throw new Error("invalid_binding_list");
  }
  const devices: WorkjetDeviceBindingSummary[] = response.bindings.map((value) => {
    const binding = record(value);
    if (
      typeof binding.id !== "string" ||
      typeof binding.deviceId !== "string" ||
      !Number.isSafeInteger(binding.pairedAtMs ?? binding.createdAtMs)
    ) {
      throw new Error("invalid_binding");
    }
    const displayName =
      typeof binding.displayName === "string" ? binding.displayName.trim().slice(0, 256) : "";
    return {
      devicePairingId: binding.id,
      deviceId: binding.deviceId,
      businessOsInstanceId,
      pairedAtMillis: Number(binding.pairedAtMs ?? binding.createdAtMs),
      ...(displayName ? { displayName } : {}),
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

/**
 * Gekoppelte Geräte heißen nach ihrem Namen (#685); ohne Namen nach Gerätetyp
 * und kurzem Datum, nie „Gerät vom TT.MM.JJJJ, hh:mm“.
 */
export function workjetDeviceDisplayName(device: WorkjetDeviceBindingSummary): string {
  const named = device as WorkjetDeviceBindingSummary & {
    readonly deviceName?: unknown;
    readonly label?: unknown;
  };
  for (const candidate of [named.deviceName, device.displayName, named.label]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  const date = new Date(device.pairedAtMillis).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  });
  return `Workjet-App · ${date}`;
}
