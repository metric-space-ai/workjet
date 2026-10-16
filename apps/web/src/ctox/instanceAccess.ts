import { requestCtoxMaintenanceRestart } from "@workjet/shared/ctoxV4AppData";
import { parseV4LaunchContext } from "./kernel/index";
import type { V4LaunchContext } from "./kernel/index";
import { getCtoxClient } from "./ctoxClient";

/**
 * Instance access without SSH on V4 (E49.6). First pairing is the Shell invitation
 * (`ctox.workjet.device.v1 invite.create`, admin in the Business OS Shell); Workjet redeems its
 * opaque payload over the signaling server, the only third-party service, and receives the
 * V4LaunchContext (E41). A V3 instance keeps today's desktop path until the post-cutover cleanup.
 */
const PAIRING_URI = /^workjet:\/\/pair\?payload=([A-Za-z0-9_-]{1,2300})$/u;

export type WorkjetInviteRedeemOutcome =
  | { readonly ok: true; readonly launchContext: Readonly<V4LaunchContext["v4"]> }
  | {
      readonly ok: false;
      readonly code: "invite_invalid" | "redeem_failed" | "launch_context_invalid";
    };

/** The signaling exchange of the invite payload; the transport is the host's, never SSH or HTTPS to the instance. */
export type WorkjetSignalingInviteExchange = (payload: string) => Promise<unknown>;

export async function redeemWorkjetDeviceInvite(
  pairingUri: string,
  exchange: WorkjetSignalingInviteExchange,
): Promise<WorkjetInviteRedeemOutcome> {
  const payload = PAIRING_URI.exec(pairingUri.trim())?.[1];
  if (payload === undefined) return { ok: false, code: "invite_invalid" };
  let answer: unknown;
  try {
    answer = await exchange(payload);
  } catch {
    return { ok: false, code: "redeem_failed" };
  }
  try {
    return { ok: true, launchContext: parseV4LaunchContext(answer) };
  } catch {
    return { ok: false, code: "launch_context_invalid" };
  }
}

/** Discovery is signaling only: the endpoints come from the launch context, never from an SSH probe. */
export function ctoxSignalingEndpoints(launchContext: Readonly<V4LaunchContext["v4"]>) {
  return launchContext.signaling.urls.filter((url) => /^wss?:\/\//u.test(url));
}

export type CtoxInstanceRestartOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string };

/**
 * Service restart: on a bound V4 client `ctox.maintenance.restart` behind the capability from the
 * launch context; on V3 the existing desktop path (`v3Restart`) stays until the cutover cleanup.
 */
export function restartCtoxInstance(
  instanceId: string,
  options: {
    readonly capabilities: ReadonlyArray<string>;
    readonly reason: string;
    readonly v3Restart: () => Promise<CtoxInstanceRestartOutcome>;
  },
): Promise<CtoxInstanceRestartOutcome> {
  const api = getCtoxClient(instanceId);
  if (api === null) return options.v3Restart();
  return requestCtoxMaintenanceRestart(api, options.capabilities, options.reason);
}

/** SSH-managed instance paths (add/discover/fleet over SSH) are V3 only; a V4 instance never uses them. */
export function ctoxSshInstancePathAllowed(instanceId: string | null): boolean {
  return instanceId === null || getCtoxClient(instanceId) === null;
}
