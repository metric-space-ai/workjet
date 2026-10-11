import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentTarget,
  EnvironmentId,
} from "@workjet/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@workjet/client-runtime/state/runtime";
import * as Option from "effect/Option";

import { environmentCatalog } from "~/connection/catalog";
import { connectSshEnvironment as connectSshEnvironmentAtom } from "~/connection/onboarding";
import { useEnvironmentQuery } from "~/state/query";
import { desktopSshHostsStateAtom } from "~/state/desktopSshHosts";
import { useEnvironments } from "~/state/environments";
import { useAtomCommand } from "../../state/use-atom-command";

const EMPTY_DISCOVERED_SSH_HOSTS: ReadonlyArray<DesktopDiscoveredSshHost> = [];

export function formatDesktopSshTarget(target: DesktopSshEnvironmentTarget): string {
  const authority = target.username ? `${target.username}@${target.hostname}` : target.hostname;
  return target.port ? `${authority}:${target.port}` : authority;
}

/** Address field of the inline add form: `host`, `user@host`, `host:port` or `[v6]:port`. */
export function parseManualDesktopSshTarget(input: {
  readonly host: string;
  readonly username: string;
  readonly port: string;
}): DesktopSshEnvironmentTarget {
  const rawHost = input.host.trim();
  if (rawHost.length === 0) {
    throw new Error("Adresse fehlt.");
  }

  let hostname = rawHost;
  let username = input.username.trim() || null;
  let port: number | null = null;

  const atIndex = hostname.lastIndexOf("@");
  if (atIndex > 0) {
    const inlineUsername = hostname.slice(0, atIndex).trim();
    hostname = hostname.slice(atIndex + 1).trim();
    if (!username && inlineUsername.length > 0) {
      username = inlineUsername;
    }
  }

  const bracketedHostMatch = /^\[([^\]]+)\](?::(\d+))?$/u.exec(hostname);
  if (bracketedHostMatch) {
    hostname = bracketedHostMatch[1]!.trim();
    if (bracketedHostMatch[2]) {
      port = Number.parseInt(bracketedHostMatch[2], 10);
    }
  } else {
    const colonSegments = hostname.split(":");
    if (colonSegments.length === 2 && /^\d+$/u.test(colonSegments[1] ?? "")) {
      hostname = colonSegments[0]!.trim();
      port = Number.parseInt(colonSegments[1]!, 10);
    }
  }

  const rawPort = input.port.trim();
  if (rawPort.length > 0) {
    port = Number.parseInt(rawPort, 10);
  }

  if (hostname.length === 0) {
    throw new Error("Adresse fehlt.");
  }

  if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65_535)) {
    throw new Error("Port muss zwischen 1 und 65535 liegen.");
  }

  return {
    alias: hostname,
    hostname,
    username,
    port,
  };
}

export function formatDesktopSshConnectionError(error: unknown): string {
  const fallback = "SSH-Verbindung fehlgeschlagen.";
  const rawMessage = error instanceof Error ? error.message : fallback;
  const withoutIpcPrefix = rawMessage.replace(
    /^Error invoking remote method 'desktop:ensure-ssh-environment':\s*/u,
    "",
  );
  const withoutTaggedErrorPrefix = withoutIpcPrefix.replace(/^Ssh[A-Za-z]+Error:\s*/u, "");
  return withoutTaggedErrorPrefix.trim() || fallback;
}

function commandError(
  result: Parameters<typeof squashAtomCommandFailure>[0],
  fallback: string,
): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

export type ComputerConnectResult =
  | { readonly ok: true; readonly environmentId: EnvironmentId }
  | { readonly ok: false; readonly message: string | null };

/**
 * Headless connection lifecycle for Einstellungen › Rechner. The page renders
 * everything inline (Zeile, Inline-Panel); this hook only owns the saved
 * connection catalog, SSH alias discovery and the connect/remove commands.
 */
export function useComputerConnections({
  discoverSshHosts = false,
}: {
  /** Load ~/.ssh/config aliases (only while the add panel shows SSH). */
  readonly discoverSshHosts?: boolean;
} = {}) {
  const desktopBridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const { environments } = useEnvironments();
  const connectSshEnvironment = useAtomCommand(connectSshEnvironmentAtom, {
    reportFailure: false,
  });
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const disconnectEnvironment = useAtomCommand(environmentCatalog.disconnect, {
    reportFailure: false,
  });
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const savedEnvironments = useMemo(
    () =>
      environments
        .filter((environment) => environment.entry.target._tag !== "PrimaryConnectionTarget")
        .toSorted((left, right) => left.label.localeCompare(right.label)),
    [environments],
  );
  const savedSshTargets = useMemo(() => {
    const targets = new Map<EnvironmentId, DesktopSshEnvironmentTarget>();
    for (const environment of savedEnvironments) {
      const profile = environment.entry.profile;
      if (
        environment.entry.target._tag === "SshConnectionTarget" &&
        Option.isSome(profile) &&
        profile.value._tag === "SshConnectionProfile"
      ) {
        targets.set(environment.environmentId, profile.value.target);
      }
    }
    return targets;
  }, [savedEnvironments]);
  const savedSshKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const target of savedSshTargets.values()) {
      keys.add(target.alias);
      keys.add(formatDesktopSshTarget(target));
    }
    return keys;
  }, [savedSshTargets]);
  const [busyEnvironmentId, setBusyEnvironmentId] = useState<EnvironmentId | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [recoveringCatalog, setRecoveringCatalog] = useState(false);

  const sshHostsQuery = useEnvironmentQuery(
    desktopBridge && discoverSshHosts ? desktopSshHostsStateAtom : null,
  );
  useEffect(() => {
    if (!desktopBridge?.getConnectionCatalog || !discoverSshHosts) return;
    let active = true;
    void desktopBridge.getConnectionCatalog().then(
      () => {
        if (active) setCatalogError(null);
      },
      (error: unknown) => {
        if (active)
          setCatalogError(
            error instanceof Error ? error.message : "Gespeicherte Verbindungen nicht lesbar.",
          );
      },
    );
    return () => {
      active = false;
    };
  }, [desktopBridge, discoverSshHosts]);
  const discovered = sshHostsQuery.data ?? EMPTY_DISCOVERED_SSH_HOSTS;
  /** Aliases from ~/.ssh/config that are not a row yet. */
  const sshAliases = useMemo(
    () =>
      discovered.filter(
        (target) =>
          target.source === "ssh-config" &&
          !savedSshKeys.has(target.alias) &&
          !savedSshKeys.has(formatDesktopSshTarget(target)),
      ),
    [discovered, savedSshKeys],
  );
  /** known_hosts entries: suggestions for the address field, never rows. */
  const knownHosts = useMemo(
    () =>
      [
        ...new Set(
          discovered
            .filter((target) => target.source === "known-hosts")
            .map((target) => target.hostname),
        ),
      ].toSorted(),
    [discovered],
  );
  const catalogRecoveryAvailable =
    desktopBridge?.recoverConnectionCatalog !== undefined &&
    catalogError !== null &&
    (catalogError.includes("decrypt-catalog") ||
      catalogError.includes("Failed to decode encryptedCatalog") ||
      catalogError.includes("Failed to decode the desktop connection catalog document"));
  const recoverCatalog = useCallback(async () => {
    if (desktopBridge?.recoverConnectionCatalog === undefined || recoveringCatalog) return;
    setRecoveringCatalog(true);
    try {
      await desktopBridge.recoverConnectionCatalog();
      setCatalogError(null);
      sshHostsQuery.refresh();
    } catch (error) {
      setCatalogError(
        error instanceof Error ? error.message : "Verbindungen nicht wiederherstellbar.",
      );
    } finally {
      setRecoveringCatalog(false);
    }
  }, [desktopBridge, recoveringCatalog, sshHostsQuery]);

  const connectSsh = useCallback(
    async (target: DesktopSshEnvironmentTarget, label?: string): Promise<ComputerConnectResult> => {
      setConnecting(true);
      try {
        const result = await connectSshEnvironment({
          target,
          ...(label?.trim() ? { label: label.trim() } : {}),
        });
        if (result._tag === "Success") return { ok: true, environmentId: result.value };
        if (isAtomCommandInterrupted(result)) return { ok: false, message: null };
        return {
          ok: false,
          message: formatDesktopSshConnectionError(squashAtomCommandFailure(result)),
        };
      } finally {
        setConnecting(false);
      }
    },
    [connectSshEnvironment],
  );
  const reconnect = useCallback(
    async (environmentId: EnvironmentId): Promise<string | null> => {
      setBusyEnvironmentId(environmentId);
      const result = await retryEnvironment(environmentId);
      setBusyEnvironmentId(null);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
        return commandError(result, "Verbindung fehlgeschlagen.");
      return null;
    },
    [retryEnvironment],
  );
  const disconnect = useCallback(
    async (environmentId: EnvironmentId): Promise<string | null> => {
      setBusyEnvironmentId(environmentId);
      const result = await disconnectEnvironment(environmentId);
      setBusyEnvironmentId(null);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
        return commandError(result, "Trennen fehlgeschlagen.");
      return null;
    },
    [disconnectEnvironment],
  );
  const removeConnection = useCallback(
    async (environmentId: EnvironmentId): Promise<boolean> => {
      setBusyEnvironmentId(environmentId);
      const result = await removeEnvironment(environmentId);
      setBusyEnvironmentId(null);
      return result._tag === "Success";
    },
    [removeEnvironment],
  );

  return {
    desktopAvailable: desktopBridge !== undefined,
    savedEnvironments,
    savedSshTargets,
    sshAliases,
    knownHosts,
    sshAliasesLoading: sshHostsQuery.isPending,
    sshAliasesError: sshHostsQuery.error,
    refreshSshAliases: sshHostsQuery.refresh,
    catalogError,
    catalogRecoveryAvailable,
    recoveringCatalog,
    recoverCatalog,
    connecting,
    busyEnvironmentId,
    busy: connecting || busyEnvironmentId !== null,
    connectSsh,
    reconnect,
    disconnect,
    removeConnection,
  };
}

export type ComputerConnections = ReturnType<typeof useComputerConnections>;
