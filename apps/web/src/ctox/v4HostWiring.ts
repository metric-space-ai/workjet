import type { DesktopCtoxBridge } from "@workjet/contracts";
import {
  readActiveWorkjetScope,
  subscribeActiveWorkjetHostContext,
  subscribeActiveWorkjetScope,
} from "../activeWorkjetScope";
import { createWorkjetV4Host, type WorkjetLaunchContextReader } from "./v4HostBootstrap";
import {
  subscribePairedV4LaunchContexts,
  takePairedV4LaunchContext,
} from "./v4PairedLaunchContexts";

/** Desktop control-plane reader: only the `v4` member of the instance's launch context. */
export function desktopLaunchContextReader(
  read: NonNullable<DesktopCtoxBridge["readV4LaunchContext"]>,
): WorkjetLaunchContextReader {
  return async (instanceId) => {
    const result = await read(instanceId);
    if (result._tag === "failed") throw new Error(`ctox_launch_context_${result.code}`);
    return { v4: result.v4 };
  };
}

/**
 * E54.4: a launch context returned by a redeemed device invitation is read first (once; its E50
 * ticket is single-use). Every later read goes to the desktop control plane, when there is one.
 */
export function pairedFirstLaunchContextReader(
  fallback: WorkjetLaunchContextReader | undefined,
): WorkjetLaunchContextReader {
  return async (instanceId) => {
    const paired = takePairedV4LaunchContext(instanceId);
    if (paired !== undefined) return paired;
    if (fallback === undefined) throw new Error("ctox_launch_context_unavailable");
    return fallback(instanceId);
  };
}

/**
 * Starts the Scheibe C host bootstrap. Re-checks the instance on every selection change, on
 * every guest reconnect of the selected instance (`warm`) and when a native host installed a
 * newer context. Without the desktop reader (older preload, browser build) only an instance
 * whose invitation was just redeemed mounts.
 */
export function startWorkjetV4HostBootstrap(
  bridge: DesktopCtoxBridge | undefined,
  appVersion: string,
): () => void {
  const read = bridge?.readV4LaunchContext;
  const host = createWorkjetV4Host({
    appVersion,
    readLaunchContext: pairedFirstLaunchContextReader(
      read ? desktopLaunchContextReader(read) : undefined,
    ),
  });
  // A redeemed invitation (E54.4) mounts its instance right away.
  const offPaired = subscribePairedV4LaunchContexts((instanceId) => {
    void host.sync(instanceId).catch(() => {});
  });
  if (!read || bridge === undefined) {
    return () => {
      offPaired();
      void host.dispose();
    };
  }
  // Desktop Main closes SSH instance paths for V4 instances (E49.6).
  const report = bridge.reportV4Generation;
  let reported: { instanceId: string | null; generation: string | null } = {
    instanceId: null,
    generation: null,
  };
  const offState = host.subscribe(() => {
    const state = host.getState();
    if (!report || state.instanceId === null) return;
    if (state.instanceId === reported.instanceId && state.generation === reported.generation)
      return;
    reported = state;
    void report(state.instanceId, state.generation).catch(() => {});
  });
  const check = () => {
    // Failures stay silent (UI contract): the next reconnect or selection checks again.
    void host.sync(readActiveWorkjetScope().selectedInstanceId).catch(() => {});
  };
  let selected = readActiveWorkjetScope().selectedInstanceId;
  const offScope = subscribeActiveWorkjetScope(() => {
    const next = readActiveWorkjetScope().selectedInstanceId;
    if (next === selected) return;
    selected = next;
    check();
  });
  const offContext = subscribeActiveWorkjetHostContext(check);
  const offGuest =
    bridge.onGuestState?.((event) => {
      if (
        event.state === "warm" &&
        event.instanceId === readActiveWorkjetScope().selectedInstanceId
      )
        check();
    }) ?? (() => {});
  check();
  return () => {
    offPaired();
    offState();
    offScope();
    offContext();
    offGuest();
    void host.dispose();
  };
}
