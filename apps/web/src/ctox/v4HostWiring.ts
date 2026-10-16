import type { DesktopCtoxBridge } from "@workjet/contracts";
import {
  readActiveWorkjetScope,
  subscribeActiveWorkjetHostContext,
  subscribeActiveWorkjetScope,
} from "../activeWorkjetScope";
import { renewWorkjetDeviceLaunch } from "./instanceAccess";
import {
  V4_RENEW_UNPAIRED,
  type V4RenewFailureCode,
  type V4RenewOutcome,
} from "./v4DeviceRenew";
import {
  createWorkjetV4Host,
  type WorkjetLaunchContextReader,
  type WorkjetV4HostOptions,
} from "./v4HostBootstrap";
import {
  getV4InstanceDirectoryEntry,
  isV4DirectoryInstance,
  loadV4InstanceDirectory,
} from "./v4InstanceDirectory";
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

export class V4RenewFailed extends Error {
  constructor(readonly code: string) {
    super(`ctox_device_renew_${code}`);
    this.name = "V4RenewFailed";
  }
}

export type WorkjetDeviceRenew = (instanceId: string) => Promise<V4RenewOutcome | null>;

/**
 * Launch context per read (E54.4/E54.5):
 * 1. the context a redeemed invitation just returned (once; its E50 ticket is single-use),
 * 2. for a paired V4 instance of this device (directory): `device.launch.renew`,
 * 3. otherwise the desktop control plane, when there is one.
 */
export function workjetV4LaunchContextReader(options: {
  readonly fallback: WorkjetLaunchContextReader | undefined;
  readonly renew?: WorkjetDeviceRenew;
}): WorkjetLaunchContextReader {
  const renew = options.renew ?? ((instanceId: string) => renewWorkjetDeviceLaunch(instanceId));
  return async (instanceId) => {
    const paired = takePairedV4LaunchContext(instanceId);
    if (paired !== undefined) return paired;
    if (getV4InstanceDirectoryEntry(instanceId) !== undefined) {
      const outcome = await renew(instanceId);
      if (outcome?.ok) return outcome.payload;
      if (outcome !== null) throw new V4RenewFailed(outcome.code);
    }
    if (options.fallback === undefined) throw new Error("ctox_launch_context_unavailable");
    return options.fallback(instanceId);
  };
}

/** Kept for callers of #811: paired context first, then the fallback (no renewal). */
export function pairedFirstLaunchContextReader(
  fallback: WorkjetLaunchContextReader | undefined,
): WorkjetLaunchContextReader {
  return workjetV4LaunchContextReader({ fallback, renew: async () => null });
}

/** Silent retry of a failed renewal: 2 s, 4 s, … capped at 60 s. */
export function v4RenewBackoffMs(failures: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, failures - 1));
}

export interface WorkjetV4HostBootstrapOptions {
  readonly renew?: WorkjetDeviceRenew;
  readonly openSession?: WorkjetV4HostOptions["openSession"];
  readonly setTimer?: (run: () => void, ms: number) => () => void;
}

/**
 * Starts the Scheibe C host bootstrap. Re-checks the instance on every selection change, on
 * every guest reconnect of the selected instance (`warm`) and when a native host installed a
 * newer context. A paired V4 instance of this device (directory) renews its launch context over
 * the pairing peer at start and on every switch to it; failures retry silently with backoff,
 * except `device_revoked`/`device_unknown`, which stop until a new invitation.
 */
export function startWorkjetV4HostBootstrap(
  bridge: DesktopCtoxBridge | undefined,
  appVersion: string,
  options: WorkjetV4HostBootstrapOptions = {},
): () => void {
  const read = bridge?.readV4LaunchContext;
  const setTimer =
    options.setTimer ??
    ((run: () => void, ms: number) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    });
  let lastRenew: { instanceId: string; code: V4RenewFailureCode | null } | null = null;
  const renewTracked: WorkjetDeviceRenew = async (instanceId) => {
    const outcome = await (options.renew ?? renewWorkjetDeviceLaunch)(instanceId);
    lastRenew = { instanceId, code: outcome === null || outcome.ok ? null : outcome.code };
    return outcome;
  };
  const host = createWorkjetV4Host({
    appVersion,
    readLaunchContext: workjetV4LaunchContextReader({
      fallback: read ? desktopLaunchContextReader(read) : undefined,
      renew: renewTracked,
    }),
    ...(options.openSession === undefined ? {} : { openSession: options.openSession }),
  });
  // Desktop Main closes SSH instance paths for V4 instances (E49.6).
  const report = bridge?.reportV4Generation;
  let reported: { instanceId: string | null; generation: string | null } = {
    instanceId: null,
    generation: null,
  };
  const offState = host.subscribe(() => {
    const state = host.getState();
    if (!report || state.instanceId === null || isV4DirectoryInstance(state.instanceId)) return;
    if (state.instanceId === reported.instanceId && state.generation === reported.generation)
      return;
    reported = state;
    void report(state.instanceId, state.generation).catch(() => {});
  });
  let failures = 0;
  let cancelRetry: (() => void) | null = null;
  let disposed = false;
  const sync = (instanceId: string | null) => {
    cancelRetry?.();
    cancelRetry = null;
    // Without the desktop reader only paired V4 instances of this device can mount.
    if (!read && instanceId !== null && !isV4DirectoryInstance(instanceId)) return;
    void host
      .sync(instanceId)
      .then((state) => {
        if (disposed || instanceId === null || !isV4DirectoryInstance(instanceId)) return;
        if (state.generation === "v4") {
          failures = 0;
          return;
        }
        const code = lastRenew?.instanceId === instanceId ? lastRenew.code : null;
        if (code !== null && V4_RENEW_UNPAIRED.includes(code)) return;
        failures += 1;
        cancelRetry = setTimer(() => {
          if (readActiveWorkjetScope().selectedInstanceId === instanceId) sync(instanceId);
        }, v4RenewBackoffMs(failures));
      })
      .catch(() => {});
  };
  const check = () => {
    // Failures stay silent (UI contract): the next reconnect or selection checks again.
    sync(readActiveWorkjetScope().selectedInstanceId);
  };
  // A redeemed invitation mounts its instance right away.
  const offPaired = subscribePairedV4LaunchContexts((instanceId) => {
    failures = 0;
    sync(instanceId);
  });
  let selected = readActiveWorkjetScope().selectedInstanceId;
  const offScope = subscribeActiveWorkjetScope(() => {
    const next = readActiveWorkjetScope().selectedInstanceId;
    if (next === selected) return;
    selected = next;
    failures = 0;
    check();
  });
  const offContext = subscribeActiveWorkjetHostContext(check);
  const offGuest =
    bridge?.onGuestState?.((event) => {
      if (
        event.state === "warm" &&
        event.instanceId === readActiveWorkjetScope().selectedInstanceId
      )
        check();
    }) ?? (() => {});
  // The directory decides how the restored selection gets its context: load it first.
  void loadV4InstanceDirectory()
    .catch(() => {})
    .then(() => {
      if (!disposed) check();
    });
  return () => {
    disposed = true;
    cancelRetry?.();
    offPaired();
    offState();
    offScope();
    offContext();
    offGuest();
    void host.dispose();
  };
}
