import {
  CTOX_MAINTENANCE_RESTART,
  requestCtoxMaintenanceRestart,
} from "@workjet/shared/ctoxV4AppData";
import type { V4LaunchContext } from "./kernel/index";
import { getCtoxClient } from "./ctoxClient";
import { ctoxRouteOffered, markV4RouteUnavailable, v4GrantedCapabilities } from "./v4Capabilities";
import {
  redeemV4DeviceInvite,
  type V4DeviceKeySource,
  type V4InviteRedeemOutcome,
  type V4PairingControlExchange,
} from "./v4DeviceInvite";
import { workjetV4DeviceKeys } from "./v4DeviceKey";
import { renewV4DeviceLaunch, V4_RENEW_UNPAIRED, type V4RenewOutcome } from "./v4DeviceRenew";
import {
  getV4InstanceDirectoryEntry,
  markV4DeviceUnpaired,
  recordV4LaunchContext,
} from "./v4InstanceDirectory";
import { storePairedV4LaunchContext } from "./v4PairedLaunchContexts";
import {
  createV4PairingChallengeExchange,
  createV4PairingControlExchange,
  type V4PairingChallengeExchange,
} from "./v4PairingPeer";

/**
 * Instance access without SSH on V4 (E49.6). First pairing is the Shell invitation (admin in the
 * Business OS Shell); Workjet redeems it as a pairing peer over the signaling server, the only
 * third-party service, and receives the V4LaunchContext (E41, E54.4). A V3 instance keeps
 * today's desktop path until the post-cutover cleanup.
 */
export type WorkjetInviteRedeemOutcome = V4InviteRedeemOutcome;

export interface WorkjetInviteRedeemOptions {
  /** Default: the signaling pairing peer (control lane only). */
  readonly exchange?: V4PairingControlExchange;
  /** Default: the renderer's Ed25519 device key per instance. */
  readonly deviceKeys?: V4DeviceKeySource;
  readonly deviceLabel?: string;
  readonly now?: () => number;
}

/** Display label of this device; display-only, never an authority input. */
export function workjetDeviceLabel(): string {
  const platform =
    typeof navigator === "undefined"
      ? ""
      : ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
          ?.platform ?? navigator.platform);
  const name = /mac/iu.test(platform)
    ? "macOS"
    : /win/iu.test(platform)
      ? "Windows"
      : /linux/iu.test(platform)
        ? "Linux"
        : "";
  return name === "" ? "Workjet" : `Workjet (${name})`;
}

/**
 * Redeems a `workjet://pair?payload=…` V4 invitation. On success the instance enters this
 * device's directory (E54.5), the launch context is stored and the V4 host bootstrap mounts that
 * instance with it.
 */
export async function redeemWorkjetDeviceInvite(
  pairingUri: string,
  options: WorkjetInviteRedeemOptions = {},
): Promise<WorkjetInviteRedeemOutcome> {
  const outcome = await redeemV4DeviceInvite({
    link: pairingUri,
    exchange: options.exchange ?? createV4PairingControlExchange(),
    deviceKeys: options.deviceKeys ?? workjetV4DeviceKeys(),
    deviceLabel: options.deviceLabel ?? workjetDeviceLabel(),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  if (outcome.ok) {
    const now = options.now ?? Date.now;
    await recordV4LaunchContext(outcome.launchContext, now()).catch(() => undefined);
    storePairedV4LaunchContext(outcome.instanceId, outcome.payload);
  }
  return outcome;
}

export interface WorkjetDeviceRenewOptions {
  /** Default: the signaling pairing peer answering the Core's challenge. */
  readonly exchange?: V4PairingChallengeExchange;
  readonly deviceKeys?: Parameters<typeof renewV4DeviceLaunch>[0]["deviceKeys"];
  readonly now?: () => number;
}

/**
 * `device.launch.renew` for a paired V4 instance of this device (E54.5). Success refreshes the
 * directory entry; `device_revoked`/`device_unknown` mark it unpaired, which stops renewal until a
 * new invitation is redeemed. `null`: the instance is not in this device's directory.
 */
export async function renewWorkjetDeviceLaunch(
  instanceId: string,
  options: WorkjetDeviceRenewOptions = {},
): Promise<V4RenewOutcome | null> {
  const entry = getV4InstanceDirectoryEntry(instanceId);
  if (entry === undefined) return null;
  const now = options.now ?? Date.now;
  if (entry.state === "unpaired") return { ok: false, code: "device_revoked" };
  const outcome = await renewV4DeviceLaunch({
    entry,
    deviceKeys: options.deviceKeys ?? workjetV4DeviceKeys(),
    exchange: options.exchange ?? createV4PairingChallengeExchange(),
    now,
  });
  if (outcome.ok) await recordV4LaunchContext(outcome.launchContext, now()).catch(() => undefined);
  else if (V4_RENEW_UNPAIRED.includes(outcome.code))
    await markV4DeviceUnpaired(instanceId, now()).catch(() => undefined);
  return outcome;
}

/** Discovery is signaling only: the endpoints come from the launch context, never from an SSH probe. */
export function ctoxSignalingEndpoints(launchContext: Readonly<V4LaunchContext["v4"]>) {
  return launchContext.signaling.urls.filter((url) => /^wss?:\/\//u.test(url));
}

export type CtoxInstanceRestartOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string };

/**
 * Whether a restart may be offered at all. V3 keeps its desktop path; V4 only when the Core granted
 * `ctox.maintenance.restart` in hello_ok, the actor is admin and the route did not answer
 * `unavailable` this session. Otherwise the UI shows no restart action and no hint.
 */
export function ctoxInstanceRestartOffered(instanceId: string): boolean {
  const api = getCtoxClient(instanceId);
  if (api === null) return true;
  return api.actor.role === "admin" && ctoxRouteOffered(instanceId, CTOX_MAINTENANCE_RESTART);
}

/**
 * Service restart: on a bound V4 client `ctox.maintenance.restart` behind the hello_ok grant
 * (or the explicit `capabilities`); on V3 the existing desktop path (`v3Restart`) stays until the
 * cutover cleanup. An `unavailable` answer hides the action for the rest of the session.
 */
export async function restartCtoxInstance(
  instanceId: string,
  options: {
    readonly capabilities?: ReadonlyArray<string>;
    readonly reason: string;
    readonly v3Restart: () => Promise<CtoxInstanceRestartOutcome>;
  },
): Promise<CtoxInstanceRestartOutcome> {
  const api = getCtoxClient(instanceId);
  if (api === null) return options.v3Restart();
  const capabilities = options.capabilities ?? v4GrantedCapabilities(instanceId) ?? [];
  const outcome = await requestCtoxMaintenanceRestart(api, capabilities, options.reason);
  if (!outcome.ok && outcome.code === "unavailable")
    markV4RouteUnavailable(instanceId, CTOX_MAINTENANCE_RESTART);
  return outcome;
}

/** SSH-managed instance paths (add/discover/fleet over SSH) are V3 only; a V4 instance never uses them. */
export function ctoxSshInstancePathAllowed(instanceId: string | null): boolean {
  return instanceId === null || getCtoxClient(instanceId) === null;
}
