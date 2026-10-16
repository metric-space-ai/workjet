import type {
  ComputerConnection,
  DesktopBridge,
  DesktopSshEnvironmentProgress,
  DesktopSshEnvironmentTarget,
} from "@workjet/contracts";
import { useEffect, useState } from "react";

/**
 * Idle-gated replacement of an outdated remote Workjet backend (Desktop SSH
 * manager). The row only shows it: orange dot while `updating`, one line
 * „Aktualisierung fehlgeschlagen · Erneut“ after `failed`.
 */
export type RemoteDaemonUpdateState = "updating" | "failed";
export type RemoteDaemonUpdates = ReadonlyMap<string, RemoteDaemonUpdateState>;

export function remoteDaemonUpdateKey(target: {
  readonly alias: string;
  readonly hostname: string;
}): string {
  return (target.alias || target.hostname).trim().toLowerCase();
}

/** Applies one live step; steps of the first connect leave the map alone. */
export function nextRemoteDaemonUpdates(
  current: RemoteDaemonUpdates,
  progress: Pick<DesktopSshEnvironmentProgress, "alias" | "hostname" | "phase">,
): RemoteDaemonUpdates {
  const key = remoteDaemonUpdateKey(progress);
  const state: RemoteDaemonUpdateState | null | undefined =
    progress.phase === "updating"
      ? "updating"
      : progress.phase === "update-failed"
        ? "failed"
        : progress.phase === "updated"
          ? null
          : undefined;
  if (state === undefined || current.get(key) === (state ?? undefined)) return current;
  const next = new Map(current);
  if (state === null) next.delete(key);
  else next.set(key, state);
  return next;
}

export function remoteDaemonTarget(
  connection: ComputerConnection | null | undefined,
): DesktopSshEnvironmentTarget | null {
  return connection && connection._tag !== "local" ? connection.target : null;
}

export function remoteDaemonUpdateFor(
  updates: RemoteDaemonUpdates | undefined,
  connection: ComputerConnection | null | undefined,
): RemoteDaemonUpdateState | null {
  const target = remoteDaemonTarget(connection);
  return target && updates ? (updates.get(remoteDaemonUpdateKey(target)) ?? null) : null;
}

export function useRemoteDaemonUpdates(
  bridge: Pick<DesktopBridge, "onSshEnvironmentProgress"> | undefined,
): readonly [RemoteDaemonUpdates, (key: string, state: RemoteDaemonUpdateState | null) => void] {
  const [updates, setUpdates] = useState<RemoteDaemonUpdates>(() => new Map());
  useEffect(() => {
    if (!bridge?.onSshEnvironmentProgress) return;
    return bridge.onSshEnvironmentProgress((progress) =>
      setUpdates((current) => nextRemoteDaemonUpdates(current, progress)),
    );
  }, [bridge]);
  const set = (key: string, state: RemoteDaemonUpdateState | null) =>
    setUpdates((current) => {
      const next = new Map(current);
      if (state === null) next.delete(key);
      else next.set(key, state);
      return next;
    });
  return [updates, set] as const;
}
