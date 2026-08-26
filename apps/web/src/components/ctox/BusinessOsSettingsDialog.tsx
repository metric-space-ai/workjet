// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type {
  CtoxDiscoveryResult,
  CtoxShellFleetInventoryResult,
  CtoxShellFleetRow,
  CtoxShellFleetRolloutStatus,
  DesktopCtoxBridge,
} from "@t3tools/contracts";
import { RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { usePrimaryEnvironment } from "../../state/environments";
import { BusinessOsMobilePairingSection } from "../settings/BusinessOsMobilePairingSection";

const SETTINGS_PAGE_KEY = "workjet.business-os.settings.last-page";
const SETTINGS_PAGES = [
  ["general", "Allgemein"],
  ["backends", "Backends & Sync"],
  ["apps", "Apps"],
  ["updates", "Updates"],
  ["appearance", "Darstellung"],
  ["notifications", "Benachrichtigungen"],
  ["diagnostics", "Diagnostik"],
  ["about", "Über"],
] as const;
type SettingsPage = (typeof SETTINGS_PAGES)[number][0];

function initialPage(): SettingsPage {
  if (typeof window === "undefined") return "general";
  const stored = window.localStorage.getItem(SETTINGS_PAGE_KEY);
  return SETTINGS_PAGES.some(([id]) => id === stored) ? (stored as SettingsPage) : "general";
}

const PHASE_LABELS: Readonly<Record<string, string>> = {
  current: "Aktuell",
  checking: "Prüfung läuft",
  available: "Update verfügbar",
  download: "Download",
  verify: "Verifikation",
  ready: "Bereit zur Aktivierung",
  restart: "Neustart erforderlich",
  failed: "Fehlgeschlagen",
  incompatible: "Inkompatibel",
  blocked: "Blockiert",
  rollback: "Rollback aktiv",
  recovery: "Recovery-Shell",
};

const BLOCKER_LABELS: Readonly<Record<NonNullable<CtoxShellFleetRow["blocker"]>, string>> = {
  offline: "Offline",
  no_administrative_access: "Kein administrativer Zugriff",
  backend_unavailable: "Backend nicht erreichbar",
  data_plane_degraded: "Sync beeinträchtigt",
  incompatible: "Inkompatibel",
  paused: "Pausiert",
  unknown_instance: "Unbekannte Instanz",
};

function fleetHealthLabel(row: CtoxShellFleetRow): string {
  if (!row.reachable || row.blocker === "offline") return "offline";
  if (row.blocker === "data_plane_degraded") return "degraded";
  if (row.blocker === "backend_unavailable") return "unavailable";
  return row.shell.health;
}

export function businessOsInstanceDataPlaneReady(
  instance: { readonly id: string; readonly healthSummary: { readonly dataPlaneReady: boolean } },
  readyInstanceId: string | null,
): boolean {
  return instance.healthSummary.dataPlaneReady || instance.id === readyInstanceId;
}

function FleetStatus({ row }: { readonly row: CtoxShellFleetRow }) {
  const label = row.blocker === null ? PHASE_LABELS[row.shell.phase] : BLOCKER_LABELS[row.blocker];
  const color =
    row.blocker === "paused"
      ? "text-amber-500"
      : row.blocker !== null || row.shell.phase === "failed"
        ? "text-destructive"
        : row.shell.phase === "current"
          ? "text-emerald-500"
          : "text-amber-500";
  return (
    <div className="min-w-40">
      <p className={cn("font-medium", color)}>{label ?? row.shell.phase}</p>
      {row.requiredOperatorStep === null ? null : (
        <p className="mt-0.5 max-w-72 text-[11px] leading-4 text-muted-foreground">
          {row.requiredOperatorStep}
        </p>
      )}
      {row.shell.pause === null ? null : (
        <p className="mt-0.5 max-w-72 text-[11px] leading-4 text-muted-foreground">
          {row.shell.pause.reason} · bis {new Date(row.shell.pause.expiresAt).toLocaleString()}
        </p>
      )}
    </div>
  );
}

function UpdatesPage({
  bridge,
  inventory,
  loading,
  reload,
  rolloutStatus,
  setRolloutStatus,
}: {
  readonly bridge: DesktopCtoxBridge | undefined;
  readonly inventory: CtoxShellFleetInventoryResult | null;
  readonly loading: boolean;
  readonly reload: () => void;
  readonly rolloutStatus: CtoxShellFleetRolloutStatus | null;
  readonly setRolloutStatus: (status: CtoxShellFleetRolloutStatus) => void;
}) {
  const [runningId, setRunningId] = useState<string | null>(null);
  const rows = inventory?._tag === "completed" ? inventory.rows : [];
  const run = (row: CtoxShellFleetRow, action: "check" | "update" | "rollback") => {
    if (bridge?.runShellFleetAction === undefined) return;
    setRunningId(row.instanceId);
    void bridge.runShellFleetAction({ instanceId: row.instanceId, action }).finally(() => {
      setRunningId(null);
      reload();
    });
  };
  const checkAll = () => {
    if (bridge?.runShellFleetAction === undefined) return;
    const eligible = rows.filter(
      (row) => row.reachable && row.shell.administrable && row.blocker !== "paused",
    );
    setRunningId("*");
    void Promise.allSettled(
      eligible.map((row) =>
        bridge.runShellFleetAction!({ instanceId: row.instanceId, action: "check" }),
      ),
    ).finally(() => {
      setRunningId(null);
      reload();
    });
  };
  const startRollout = () => {
    if (bridge?.startShellFleetRollout === undefined) return;
    setRunningId("rollout");
    void bridge
      .startShellFleetRollout()
      .then((result) => {
        if (result._tag === "started" || result._tag === "already_running") {
          setRolloutStatus(result.status);
        }
      })
      .finally(() => {
        setRunningId(null);
        reload();
      });
  };
  const togglePause = (row: CtoxShellFleetRow) => {
    const operation =
      row.blocker === "paused"
        ? bridge?.resumeShellFleetInstance?.(row.instanceId)
        : bridge?.pauseShellFleetInstance?.({
            instanceId: row.instanceId,
            reason: "Manuell in Workjet pausiert",
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
          });
    if (operation === undefined) return;
    setRunningId(row.instanceId);
    void operation.finally(() => {
      setRunningId(null);
      reload();
    });
  };

  return (
    <section aria-labelledby="business-os-updates-title">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 id="business-os-updates-title" className="text-xl font-semibold">
            Shell-Updates
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Backend- und Shell-Versionen bleiben getrennt. Blockierte Instanzen zählen nicht als
            aktuell.
          </p>
          {rolloutStatus !== null && rolloutStatus.phase !== "idle" ? (
            <p
              className="mt-2 text-xs text-muted-foreground"
              data-shell-rollout-phase={rolloutStatus.phase}
            >
              Fleet-Rollout: {rolloutStatus.phase} · Welle {rolloutStatus.currentWave}/
              {rolloutStatus.totalWaves} · {rolloutStatus.completedInstanceIds.length}/
              {rolloutStatus.instanceIds.length} Instanzen abgeschlossen
            </p>
          ) : null}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
            onClick={reload}
            disabled={loading}
          >
            <RefreshCw className={cn("mr-2 inline size-3.5", loading && "animate-spin")} />
            Inventar
          </button>
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
            onClick={checkAll}
            disabled={runningId !== null || rows.length === 0}
          >
            Alle prüfen
          </button>
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
            onClick={startRollout}
            disabled={
              runningId !== null ||
              rows.length === 0 ||
              bridge?.startShellFleetRollout === undefined
            }
          >
            Geeignete aktualisieren
          </button>
        </div>
      </div>

      {inventory?._tag === "failed" ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          Das Fleet-Inventar konnte nicht gelesen werden.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[880px] text-left text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Instanz</th>
                <th className="px-4 py-3 font-medium">Health</th>
                <th className="px-4 py-3 font-medium">CTOX</th>
                <th className="px-4 py-3 font-medium">Shell</th>
                <th className="px-4 py-3 font-medium">Kanal</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Aktionen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.instanceId} data-shell-fleet-instance={row.instanceId}>
                  <td className="px-4 py-3">
                    <p className="font-medium">{row.displayName}</p>
                    <p className="text-xs text-muted-foreground">{row.source}</p>
                  </td>
                  <td className="px-4 py-3">{fleetHealthLabel(row)}</td>
                  <td className="px-4 py-3 tabular-nums">{row.backendVersion ?? "Unbekannt"}</td>
                  <td className="px-4 py-3 tabular-nums">
                    {row.shell.recoveryShell ? "Recovery" : `v${row.shell.activeVersion ?? "?"}`}
                    {row.shell.latestCompatibleVersion === null ? null : (
                      <p className="text-xs text-muted-foreground">
                        Angebot v{row.shell.latestCompatibleVersion}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3">{row.shell.channel}</td>
                  <td className="px-4 py-3">
                    <FleetStatus row={row} />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        className="rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40"
                        disabled={row.blocker !== null || runningId !== null}
                        onClick={() => run(row, "check")}
                      >
                        Prüfen
                      </button>
                      <button
                        type="button"
                        className="rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40"
                        disabled={row.blocker !== null || runningId !== null}
                        onClick={() => run(row, "update")}
                      >
                        Aktualisieren
                      </button>
                      <button
                        type="button"
                        className="rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40"
                        disabled={
                          !row.shell.administrable ||
                          row.shell.activeVersion === null ||
                          runningId !== null
                        }
                        onClick={() => run(row, "rollback")}
                      >
                        Rollback
                      </button>
                      <button
                        type="button"
                        className="rounded border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-40"
                        disabled={runningId !== null}
                        onClick={() => togglePause(row)}
                      >
                        {row.blocker === "paused" ? "Fortsetzen" : "24 h pausieren"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                    {loading ? "Fleet wird geprüft…" : "Keine CTOX-Instanzen registriert."}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function BusinessOsSettingsDialog({
  bridge,
  discovery,
  selectedId,
  readyInstanceId = null,
  onClose,
}: {
  readonly bridge: DesktopCtoxBridge | undefined;
  readonly discovery: "loading" | CtoxDiscoveryResult;
  readonly selectedId: string | null;
  /** The selected native guest has completed its authenticated WebRTC launch. */
  readonly readyInstanceId?: string | null;
  readonly onClose: () => void;
}) {
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const [inventory, setInventory] = useState<CtoxShellFleetInventoryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [rolloutStatus, setRolloutStatus] = useState<CtoxShellFleetRolloutStatus | null>(null);
  const primaryEnvironment = usePrimaryEnvironment();
  const selected = useMemo(
    () =>
      discovery !== "loading" && discovery._tag === "ready"
        ? discovery.instances.find((instance) => instance.id === selectedId)
        : undefined,
    [discovery, selectedId],
  );
  const reload = useCallback(() => {
    if (bridge?.getShellFleetInventory === undefined) {
      setInventory({ _tag: "failed", code: "inventory_failed" });
      return;
    }
    setLoading(true);
    void bridge
      .getShellFleetInventory()
      .then(setInventory, () => setInventory({ _tag: "failed", code: "inventory_failed" }))
      .finally(() => setLoading(false));
  }, [bridge]);
  useEffect(reload, [reload]);
  useEffect(() => {
    if (bridge?.getShellFleetRolloutStatus !== undefined) {
      void bridge.getShellFleetRolloutStatus().then(setRolloutStatus, () => undefined);
    }
    return bridge?.onShellFleetRolloutStatus?.(setRolloutStatus);
  }, [bridge]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const choosePage = (next: SettingsPage) => {
    setPage(next);
    window.localStorage.setItem(SETTINGS_PAGE_KEY, next);
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex bg-background"
      role="dialog"
      aria-modal="true"
      aria-label="Business OS settings"
      data-business-os-settings=""
    >
      <aside className="w-64 shrink-0 border-r border-border bg-sidebar px-3 py-5">
        <div className="mb-5 flex items-center justify-between px-2">
          <div>
            <p className="font-semibold text-sidebar-foreground">Business OS</p>
            <p className="text-xs text-sidebar-muted-foreground">Einstellungen</p>
          </div>
          <button
            type="button"
            className="rounded p-1.5 text-sidebar-muted-foreground hover:bg-sidebar-accent"
            onClick={onClose}
            aria-label="Einstellungen schließen"
          >
            <X className="size-4" />
          </button>
        </div>
        <nav aria-label="Business OS settings categories" className="space-y-1">
          {SETTINGS_PAGES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={cn(
                "w-full rounded-md px-3 py-2 text-left text-sm",
                page === id
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-sidebar-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
              )}
              onClick={() => choosePage(id)}
              aria-current={page === id ? "page" : undefined}
            >
              {label}
            </button>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto p-8 lg:p-12">
        {page === "updates" ? (
          <UpdatesPage
            bridge={bridge}
            inventory={inventory}
            loading={loading}
            reload={reload}
            rolloutStatus={rolloutStatus}
            setRolloutStatus={setRolloutStatus}
          />
        ) : (
          <section className="mx-auto max-w-3xl">
            <h2 className="text-xl font-semibold">
              {SETTINGS_PAGES.find(([id]) => id === page)?.[1]}
            </h2>
            {page === "general" ? (
              <div className="mt-6 rounded-lg border border-border p-5">
                <p className="text-sm font-medium">Aktives Backend</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {selected?.displayName ?? "Keine CTOX-Instanz ausgewählt"}
                </p>
              </div>
            ) : null}
            {page === "backends" ? (
              <div className="mt-6 space-y-3">
                {(discovery !== "loading" && discovery._tag === "ready"
                  ? discovery.instances
                  : []
                ).map((instance) => (
                  <div key={instance.id} className="rounded-lg border border-border p-4">
                    <div className="flex items-center justify-between gap-4">
                      <p className="font-medium">{instance.displayName}</p>
                      <span className="text-xs text-muted-foreground">{instance.status}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      RxDB/WebRTC ·{" "}
                      {businessOsInstanceDataPlaneReady(instance, readyInstanceId)
                        ? "bereit"
                        : "nicht bestätigt"}
                    </p>
                  </div>
                ))}
                <BusinessOsMobilePairingSection
                  environmentId={primaryEnvironment?.environmentId ?? null}
                  environmentLabel={selected?.displayName ?? primaryEnvironment?.label ?? null}
                />
              </div>
            ) : null}
            {page === "apps" ? (
              <p className="mt-4 text-sm text-muted-foreground">
                Apps werden pro ausgewählter CTOX-Instanz verwaltet und bleiben von Coding-Harnesses
                getrennt.
              </p>
            ) : null}
            {page === "appearance" ? (
              <p className="mt-4 text-sm text-muted-foreground">
                Business OS übernimmt das Workjet-Erscheinungsbild. Eine zweite
                Desktop-Theme-Schicht existiert nicht.
              </p>
            ) : null}
            {page === "notifications" ? (
              <p className="mt-4 text-sm text-muted-foreground">
                Benachrichtigungen werden pro Workjet-Profil und CTOX-Instanz angezeigt.
              </p>
            ) : null}
            {page === "diagnostics" ? (
              <div className="mt-6 rounded-lg border border-border p-5 text-sm">
                <p>Instanz: {selected?.displayName ?? "Keine"}</p>
                <p className="mt-1 text-muted-foreground">
                  Datenpfad: {selected?.healthSummary.dataPlane ?? "unbekannt"}
                </p>
              </div>
            ) : null}
            {page === "about" ? (
              <div className="mt-6 rounded-lg border border-border p-5 text-sm">
                <p className="font-medium">Workjet</p>
                <p className="mt-1 text-muted-foreground">
                  CTOX ist das Backend. Workjet ist die einzige Desktop- und Mobile-Nutzer-App.
                </p>
              </div>
            ) : null}
          </section>
        )}
      </main>
    </div>
  );
}
