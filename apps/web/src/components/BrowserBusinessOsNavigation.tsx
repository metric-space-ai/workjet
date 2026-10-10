import { EnvironmentId, ThreadId } from "@workjet/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { browserBusinessOsLaunchUrl } from "../crossMode/browserBusinessOsLaunch";
import { openInstanceSetup } from "../instanceSetup";

import { readActiveEnvironmentId, useActiveEnvironmentId } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";

/** Browser Ops opens the authenticated CTOX shell as a top-level navigation. */
export function BrowserBusinessOsNavigation() {
  const params = useParams({ strict: false });
  const activeEnvironmentId = useActiveEnvironmentId();
  const environmentId = params.environmentId
    ? EnvironmentId.make(params.environmentId)
    : activeEnvironmentId;
  const threadId = params.threadId ? ThreadId.make(params.threadId) : null;
  return (
    <BrowserBusinessOsEnvironmentNavigation
      key={environmentId ?? "none"}
      environmentId={environmentId}
      threadId={threadId}
      routeHasEnvironment={Boolean(params.environmentId)}
    />
  );
}

function BrowserBusinessOsEnvironmentNavigation({
  environmentId,
  threadId,
  routeHasEnvironment,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly routeHasEnvironment: boolean;
}) {
  const router = useRouter();
  const selectionKey = `workjet.browser-ops-selection:${environmentId ?? "none"}`;
  const connections = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.workjetDecisionHubConnections({ environmentId, input: {} }),
  );
  const link = useEnvironmentQuery(
    environmentId === null || threadId === null
      ? null
      : serverEnvironment.workjetCrossModeThreadLink({ environmentId, input: { threadId } }),
  );
  const resolve = useAtomCommand(serverEnvironment.resolveWorkjetBrowserOps, {
    reportFailure: false,
  });
  const [selection, setSelection] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(selectionKey);
    } catch {
      return null;
    }
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const rows = connections.data?.connections ?? [];
  // Persist only the user's selection, then resolve it against live server rows.
  // Stored IDs and display labels never grant connection or tenant authority.
  const selected = rows.find((row) => row.connectionId === selection) ?? null;
  const linked = link.data?.link;

  async function open(linkedObject: boolean) {
    if (pending || environmentId === null || selected?.status !== "ready") return;
    const location = router.state.location.href;
    setPending(true);
    setError(null);
    try {
      const result = await resolve({
        environmentId,
        input: {
          connectionId: selected.connectionId,
          selectedInstanceId: selected.instanceId,
          ...(linkedObject && threadId !== null ? { threadId } : {}),
        },
      });
      if (
        !alive.current ||
        router.state.location.href !== location ||
        (!routeHasEnvironment && readActiveEnvironmentId() !== environmentId)
      )
        return;
      if (result._tag === "Failure") {
        setError("Instanz oder Zugriff nicht mehr verfügbar. Bitte Verbindungen aktualisieren.");
        return;
      }
      const url = browserBusinessOsLaunchUrl(result.value);
      // The route stays in browser history. Back restores the same Code context;
      // no cross-origin return URL, credential or pairing payload is created.
      window.location.assign(url);
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error ? cause.message : "Business OS kann nicht geöffnet werden.",
        );
    } finally {
      if (alive.current) setPending(false);
    }
  }

  return (
    <div className="no-drag flex min-w-0 flex-wrap items-center gap-1">
      <select
        aria-label="Aktive Business-OS-Instanz"
        disabled={pending || environmentId === null}
        value={selected?.connectionId ?? ""}
        className="max-w-36 rounded-md border border-border bg-background px-2 py-1 text-xs"
        onChange={(event) => {
          const row = rows.find((candidate) => candidate.connectionId === event.target.value);
          setSelection(row?.connectionId ?? null);
          try {
            if (row) sessionStorage.setItem(selectionKey, row.connectionId);
            else sessionStorage.removeItem(selectionKey);
          } catch {
            /* Selection still works when browser storage is unavailable. */
          }
          setError(null);
        }}
      >
        <option value="">Instanz auswählen</option>
        {rows.map((row) => (
          <option key={row.connectionId} value={row.connectionId} disabled={row.status !== "ready"}>
            {row.displayName} · {row.instanceId}
            {row.status !== "ready" ? " (nicht verbunden)" : ""}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending || selected?.status !== "ready"}
        onClick={() => void open(false)}
      >
        Business OS
      </Button>
      {linked ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={
            pending ||
            selected?.status !== "ready" ||
            selected.instanceId !== linked.ctox.instanceId
          }
          onClick={() => void open(true)}
        >
          Verknüpfung öffnen
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        disabled={pending || environmentId === null}
        aria-label="Business-OS-Verbindungen aktualisieren"
        onClick={() => connections.refresh()}
      >
        ↻
      </Button>
      {error || connections.error ? (
        <span role="alert" className="basis-full text-xs text-destructive">
          {error ?? "Verbindungen konnten nicht geladen werden."}
        </span>
      ) : null}
      {!connections.isPending && rows.length === 0 ? (
        <Button size="sm" variant="ghost" onClick={() => openInstanceSetup("connect")}>
          Connect instance
        </Button>
      ) : null}
    </div>
  );
}
