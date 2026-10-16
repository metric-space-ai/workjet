import type { DesktopCtoxBridge } from "@workjet/contracts";
import {
  readActiveWorkjetScope,
  subscribeActiveWorkjetHostContext,
  subscribeActiveWorkjetScope,
} from "../activeWorkjetScope";
import { createWorkjetV4Host, type WorkjetLaunchContextReader } from "./v4HostBootstrap";

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
 * Starts the Scheibe C host bootstrap. Re-checks the instance on every selection change, on
 * every guest reconnect of the selected instance (`warm`) and when a native host installed a
 * newer context. Without the desktop reader (older preload, browser build) nothing mounts.
 */
export function startWorkjetV4HostBootstrap(
  bridge: DesktopCtoxBridge | undefined,
  appVersion: string,
): () => void {
  const read = bridge?.readV4LaunchContext;
  if (!read) return () => {};
  const host = createWorkjetV4Host({
    appVersion,
    readLaunchContext: desktopLaunchContextReader(read),
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
    offScope();
    offContext();
    offGuest();
    void host.dispose();
  };
}
