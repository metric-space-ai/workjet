// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type {
  CtoxDiscoveryResult,
  CtoxShellFleetInventoryResult,
  CtoxShellFleetRow,
  CtoxShellFleetRolloutStatus,
  DesktopCtoxBridge,
} from "@t3tools/contracts";
import { RefreshCw, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { APP_VERSION } from "../../branding";
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

export function fleetInstanceDisplayTitle(displayName: string): string {
  const normalized = displayName.trim();
  if (!/^biz_[a-z0-9-]+$/i.test(normalized)) return normalized;
  const shortId = normalized.slice(4).split("-")[0]?.slice(0, 8) || normalized.slice(4, 12);
  return `Paired backend · ${shortId}`;
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
      {row.shell.errorCode === null ? null : (
        <p className="mt-0.5 max-w-72 text-[11px] leading-4 text-destructive">
          Fehler: {row.shell.errorCode}
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
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [pauseTarget, setPauseTarget] = useState<CtoxShellFleetRow | null>(null);
  const [pauseReason, setPauseReason] = useState("Geplante Wartung");
  const [pauseHours, setPauseHours] = useState("24");
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
  const resumeInstance = (row: CtoxShellFleetRow) => {
    const operation = bridge?.resumeShellFleetInstance?.(row.instanceId);
    if (operation === undefined) return;
    setRunningId(row.instanceId);
    void operation.finally(() => {
      setRunningId(null);
      reload();
    });
  };
  const commitPause = () => {
    if (pauseTarget === null || bridge?.pauseShellFleetInstance === undefined) return;
    const hours = Number.parseInt(pauseHours, 10);
    if (!Number.isInteger(hours) || hours < 1 || hours > 720 || pauseReason.trim().length === 0)
      return;
    setRunningId(pauseTarget.instanceId);
    void bridge
      .pauseShellFleetInstance({
        instanceId: pauseTarget.instanceId,
        reason: pauseReason.trim().slice(0, 256),
        expiresAt: new Date(Date.now() + hours * 60 * 60 * 1_000).toISOString(),
      })
      .finally(() => {
        setRunningId(null);
        setPauseTarget(null);
        reload();
      });
  };
  const resumeRelease = () => {
    if (bridge?.resumeShellFleetRollout === undefined) return;
    setRunningId("rollout-resume");
    void bridge
      .resumeShellFleetRollout()
      .then(setRolloutStatus)
      .finally(() => setRunningId(null));
  };

  return (
    <section
      aria-labelledby="business-os-updates-title"
      className={rows.length === 0 ? "mx-auto max-w-3xl" : undefined}
    >
      <div className="mb-6 flex flex-col items-start justify-between gap-4 xl:flex-row">
        <div>
          <h2 id="business-os-updates-title" className="text-xl font-semibold">
            Shell-Updates
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Backend- und Shell-Versionen bleiben getrennt. Blockierte Instanzen zählen nicht als
            aktuell.
          </p>
          {rolloutStatus !== null &&
          rolloutStatus.phase !== "idle" &&
          rolloutStatus.instanceIds.length > 0 ? (
            <p
              className="mt-2 text-xs text-muted-foreground"
              data-shell-rollout-phase={rolloutStatus.phase}
            >
              Fleet-Rollout: {rolloutStatus.phase} · Welle {rolloutStatus.currentWave}/
              {rolloutStatus.totalWaves} · {rolloutStatus.completedInstanceIds.length}/
              {rolloutStatus.instanceIds.length} Instanzen abgeschlossen
            </p>
          ) : null}
          {rolloutStatus?.pauseReason == null ? null : (
            <div className="mt-2 flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-600">
              <span>
                Release pausiert: {rolloutStatus.pauseReason}
                {rolloutStatus.pausedAt === null
                  ? ""
                  : ` · seit ${new Date(rolloutStatus.pausedAt).toLocaleString()}`}
              </span>
              <button
                type="button"
                className="rounded border border-amber-500/40 px-2 py-1 font-medium hover:bg-amber-500/10"
                onClick={resumeRelease}
                disabled={runningId !== null}
              >
                Release wieder freigeben
              </button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:bg-muted/30 disabled:text-muted-foreground disabled:opacity-70"
            onClick={reload}
            disabled={loading}
          >
            <RefreshCw className={cn("mr-2 inline size-3.5", loading && "animate-spin")} />
            Inventar
          </button>
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:opacity-70"
            onClick={checkAll}
            disabled={runningId !== null || rows.length === 0}
          >
            Alle prüfen
          </button>
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:opacity-70"
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

      {pauseTarget === null ? null : (
        <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-muted/20 p-4">
          <label className="min-w-64 flex-1 text-xs text-muted-foreground">
            Pausegrund für {pauseTarget.displayName}
            <input
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
              value={pauseReason}
              maxLength={256}
              onChange={(event) => setPauseReason(event.target.value)}
            />
          </label>
          <label className="w-28 text-xs text-muted-foreground">
            Dauer (Stunden)
            <input
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
              type="number"
              min={1}
              max={720}
              value={pauseHours}
              onChange={(event) => setPauseHours(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
            onClick={commitPause}
          >
            Pause speichern
          </button>
          <button
            type="button"
            className="rounded-md border border-border px-3 py-2 text-sm"
            onClick={() => setPauseTarget(null)}
          >
            Abbrechen
          </button>
        </div>
      )}

      {inventory?._tag === "failed" ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          Das Fleet-Inventar konnte nicht gelesen werden.
        </p>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-muted/10 px-5 py-8 text-center">
          <p className="font-medium">
            {loading ? "Fleet wird geprüft…" : "Keine CTOX-Instanzen registriert"}
          </p>
          <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
            {loading
              ? "Erreichbarkeit, Versionen und Updatefähigkeit werden geladen."
              : "Verbinde zuerst mindestens ein Backend unter Backends & Sync. Danach erscheinen kompatible Shell-Updates hier."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[1180px] text-left text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Instanz</th>
                <th className="px-4 py-3 font-medium">Erreichbarkeit</th>
                <th className="px-4 py-3 font-medium">Health</th>
                <th className="px-4 py-3 font-medium">Plattform</th>
                <th className="px-4 py-3 font-medium">Admin</th>
                <th className="px-4 py-3 font-medium">CTOX</th>
                <th className="px-4 py-3 font-medium">Shell</th>
                <th className="px-4 py-3 font-medium">Kanal</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Letzte Prüfung</th>
                <th className="px-4 py-3 font-medium">Aktionen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <Fragment key={row.instanceId}>
                  <tr data-shell-fleet-instance={row.instanceId}>
                    <td className="px-4 py-3">
                      <p className="font-medium">{fleetInstanceDisplayTitle(row.displayName)}</p>
                      <p className="text-xs text-muted-foreground">{row.source}</p>
                    </td>
                    <td className="px-4 py-3">{row.reachable ? "Erreichbar" : "Offline"}</td>
                    <td className="px-4 py-3">{fleetHealthLabel(row)}</td>
                    <td className="px-4 py-3 text-xs">
                      {row.platform} · {row.architecture}
                    </td>
                    <td className="px-4 py-3 text-xs">{row.administrativeAccess}</td>
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
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {row.shell.lastCheckedAt === null
                        ? "Nie"
                        : new Date(row.shell.lastCheckedAt).toLocaleString()}
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
                          {row.shell.phase === "failed" ? "Erneut versuchen" : "Aktualisieren"}
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
                          onClick={() =>
                            row.blocker === "paused" ? resumeInstance(row) : setPauseTarget(row)
                          }
                        >
                          {row.blocker === "paused" ? "Fortsetzen" : "Pausieren"}
                        </button>
                        <button
                          type="button"
                          className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
                          onClick={() =>
                            setDetailsId(detailsId === row.instanceId ? null : row.instanceId)
                          }
                        >
                          Details
                        </button>
                      </div>
                    </td>
                  </tr>
                  {detailsId === row.instanceId ? (
                    <tr>
                      <td
                        colSpan={11}
                        className="bg-muted/15 px-4 py-3 text-xs text-muted-foreground"
                      >
                        <div className="grid gap-2 md:grid-cols-3">
                          <span>Aktiv: {row.shell.activeVersion ?? "Recovery-Shell"}</span>
                          <span>Gewünscht: {row.shell.desiredVersion ?? "–"}</span>
                          <span>Angebot: {row.shell.latestCompatibleVersion ?? "–"}</span>
                          <span>Phase: {row.shell.phase}</span>
                          <span>Fehler: {row.shell.errorCode ?? row.blocker ?? "–"}</span>
                          <span>Operator-Schritt: {row.requiredOperatorStep ?? "Keiner"}</span>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
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
                  ? "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-inset ring-sidebar-border"
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
                {selected === undefined ? (
                  <button
                    type="button"
                    className="mt-4 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
                    onClick={() => choosePage("backends")}
                  >
                    Backend auswählen
                  </button>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">
                    RxDB/WebRTC ·{" "}
                    {businessOsInstanceDataPlaneReady(selected, readyInstanceId)
                      ? "bereit"
                      : "nicht bestätigt"}
                  </p>
                )}
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
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {instance.status === "pairing_expired"
                          ? "Pairing abgelaufen"
                          : instance.status === "available"
                            ? "Verfügbar"
                            : instance.status}
                      </span>
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
              <div className="mt-6 rounded-lg border border-border p-5">
                <p className="text-sm font-medium">
                  {selected === undefined
                    ? "Kein Backend ausgewählt"
                    : `Aktives Backend: ${selected.displayName}`}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Apps werden pro CTOX-Instanz verwaltet und bleiben von Coding-Harnesses getrennt.
                </p>
                {selected === undefined ? (
                  <button
                    type="button"
                    className="mt-4 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
                    onClick={() => choosePage("backends")}
                  >
                    Backends & Sync öffnen
                  </button>
                ) : null}
              </div>
            ) : null}
            {page === "appearance" ? (
              <div className="mt-6 rounded-lg border border-border p-5">
                <p className="text-sm font-medium">Workjet-Darstellung aktiv</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Business OS übernimmt Theme, Kontrast und Schrift aus Workjet. Es existiert keine
                  abweichende Desktop-Theme-Schicht.
                </p>
              </div>
            ) : null}
            {page === "notifications" ? (
              <div className="mt-6 rounded-lg border border-border p-5">
                <p className="text-sm font-medium">Profilstandard aktiv</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Benachrichtigungen gelten für dieses Workjet-Profil und das jeweils aktive
                  CTOX-Backend.
                </p>
                <p className="mt-3 text-xs text-muted-foreground">
                  Aktives Backend: {selected?.displayName ?? "Keines ausgewählt"}
                </p>
              </div>
            ) : null}
            {page === "diagnostics" ? (
              <div className="mt-6 rounded-lg border border-border p-5 text-sm">
                <p>Instanz: {selected?.displayName ?? "Keine"}</p>
                <p className="mt-1 text-muted-foreground">
                  Datenpfad: {selected?.healthSummary.dataPlane ?? "unbekannt"}
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
                    onClick={reload}
                  >
                    Erneut prüfen
                  </button>
                  {selected === undefined ? (
                    <button
                      type="button"
                      className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground"
                      onClick={() => choosePage("backends")}
                    >
                      Backend verbinden
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
            {page === "about" ? (
              <div className="mt-6 rounded-lg border border-border p-5 text-sm">
                <p className="font-medium">Workjet</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">
                  Version {APP_VERSION}
                </p>
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
