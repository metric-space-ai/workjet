// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type {
  CtoxDiscoveryResult,
  CtoxShellFleetInventoryResult,
  CtoxShellFleetRow,
  CtoxShellFleetRolloutStatus,
  DesktopCtoxBridge,
} from "@t3tools/contracts";
import { RefreshCw, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { APP_VERSION } from "../../branding";
import { usePrimaryEnvironment } from "../../state/environments";
import { BusinessOsMobilePairingSection } from "../settings/BusinessOsMobilePairingSection";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

const SETTINGS_PAGE_KEY = "workjet.business-os.settings.last-page";
const SETTINGS_PAGES = [
  ["general", "Allgemein"],
  ["backends", "Backends & Synchronisierung"],
  ["apps", "Apps"],
  ["updates", "Updates"],
  ["appearance", "Darstellung"],
  ["notifications", "Benachrichtigungen"],
  ["diagnostics", "Diagnostik"],
  ["about", "Über"],
] as const;

function businessOsSettingsReturnFocus(): HTMLElement | null {
  const settingsTrigger = document.querySelector<HTMLElement>(
    "[data-business-os-settings-trigger]",
  );
  if (settingsTrigger !== null) {
    const rect = settingsTrigger.getBoundingClientRect();
    if (rect.width > 1 && rect.height > 1 && rect.right > 0 && rect.left < window.innerWidth) {
      return settingsTrigger;
    }
  }
  return document.querySelector<HTMLElement>('button[aria-label="Toggle main sidebar"]');
}
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
  recovery: "Wiederherstellung",
};

const BLOCKER_LABELS: Readonly<Record<NonNullable<CtoxShellFleetRow["blocker"]>, string>> = {
  offline: "Offline",
  no_administrative_access: "Kein administrativer Zugriff",
  backend_unavailable: "Backend nicht erreichbar",
  data_plane_degraded: "Synchronisierung beeinträchtigt",
  incompatible: "Inkompatibel",
  paused: "Pausiert",
  unknown_instance: "Unbekannte Instanz",
};

const INSTANCE_STATUS_LABELS: Readonly<Record<string, string>> = {
  available: "Verfügbar",
  offline: "Offline",
  needs_auth: "Anmeldung erforderlich",
  pairing_expired: "Verbindung abgelaufen",
  paired: "Verbunden",
  installing: "Wird eingerichtet",
  error: "Fehler",
};

const FLEET_SOURCE_LABELS: Readonly<Record<string, string>> = {
  ctox_dev: "CTOX Backend",
  pairing_invite: "Desktop-Einladung",
  manual_pairing: "Manuell verbunden",
  local_daemon: "Lokales Backend",
  ssh_managed: "SSH-Backend",
};

const FLEET_HEALTH_LABELS: Readonly<Record<string, string>> = {
  healthy: "Bereit",
  degraded: "Beeinträchtigt",
  unavailable: "Nicht verfügbar",
  offline: "Offline",
  unknown: "Unbekannt",
};

const ADMIN_ACCESS_LABELS: Readonly<Record<string, string>> = {
  available: "Verfügbar",
  authentication_required: "Anmeldung erforderlich",
  unavailable: "Nicht verfügbar",
  unknown: "Unbekannt",
};

const CHANNEL_LABELS: Readonly<Record<string, string>> = {
  stable: "Stabil",
  beta: "Beta",
  canary: "Canary",
};

const ROLLOUT_PHASE_LABELS: Readonly<Record<string, string>> = {
  inventory: "Inventar",
  local_canary: "Lokaler Test",
  platform_canary: "Plattform-Test",
  wave: "Welle",
  observing: "Beobachtung",
  completed: "Abgeschlossen",
  paused: "Pausiert",
  failed: "Fehlgeschlagen",
};

function fleetSourceLabel(source: string): string {
  return FLEET_SOURCE_LABELS[source] ?? source;
}

function fleetHealthDisplayLabel(health: string): string {
  return FLEET_HEALTH_LABELS[health] ?? health;
}

function administrativeAccessLabel(access: string): string {
  return ADMIN_ACCESS_LABELS[access] ?? access;
}

function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

function rolloutPhaseLabel(phase: string): string {
  return ROLLOUT_PHASE_LABELS[phase] ?? phase;
}

function fleetHealthLabel(row: CtoxShellFleetRow): string {
  if (!row.reachable || row.blocker === "offline") return "Offline";
  if (row.blocker === "data_plane_degraded") return "Beeinträchtigt";
  if (row.blocker === "backend_unavailable") return "Nicht verfügbar";
  return fleetHealthDisplayLabel(row.shell.health);
}

export function fleetInstanceDisplayTitle(displayName: string): string {
  const normalized = displayName.trim();
  if (!/^biz_[a-z0-9-]+$/i.test(normalized)) return normalized;
  const shortId = normalized.slice(4).split("-")[0]?.slice(0, 8) || normalized.slice(4, 12);
  return `CTOX Backend · ${shortId}`;
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
            Business OS-Updates
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Versionen des CTOX Backends und der Business-OS-Oberfläche werden getrennt verwaltet.
            Blockierte Backends zählen nicht als aktuell.
          </p>
          {rolloutStatus !== null &&
          rolloutStatus.phase !== "idle" &&
          rolloutStatus.instanceIds.length > 0 ? (
            <p
              className="mt-2 text-xs text-muted-foreground"
              data-shell-rollout-phase={rolloutStatus.phase}
            >
              Backend-Rollout: {rolloutPhaseLabel(rolloutStatus.phase)} · Welle{" "}
              {rolloutStatus.currentWave}/{rolloutStatus.totalWaves} ·{" "}
              {rolloutStatus.completedInstanceIds.length}/{rolloutStatus.instanceIds.length}{" "}
              Instanzen abgeschlossen
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
            Pausegrund für {fleetInstanceDisplayTitle(pauseTarget.displayName)}
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
          Das Backend-Inventar konnte nicht gelesen werden.
        </p>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-border bg-muted/10 px-5 py-8 text-center">
          <p className="font-medium">
            {loading ? "Backends werden geprüft…" : "Keine CTOX Backends registriert"}
          </p>
          <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
            {loading
              ? "Erreichbarkeit, Versionen und Updatefähigkeit werden geladen."
              : "Verbinde zuerst mindestens ein Backend unter Backends & Synchronisierung. Danach erscheinen kompatible Business OS-Updates hier."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[1180px] text-left text-sm">
            <thead className="bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Backend</th>
                <th className="px-4 py-3 font-medium">Erreichbarkeit</th>
                <th className="px-4 py-3 font-medium">Zustand</th>
                <th className="px-4 py-3 font-medium">Plattform</th>
                <th className="px-4 py-3 font-medium">Zugriff</th>
                <th className="px-4 py-3 font-medium">CTOX Backend</th>
                <th className="px-4 py-3 font-medium">Business OS</th>
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
                      <p className="text-xs text-muted-foreground">
                        {fleetSourceLabel(row.source)}
                      </p>
                    </td>
                    <td className="px-4 py-3">{row.reachable ? "Erreichbar" : "Offline"}</td>
                    <td className="px-4 py-3">{fleetHealthLabel(row)}</td>
                    <td className="px-4 py-3 text-xs">
                      {row.platform} · {row.architecture}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {administrativeAccessLabel(row.administrativeAccess)}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{row.backendVersion ?? "Unbekannt"}</td>
                    <td className="px-4 py-3 tabular-nums">
                      {row.shell.recoveryShell
                        ? "Wiederherstellung"
                        : `v${row.shell.activeVersion ?? "?"}`}
                      {row.shell.latestCompatibleVersion === null ? null : (
                        <p className="text-xs text-muted-foreground">
                          Angebot v{row.shell.latestCompatibleVersion}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">{channelLabel(row.shell.channel)}</td>
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
                          <span>Aktiv: {row.shell.activeVersion ?? "Wiederherstellung"}</span>
                          <span>Gewünscht: {row.shell.desiredVersion ?? "–"}</span>
                          <span>Angebot: {row.shell.latestCompatibleVersion ?? "–"}</span>
                          <span>Phase: {PHASE_LABELS[row.shell.phase] ?? row.shell.phase}</span>
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
  const activePageButtonRef = useRef<HTMLButtonElement | null>(null);
  const pageNavigationRef = useRef<HTMLElement | null>(null);
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
  const keepPageButtonVisible = useCallback((button: HTMLButtonElement | null) => {
    const navigation = pageNavigationRef.current;
    if (
      navigation === null ||
      button === null ||
      navigation.scrollWidth <= navigation.clientWidth
    ) {
      return;
    }
    const centeredLeft = button.offsetLeft - (navigation.clientWidth - button.offsetWidth) / 2;
    navigation.scrollTo({ left: Math.max(0, centeredLeft), behavior: "auto" });
  }, []);
  const choosePage = (next: SettingsPage, button?: HTMLButtonElement) => {
    setPage(next);
    window.localStorage.setItem(SETTINGS_PAGE_KEY, next);
    keepPageButtonVisible(button ?? null);
  };

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      keepPageButtonVisible(activePageButtonRef.current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [keepPageButtonVisible, page]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup
        className="row-start-1 row-span-3 flex h-dvh max-h-none w-dvw max-w-none min-w-0 flex-col overflow-hidden rounded-none border-0 bg-background p-0 shadow-none md:flex-row"
        viewportClassName="z-[90] grid-rows-1 p-0"
        bottomStickOnMobile={false}
        showCloseButton={false}
        aria-label="Business OS-Einstellungen"
        aria-modal="true"
        finalFocus={businessOsSettingsReturnFocus}
        data-business-os-settings=""
      >
        <DialogTitle className="sr-only">Business OS-Einstellungen</DialogTitle>
        <aside className="max-h-[45dvh] w-full shrink-0 overflow-y-auto border-b border-border bg-sidebar px-3 py-3 md:max-h-none md:h-full md:w-64 md:border-r md:border-b-0 md:py-5">
          <div className="mb-3 flex items-center justify-between px-2 md:mb-5">
            <div>
              <p className="font-semibold text-sidebar-foreground">Business OS</p>
              <p className="text-xs text-sidebar-muted-foreground">Einstellungen</p>
            </div>
            <button
              type="button"
              className="rounded p-1.5 text-sidebar-muted-foreground hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
              onClick={onClose}
              aria-label="Einstellungen schließen"
              autoFocus
            >
              <X className="size-4" />
            </button>
          </div>
          <nav
            ref={pageNavigationRef}
            aria-label="Kategorien für Business OS-Einstellungen"
            className="flex gap-1 overflow-x-auto pb-1 md:block md:space-y-1 md:overflow-visible md:pb-0"
          >
            {SETTINGS_PAGES.map(([id, label]) => (
              <button
                key={id}
                ref={page === id ? activePageButtonRef : undefined}
                type="button"
                className={cn(
                  "shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm md:w-full",
                  page === id
                    ? "bg-sidebar-accent text-sidebar-accent-foreground ring-1 ring-inset ring-sidebar-border"
                    : "text-sidebar-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                )}
                onClick={(event) => choosePage(id, event.currentTarget)}
                aria-current={page === id ? "page" : undefined}
              >
                {label}
              </button>
            ))}
          </nav>
        </aside>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6 md:p-8 lg:p-12">
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
                    {selected === undefined
                      ? "Kein CTOX Backend ausgewählt"
                      : fleetInstanceDisplayTitle(selected.displayName)}
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
                      Synchronisierung ·{" "}
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
                        <p className="font-medium">
                          {fleetInstanceDisplayTitle(instance.displayName)}
                        </p>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          {INSTANCE_STATUS_LABELS[instance.status] ?? instance.status}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Synchronisierung ·{" "}
                        {businessOsInstanceDataPlaneReady(instance, readyInstanceId)
                          ? "bereit"
                          : "nicht bestätigt"}
                      </p>
                    </div>
                  ))}
                  <BusinessOsMobilePairingSection
                    environmentId={primaryEnvironment?.environmentId ?? null}
                    environmentLabel={
                      selected === undefined
                        ? (primaryEnvironment?.label ?? null)
                        : fleetInstanceDisplayTitle(selected.displayName)
                    }
                  />
                </div>
              ) : null}
              {page === "apps" ? (
                <div className="mt-6 rounded-lg border border-border p-5">
                  <p className="text-sm font-medium">
                    {selected === undefined
                      ? "Kein Backend ausgewählt"
                      : `Aktives Backend: ${fleetInstanceDisplayTitle(selected.displayName)}`}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Apps werden pro CTOX Backend verwaltet und bleiben von Coding-Prozessen
                    getrennt.
                  </p>
                  {selected === undefined ? (
                    <button
                      type="button"
                      className="mt-4 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
                      onClick={() => choosePage("backends")}
                    >
                      Backends & Synchronisierung öffnen
                    </button>
                  ) : null}
                </div>
              ) : null}
              {page === "appearance" ? (
                <div className="mt-6 rounded-lg border border-border p-5">
                  <p className="text-sm font-medium">Workjet-Darstellung aktiv</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Business OS übernimmt Darstellung, Kontrast und Schrift aus Workjet. Es
                    existiert keine abweichende Desktop-Darstellung.
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
                    Aktives Backend:{" "}
                    {selected === undefined
                      ? "Kein Backend ausgewählt"
                      : fleetInstanceDisplayTitle(selected.displayName)}
                  </p>
                </div>
              ) : null}
              {page === "diagnostics" ? (
                <div className="mt-6 rounded-lg border border-border p-5 text-sm">
                  <p>
                    Instanz:{" "}
                    {selected === undefined
                      ? "Kein Backend ausgewählt"
                      : fleetInstanceDisplayTitle(selected.displayName)}
                  </p>
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
                    Das CTOX Backend verbindet Business OS mit Workjet. Workjet ist die einzige
                    Desktop- und Mobile-Nutzer-App.
                  </p>
                </div>
              ) : null}
            </section>
          )}
        </main>
      </DialogPopup>
    </Dialog>
  );
}
