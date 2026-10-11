import { useAtomCommand } from "../../state/use-atom-command";
import type {
  EnvironmentId,
  CtoxWorkjetComputerProjection,
  WorkjetComputer,
  WorkjetConfiguration,
  WorkjetHarnessAvailabilitySnapshot,
} from "@workjet/contracts";
import { Trash2Icon } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useActiveWorkjetScope } from "../../activeWorkjetScope";
import {
  createComputerMembershipStore,
  workjetComputerMembership,
  type ComputerMembershipSnapshot,
} from "../../workjetComputerMembership";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { findComputerForTarget, includeSavedComputers } from "../../workjetComputerCatalog";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { workerSourceConnectionForEnrollment } from "../../workjetWorkerSourceConnection";
import { applyAutomaticCurrentComputer } from "../../state/workjetSettings";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Row, type RowMenuAction, type RowStatus } from "../ui/row";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useCtoxMode } from "../ctox/CtoxModeShell";
import { resolveSettingsInstanceContext } from "./settingsInstanceContext";
import type { OperationalComputerEnrollment } from "../../computerCapabilityEnrollment";
import { buildRoleEnrollment, type ComputerSshAccess } from "./ComputerCapabilitiesEditor";
import { toastManager } from "../ui/toast";
import { useComputerConnections } from "./ConnectionsSettings";
import {
  AddComputerInline,
  type AddComputerKind,
  type AddComputerOutcome,
  type AddComputerRequest,
} from "./AddComputerInline";
import {
  type WorkjetEnvironmentTargetOption,
  WorkjetComputerEditor,
  createWorkjetComputerDraft,
  saveWorkjetComputerDraft,
} from "./WorkjetComputerEditor";
import { workjetEnvironmentTargetOptions } from "./WorkjetSettings";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { workjetHarnessDisplayLabel } from "./WorkjetWorkerEditor";
import { ComputerProvisioningSection } from "./ComputerProvisioningSection";
import { searchableSetting } from "./settingsSearch";

export { applyAutomaticCurrentComputer } from "../../state/workjetSettings";

interface ComputerHarnessInspection {
  readonly snapshot: WorkjetHarnessAvailabilitySnapshot | null;
  readonly error: string | null;
}

function ComputerHarnessProbe({
  environmentId,
  revision,
  onInspection,
}: {
  readonly environmentId: EnvironmentId;
  readonly revision: number;
  readonly onInspection: (
    environmentId: EnvironmentId,
    inspection: ComputerHarnessInspection | null,
  ) => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.workjetHarnessInspect({ environmentId, input: {} }),
  );
  const refresh = query.refresh;
  const firstRevision = useRef(revision);
  useEffect(() => {
    if (revision !== firstRevision.current) refresh();
  }, [revision, refresh]);
  useEffect(() => {
    onInspection(environmentId, {
      snapshot: query.error === null ? query.data : null,
      error: query.error,
    });
  }, [environmentId, onInspection, query.data, query.error]);
  useEffect(() => () => onInspection(environmentId, null), [environmentId, onInspection]);
  return null;
}

export function toggleCurrentComputer(
  configuration: WorkjetConfiguration,
  computerId: WorkjetComputer["id"],
): WorkjetConfiguration {
  return {
    ...configuration,
    selectedComputerId: configuration.selectedComputerId === computerId ? null : computerId,
  };
}

export function removeComputer(
  configuration: WorkjetConfiguration,
  computerId: WorkjetComputer["id"],
): WorkjetConfiguration {
  return {
    ...configuration,
    computers: configuration.computers.filter((candidate) => candidate.id !== computerId),
    selectedComputerId:
      configuration.selectedComputerId === computerId ? null : configuration.selectedComputerId,
  };
}

export async function removeComputerConnection(input: {
  readonly configuration: WorkjetConfiguration;
  readonly computer: WorkjetComputer;
  readonly selectedInstanceId: string | null;
  readonly membership: ComputerMembershipSnapshot | null;
  readonly savedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly removeConnection: (environmentId: EnvironmentId) => Promise<boolean>;
}): Promise<
  | { readonly status: "assigned" | "connection_failed" }
  | { readonly status: "removed"; readonly configuration: WorkjetConfiguration }
> {
  // Removing a local connection never unassigns or revokes a native computer.
  // Keep a known assignment protected, including while its inventory refreshes.
  if (
    input.selectedInstanceId &&
    input.membership?.instanceId === input.selectedInstanceId &&
    input.membership.computers.some(
      (entry) => entry.id === input.computer.id && entry.status === "assigned",
    )
  ) {
    return { status: "assigned" };
  }
  const shared = input.configuration.computers.some(
    (entry) =>
      entry.id !== input.computer.id && entry.environmentId === input.computer.environmentId,
  );
  if (
    !shared &&
    input.savedEnvironmentIds.includes(input.computer.environmentId) &&
    !(await input.removeConnection(input.computer.environmentId))
  ) {
    return { status: "connection_failed" };
  }
  return {
    status: "removed",
    configuration: removeComputer(input.configuration, input.computer.id),
  };
}

export { findComputerForTarget, includeSavedComputers } from "../../workjetComputerCatalog";

/** Eine Maschine = eine Zeile: Coding-Verbindung und Instanz-Eintrag zusammen. */
export interface ComputerMachineRow {
  readonly key: string;
  readonly computer: WorkjetComputer | null;
  readonly native: CtoxWorkjetComputerProjection | null;
}

const GENERIC_NAME_TOKENS = new Set([
  "ssh",
  "lan",
  "wan",
  "vpn",
  "tailnet",
  "ts",
  "local",
  "com",
  "net",
  "org",
  "de",
  "dev",
  "io",
]);

function nameTokens(...values: ReadonlyArray<string | undefined>): Set<string> {
  const tokens = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const token of value
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, "")
      .split(/[^a-z0-9]+/)) {
      if (token.length >= 2 && !GENERIC_NAME_TOKENS.has(token)) tokens.add(token);
    }
  }
  return tokens;
}

/**
 * Führt den Instanz-Eintrag („gpu3“) und die SSH-Verbindung („gpu3-a4500“,
 * Alias „lan-gpu3“) derselben Maschine zu einer Zeile zusammen: zuerst über
 * die gemeinsame ID, sonst wenn alle Namensteile des Instanz-Eintrags in Name
 * oder Adresse genau EINER Verbindung vorkommen.
 */
export function mergeComputerRows(
  computers: ReadonlyArray<WorkjetComputer>,
  natives: ReadonlyArray<CtoxWorkjetComputerProjection>,
  environments: ReadonlyArray<WorkjetEnvironmentTargetOption> = [],
): ComputerMachineRow[] {
  const nativeFor: Record<string, CtoxWorkjetComputerProjection> = {};
  const claimed = new Set<string>();
  for (const native of natives) {
    const exact = computers.find((computer) => computer.id === native.id);
    if (exact) {
      nativeFor[exact.id] = native;
      claimed.add(native.id);
    }
  }
  for (const native of natives) {
    if (claimed.has(native.id)) continue;
    const wanted = nameTokens(native.displayName);
    if (wanted.size === 0) continue;
    const candidates = computers.filter((computer) => {
      if (nativeFor[computer.id] !== undefined) return false;
      const target = environments.find((entry) => entry.environmentId === computer.environmentId);
      const have = nameTokens(computer.label, target?.label, target?.detail);
      return [...wanted].every((token) => have.has(token));
    });
    if (candidates.length === 1) {
      nativeFor[candidates[0]!.id] = native;
      claimed.add(native.id);
    }
  }
  return [
    ...computers.map((computer) => ({
      key: computer.id,
      computer,
      native: nativeFor[computer.id] ?? null,
    })),
    ...natives
      .filter((native) => !claimed.has(native.id))
      .map((native) => ({ key: `native:${native.id}`, computer: null, native })),
  ];
}

const ACTIVE_OVERLAY_STORAGE_KEY = "workjet.computers.inactive";

function readInactiveKeys(): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(ACTIVE_OVERLAY_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

/**
 * Aktiv/Inaktiv je Rechner. Der Vertrag `WorkjetComputer` und die
 * Instanz-Projektion haben noch kein Feld dafür (Backend-Lücke); bis dahin
 * hält die Seite den Schalter nur in dieser Oberfläche.
 */
export function useComputerActiveOverlay() {
  const [inactive, setInactive] = useState<ReadonlySet<string>>(() =>
    typeof window === "undefined" ? new Set() : readInactiveKeys(),
  );
  const isActive = useCallback((key: string) => !inactive.has(key), [inactive]);
  const setActive = useCallback((key: string, active: boolean) => {
    setInactive((current) => {
      const next = new Set(current);
      if (active) next.delete(key);
      else next.add(key);
      try {
        window.localStorage.setItem(ACTIVE_OVERLAY_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        /* Speicher nicht verfügbar: der Schalter gilt dann nur für diese Sitzung. */
      }
      return next;
    });
  }, []);
  return { isActive, setActive };
}

const ROLE_CHIPS = [
  { kind: "build", label: "Build" },
  { kind: "storage", label: "Speicher" },
  { kind: "gpu", label: "GPU" },
] as const;

function Chip({
  children,
  title,
  tone = "muted",
  ...rest
}: {
  readonly children: ReactNode;
  readonly title?: string | undefined;
  readonly tone?: "muted" | "outline" | "busy" | "error";
} & Record<`data-${string}`, string>) {
  return (
    <span
      {...rest}
      title={title}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] leading-none whitespace-nowrap",
        tone === "muted" && "bg-muted text-foreground",
        tone === "outline" && "border border-border text-muted-foreground",
        tone === "busy" && "bg-muted text-muted-foreground",
        tone === "error" && "bg-destructive/10 text-destructive",
      )}
    >
      {children}
    </span>
  );
}

function roleChips(native: CtoxWorkjetComputerProjection | null): ReactNode[] {
  if (!native) return [];
  const gpu = native.capabilityConfig?.find((entry) => entry.kind === "gpu");
  return ROLE_CHIPS.filter(({ kind }) => native.capabilities.includes(kind)).map(
    ({ kind, label }) => (
      <Chip
        key={kind}
        data-workjet-capability={kind}
        title={kind === "gpu" && gpu ? `${gpu.model} · ${gpu.vram_gib} GB` : undefined}
      >
        {kind === "gpu" && gpu
          ? `GPU ${gpu.model.replace(/^(?:NVIDIA\s+)?(?:GeForce\s+)?(?:RTX\s+)?/i, "")}`
          : label}
      </Chip>
    ),
  );
}

export type ComputerRemoveMode = "workjet" | "computer";

type Expansion = { readonly key: string; readonly kind: "remove" | "repair" | "edit" };

function RemoveChoice({
  row,
  label,
  remoteAvailable,
  onRemove,
  onCancel,
}: {
  readonly row: ComputerMachineRow;
  readonly label: string;
  readonly remoteAvailable: boolean;
  readonly onRemove: (row: ComputerMachineRow, mode: ComputerRemoveMode) => Promise<string | null>;
  readonly onCancel: () => void;
}) {
  const [busy, setBusy] = useState<ComputerRemoveMode | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const run = (mode: ComputerRemoveMode) => {
    setBusy(mode);
    setFehler(null);
    void onRemove(row, mode)
      .then((failure) => {
        if (failure) setFehler(failure);
      })
      .catch((failure: unknown) =>
        setFehler(failure instanceof Error ? failure.message : "Entfernen fehlgeschlagen."),
      )
      .finally(() => setBusy(null));
  };
  return (
    <div
      className="flex flex-wrap items-center gap-2 px-3 pb-2.5 pl-8 text-[13.5px]"
      data-slot="computer-remove-choice"
      role="group"
      aria-label={`${label} entfernen`}
    >
      <span className="text-muted-foreground">{label} entfernen?</span>
      <Button
        size="xs"
        variant="destructive"
        disabled={busy !== null}
        onClick={() => run("workjet")}
      >
        {busy === "workjet" ? <Spinner className="size-3" /> : null}
        Nur aus Workjet entfernen
      </Button>
      <Button
        size="xs"
        variant="destructive"
        disabled={busy !== null || !remoteAvailable}
        title={remoteAvailable ? undefined : "Noch nicht verfügbar"}
        onClick={() => run("computer")}
      >
        Auch auf dem Rechner entfernen
      </Button>
      <Button size="xs" variant="outline" disabled={busy !== null} onClick={onCancel}>
        Abbrechen
      </Button>
      {fehler ? (
        <span role="alert" className="w-full text-xs text-destructive">
          {fehler}
        </span>
      ) : !remoteAvailable ? (
        <span role="status" className="w-full text-xs text-muted-foreground">
          Entfernen auf dem Rechner noch nicht verfügbar
        </span>
      ) : null}
    </div>
  );
}

export function WorkjetComputersSettingsView({
  configuration,
  environments,
  environmentsReady,
  harnessInspection = null,
  harnessInspections,
  environmentId = null,
  onChange,
  membership,
  businessOsLabel,
  connectedEnvironmentIds,
  connectingEnvironmentIds,
  pendingConnectionEnvironmentId,
  addPanel,
  isActive,
  onActiveChange,
  onRemove,
  remoteRemoveAvailable = false,
  onRecheck,
  onAssign,
  renderRepair,
  renderEdit,
  onRetryMembership,
}: {
  readonly configuration: WorkjetConfiguration;
  readonly environments: ReadonlyArray<WorkjetEnvironmentTargetOption>;
  readonly environmentsReady: boolean;
  /** Werkzeugprüfung dieses Servers; null bis zur ersten Antwort. */
  readonly harnessInspection?: WorkjetHarnessAvailabilitySnapshot | null;
  readonly harnessInspections?: Readonly<Record<string, ComputerHarnessInspection>>;
  readonly environmentId?: EnvironmentId | null;
  readonly onChange: (configuration: WorkjetConfiguration) => void;
  readonly membership?: ComputerMembershipSnapshot | undefined;
  readonly businessOsLabel?: string | null;
  readonly connectedEnvironmentIds?: ReadonlyArray<EnvironmentId>;
  readonly connectingEnvironmentIds?: ReadonlyArray<EnvironmentId>;
  readonly pendingConnectionEnvironmentId?: EnvironmentId | null;
  /** Das Inline-Panel „Rechner hinzufügen“. */
  readonly addPanel?: ReactNode;
  readonly isActive?: (key: string) => boolean;
  readonly onActiveChange?: (row: ComputerMachineRow, active: boolean) => void;
  readonly onRemove?: (row: ComputerMachineRow, mode: ComputerRemoveMode) => Promise<string | null>;
  readonly remoteRemoveAvailable?: boolean;
  readonly onRecheck?: (row: ComputerMachineRow) => void;
  readonly onAssign?: ((computer: WorkjetComputer, assigned: boolean) => void) | undefined;
  readonly renderRepair?: (row: ComputerMachineRow, close: () => void) => ReactNode;
  readonly renderEdit?: (row: ComputerMachineRow, close: () => void) => ReactNode;
  readonly onRetryMembership?: (() => void) | undefined;
}) {
  const [expansion, setExpansion] = useState<Expansion | null>(null);
  // Während die Instanz neu prüft, bleiben die zuletzt bestätigten Einträge
  // stehen (die Membership-Ablage behält sie für dieselbe Instanz). Zeilen
  // erscheinen und verschwinden nicht; ein Chip „prüft…“ zeigt die Prüfung.
  const natives =
    membership && membership.phase !== "failed"
      ? membership.computers.filter((entry) => entry.status === "assigned")
      : [];
  const membershipChecking = membership?.phase === "loading";
  const membershipUnreachable = membership?.phase === "failed";
  const stateFor = (computer: WorkjetComputer) => {
    const connecting = connectingEnvironmentIds?.includes(computer.environmentId) ?? false;
    const disconnected =
      environmentsReady &&
      computer.environmentId !== pendingConnectionEnvironmentId &&
      !connecting &&
      (connectedEnvironmentIds !== undefined
        ? !connectedEnvironmentIds.includes(computer.environmentId)
        : computer.environmentId !== environmentId &&
          !environments.some((entry) => entry.environmentId === computer.environmentId));
    const inspection = harnessInspections?.[computer.environmentId];
    const snapshot =
      disconnected || connecting
        ? null
        : harnessInspections !== undefined
          ? (inspection?.snapshot ?? null)
          : computer.environmentId === environmentId
            ? harnessInspection
            : null;
    return { connecting, disconnected, inspection, snapshot };
  };
  // Feste Reihenfolge: dieser Rechner zuerst, dann nach Name. Verbindungs-
  // zustände ändern die Reihenfolge nie (kein Springen beim Prüfen).
  const computers = [...configuration.computers].sort(
    (left, right) =>
      Number(right.environmentId === environmentId) -
        Number(left.environmentId === environmentId) || left.label.localeCompare(right.label),
  );
  const rows = mergeComputerRows(computers, natives, environments).sort((left, right) => {
    if (left.computer && !right.computer) return -1;
    if (!left.computer && right.computer) return 1;
    if (left.computer || right.computer) return 0;
    return (left.native?.displayName ?? "").localeCompare(right.native?.displayName ?? "");
  });
  const toggle = (key: string, kind: Expansion["kind"]) =>
    setExpansion((current) =>
      current?.key === key && current.kind === kind ? null : { key, kind },
    );
  const close = () => setExpansion(null);

  const headerStatus = membershipChecking ? (
    <Chip tone="busy" data-slot="computers-membership-checking">
      <Spinner className="size-2.5" />
      prüft…
    </Chip>
  ) : membershipUnreachable ? (
    <span className="flex items-center gap-1.5">
      <Chip tone="error" title={membership?.error ?? undefined}>
        Instanz nicht erreichbar
      </Chip>
      {onRetryMembership ? (
        <Button size="xs" variant="outline" onClick={onRetryMembership}>
          Erneut versuchen
        </Button>
      ) : null}
    </span>
  ) : null;

  return (
    <SettingsSection
      id={searchableSetting("workjet-computers").id}
      title={searchableSetting("workjet-computers").title}
      headerAction={headerStatus}
    >
      <div
        className="divide-y divide-border/60 border-y border-border/60"
        data-workjet-computers-table
      >
        {rows.map((row) => {
          const { computer, native } = row;
          const active = isActive?.(row.key) ?? true;
          const label = computer?.label ?? native?.displayName ?? row.key;
          let status: RowStatus = "off";
          let statusLabel = "Offline";
          let meta: ReactNode = null;
          const chips: ReactNode[] = [...roleChips(native)];
          if (computer) {
            const { connecting, disconnected, inspection, snapshot } = stateFor(computer);
            const target = environments.find(
              (entry) => entry.environmentId === computer.environmentId,
            );
            const checking =
              !environmentsReady || computer.environmentId === pendingConnectionEnvironmentId;
            status = checking || connecting ? "busy" : disconnected ? "off" : "ok";
            statusLabel = checking
              ? "Prüft"
              : connecting
                ? "Verbindet"
                : disconnected
                  ? "Offline"
                  : "Online";
            meta =
              computer.environmentId === environmentId
                ? "Dieser Rechner"
                : target
                  ? [target.label !== computer.label ? target.label : null, target.detail]
                      .filter((part): part is string => !!part)
                      .join(" · ")
                  : computer.presentationKind === "local"
                    ? "Local"
                    : "—";
            if (snapshot) {
              const tools = computer.harnesses.filter(
                (declared) =>
                  declared.available &&
                  snapshot.harnesses.some(
                    (live) =>
                      live.harness === declared.harness && live.availability === "available",
                  ),
              );
              for (const declared of tools.slice(0, 3)) {
                const live = snapshot.harnesses.find((entry) => entry.harness === declared.harness);
                chips.push(
                  <Chip
                    key={`tool-${declared.harness}`}
                    tone="outline"
                    data-workjet-tool={declared.harness}
                    title={
                      live?.availability === "available"
                        ? `${live.version ? `v${live.version} · ` : ""}${live.executablePath}`
                        : undefined
                    }
                  >
                    {workjetHarnessDisplayLabel(declared.harness).replace(/\s+(CLI|Code)$/, "")}
                  </Chip>,
                );
              }
              if (tools.length > 3)
                chips.push(
                  <Chip key="tool-more" tone="outline">
                    +{tools.length - 3}
                  </Chip>,
                );
            } else if (!disconnected && !connecting && inspection?.error) {
              chips.push(
                <Chip key="tool-error" tone="error" title={inspection.error}>
                  Werkzeuge ?
                </Chip>,
              );
            } else if (!disconnected) {
              chips.push(
                <Chip key="tool-check" tone="busy" data-slot="computer-tools-checking">
                  {connecting ? "verbindet…" : "prüft…"}
                </Chip>,
              );
            }
            if (configuration.selectedComputerId === computer.id)
              chips.push(
                <Chip key="current" tone="outline" data-slot="computer-current">
                  Aktuell
                </Chip>,
              );
          } else if (native) {
            status = "off";
            statusLabel = "Nur Instanz";
            meta = native.agentless ? "Speicher" : "Instanz";
          }
          if (native)
            chips.push(
              <Chip key="instance" tone="outline" title={businessOsLabel ?? undefined}>
                {businessOsLabel ?? "Instanz"}
              </Chip>,
            );

          const menuActions: RowMenuAction[] = [];
          if (computer && renderRepair)
            menuActions.push({ label: "Reparieren", onSelect: () => toggle(row.key, "repair") });
          if (onRecheck) menuActions.push({ label: "Neu prüfen", onSelect: () => onRecheck(row) });
          if (computer && renderEdit)
            menuActions.push({ label: "Bearbeiten", onSelect: () => toggle(row.key, "edit") });
          if (computer)
            menuActions.push({
              label:
                configuration.selectedComputerId === computer.id
                  ? "Nicht mehr aktuell"
                  : "Als aktuell verwenden",
              onSelect: () => onChange(toggleCurrentComputer(configuration, computer.id)),
            });
          if (computer && !native && onAssign && membership?.phase === "ready")
            menuActions.push({
              label: "Zur Instanz hinzufügen",
              onSelect: () => onAssign(computer, true),
            });

          const expanded = expansion?.key === row.key ? expansion.kind : null;
          return (
            <Fragment key={row.key}>
              <div
                {...(computer
                  ? { "data-workjet-computer": computer.id }
                  : { "data-workjet-native-computer": native?.id ?? row.key })}
                className={cn(!active && "opacity-55")}
              >
                <Row
                  className="flex-wrap sm:flex-nowrap max-sm:[&>div:has(>[data-slot=row-name])]:basis-[calc(100%-1.25rem)] max-sm:[&>[data-slot=row-chips]]:flex-1 max-sm:[&>[data-slot=row-chips]]:shrink max-sm:[&>[data-slot=row-chips]]:flex-wrap max-sm:[&>[data-slot=row-chips]]:pl-5"
                  status={status}
                  statusLabel={statusLabel}
                  name={label}
                  meta={meta}
                  chips={
                    <>
                      <span className="flex min-w-0 flex-wrap items-center gap-1 max-sm:flex-1">
                        {chips}
                      </span>
                      {onActiveChange ? (
                        <Switch
                          aria-label={`${label} aktiv`}
                          checked={active}
                          onCheckedChange={(checked) => onActiveChange(row, checked === true)}
                        />
                      ) : null}
                      {onRemove ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <Button
                                aria-label={`${label} entfernen`}
                                aria-expanded={expanded === "remove"}
                                size="icon-sm"
                                variant="ghost"
                                onClick={() => toggle(row.key, "remove")}
                              />
                            }
                          >
                            <Trash2Icon />
                          </TooltipTrigger>
                          <TooltipPopup>Entfernen</TooltipPopup>
                        </Tooltip>
                      ) : null}
                    </>
                  }
                  menuActions={menuActions}
                  menuLabel={`Weitere Aktionen für ${label}`}
                />
              </div>
              {expanded === "remove" && onRemove ? (
                <RemoveChoice
                  row={row}
                  label={label}
                  remoteAvailable={remoteRemoveAvailable}
                  onRemove={async (target, mode) => {
                    const failure = await onRemove(target, mode);
                    if (!failure) close();
                    return failure;
                  }}
                  onCancel={close}
                />
              ) : null}
              {expanded === "repair" && renderRepair ? (
                <div className="px-3 pb-3 pl-8" data-slot="computer-repair">
                  {renderRepair(row, close)}
                </div>
              ) : null}
              {expanded === "edit" && renderEdit ? (
                <div className="px-3 pb-3 pl-8" data-slot="computer-edit">
                  {renderEdit(row, close)}
                </div>
              ) : null}
            </Fragment>
          );
        })}
        {rows.length === 0 ? (
          <div className="px-3 py-2.5 text-[13.5px] text-muted-foreground" role="status">
            {environmentsReady ? "Noch keine Rechner" : "Lädt…"}
          </div>
        ) : null}
      </div>
      {addPanel ? <div className="flex flex-col pt-3">{addPanel}</div> : null}
    </SettingsSection>
  );
}

function sshAccessFor(request: AddComputerRequest): ComputerSshAccess | null {
  if (!request.target || !request.hostKey || !request.target.username) return null;
  return {
    host: request.target.hostname,
    port: request.target.port ?? 22,
    username: request.target.username,
    hostKeySha256: request.hostKey.fingerprint,
    hostKeyAlgorithm: request.hostKey.algorithm,
  };
}

const PENDING_COMPUTER_TIMEOUT_MS = 90_000;

export function WorkjetComputersSettings({
  instanceId,
  setupOnly = false,
  onCompleted,
  onBusyChange,
}: {
  readonly instanceId?: string;
  readonly setupOnly?: boolean;
  readonly onCompleted?: () => void;
  readonly onBusyChange?: (busy: boolean) => void;
} = {}) {
  const { selectedInstanceId: activeInstanceId } = useActiveWorkjetScope();
  const selectedInstanceId = instanceId ?? activeInstanceId;
  const { discovery } = useCtoxMode();
  const businessOsLabel = resolveSettingsInstanceContext(
    discovery,
    selectedInstanceId,
  ).activeInstanceName;
  const [mapMembership] = useState(createComputerMembershipStore);
  const membershipStore = instanceId === undefined ? workjetComputerMembership : mapMembership;
  useEffect(() => {
    if (instanceId === undefined) return;
    void mapMembership.refresh(instanceId, window.desktopBridge?.ctox);
    return () => mapMembership.select(null);
  }, [instanceId, mapMembership]);
  const membership = useSyncExternalStore(
    membershipStore.subscribe,
    membershipStore.getSnapshot,
    membershipStore.getSnapshot,
  );
  const activeMembership = membership.instanceId === selectedInstanceId ? membership : undefined;
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const { environments, isReady: environmentsReady } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const localAvailable = environmentsReady && primaryEnvironment?.connection.phase === "connected";
  const [harnessInspections, setHarnessInspections] = useState<
    Readonly<Record<string, ComputerHarnessInspection>>
  >({});
  const [probeRevision, setProbeRevision] = useState<Readonly<Record<string, number>>>({});
  const recordHarnessInspection = useCallback(
    (target: EnvironmentId, inspection: ComputerHarnessInspection | null) => {
      setHarnessInspections((current) => {
        const next = { ...current };
        if (inspection === null) delete next[target];
        else next[target] = inspection;
        return next;
      });
    },
    [],
  );
  const [addOpen, setAddOpen] = useState(() => {
    try {
      if (window.sessionStorage.getItem("workjet-computer-create") !== null) {
        window.sessionStorage.removeItem("workjet-computer-create");
        return true;
      }
    } catch {
      /* Storage can be unavailable. The add button remains usable. */
    }
    return false;
  });
  const [segment, setSegment] = useState<AddComputerKind>("ssh");
  const connections = useComputerConnections({
    discoverSshHosts: (addOpen || setupOnly) && segment === "ssh",
  });
  const activeOverlay = useComputerActiveOverlay();

  // Connect → harness probe → computer record. The add pipeline awaits it.
  const [pending, setPending] = useState<{
    readonly environmentId: EnvironmentId;
    readonly kind: AddComputerKind;
  } | null>(null);
  const pendingWaiter = useRef<{
    readonly environmentId: EnvironmentId;
    readonly resolve: (computer: WorkjetComputer) => void;
    readonly reject: (error: Error) => void;
  } | null>(null);
  const targetOptions = workjetEnvironmentTargetOptions(environments);
  const configuration = includeSavedComputers(settings.workjet, targetOptions, environmentId);
  const pendingTarget = targetOptions.find(
    (target) => target.environmentId === pending?.environmentId,
  );
  const pendingInspection = useEnvironmentQuery(
    pending === null
      ? null
      : serverEnvironment.workjetHarnessInspect({
          environmentId: pending.environmentId,
          input: {},
        }),
  );
  useEffect(() => {
    if (!pending || !pendingTarget || !pendingInspection.data) return;
    const existing = findComputerForTarget(settings.workjet, pendingTarget, targetOptions);
    const draft = createWorkjetComputerDraft({ environments: [pendingTarget] });
    const computer =
      existing ??
      saveWorkjetComputerDraft({
        ...draft,
        presentationKind: pending.kind,
        harnesses: draft.harnesses.map((entry) => ({
          ...entry,
          available: pendingInspection.data!.harnesses.some(
            (live) => live.harness === entry.harness && live.availability === "available",
          ),
        })),
      });
    updateSettings({
      workjet: {
        ...settings.workjet,
        computers: existing
          ? settings.workjet.computers
          : [...settings.workjet.computers, computer],
        selectedComputerId: computer.id,
      },
    });
    if (pendingWaiter.current?.environmentId === pending.environmentId) {
      pendingWaiter.current.resolve(computer);
      pendingWaiter.current = null;
    }
    setPending(null);
  }, [
    pending,
    pendingTarget,
    pendingInspection.data,
    settings.workjet,
    targetOptions,
    updateSettings,
  ]);
  useEffect(() => {
    if (!pending || !pendingInspection.error) return;
    if (pendingWaiter.current?.environmentId === pending.environmentId) {
      pendingWaiter.current.reject(new Error("Werkzeuge nicht prüfbar."));
      pendingWaiter.current = null;
    }
    setPending(null);
  }, [pending, pendingInspection.error]);
  function waitForComputer(target: EnvironmentId, kind: AddComputerKind): Promise<WorkjetComputer> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (pendingWaiter.current?.environmentId === target) pendingWaiter.current = null;
        setPending(null);
        reject(new Error("Prüfung dauert zu lange."));
      }, PENDING_COMPUTER_TIMEOUT_MS);
      pendingWaiter.current = {
        environmentId: target,
        resolve: (computer) => {
          window.clearTimeout(timer);
          resolve(computer);
        },
        reject: (error) => {
          window.clearTimeout(timer);
          reject(error);
        },
      };
      setPending({ environmentId: target, kind });
    });
  }

  const setupBusy = connections.busy || pending !== null || membership.pendingComputerId !== null;
  useEffect(() => {
    onBusyChange?.(setupBusy);
    return () => onBusyChange?.(false);
  }, [setupBusy, onBusyChange]);
  const harnessInspectQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.workjetHarnessInspect({ environmentId, input: {} }),
  );

  const enrollRemoteComputer = useAtomCommand(serverEnvironment.enrollWorkjetRemoteComputer, {
    reportFailure: false,
  });
  const workerConnections = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.workjetDecisionHubConnections({ environmentId, input: {} }),
  );

  const rolesAvailable = !!selectedInstanceId && activeMembership?.phase === "ready";
  const rolesStatus = !selectedInstanceId
    ? "Keine Instanz gewählt"
    : activeMembership?.phase === "failed"
      ? "Instanz nicht erreichbar"
      : activeMembership?.phase === "ready"
        ? null
        : "Instanz prüft…";

  const addComputer = async (request: AddComputerRequest): Promise<AddComputerOutcome> => {
    // 1. Verbinden.
    let connected: EnvironmentId;
    if (request.kind === "local") {
      if (environmentId === null || !localAvailable)
        return { status: "error", message: "Dieser Rechner ist nicht verbunden." };
      connected = environmentId;
    } else {
      if (!request.target) return { status: "error", message: "Adresse fehlt." };
      const result = await connections.connectSsh(request.target, request.label);
      if (!result.ok) return { status: "error", message: result.message ?? "Abgebrochen." };
      connected = result.environmentId;
    }
    // 2. Werkzeuge prüfen und den Rechner anlegen (oder den bekannten nehmen).
    let computer: WorkjetComputer;
    try {
      computer = await waitForComputer(connected, request.kind);
    } catch (failure) {
      return {
        status: "error",
        message: failure instanceof Error ? failure.message : "Werkzeuge nicht prüfbar.",
      };
    }
    // 3. In der gewählten Instanz eintragen, mit den Haken.
    if (!selectedInstanceId) return { status: "done" };
    const snapshot = membershipStore.getSnapshot();
    const wantsRoles = request.roles.build || request.roles.storage;
    if (snapshot.instanceId !== selectedInstanceId || snapshot.phase !== "ready") {
      return wantsRoles
        ? { status: "error", message: "Instanz prüft noch. Erneut versuchen." }
        : { status: "done" };
    }
    const native = snapshot.computers.find((entry) => entry.id === computer.id) ?? null;
    // Eine schon gespeicherte GPU gilt als erkannt und bleibt beim erneuten Hinzufügen.
    const roles = {
      ...request.roles,
      gpu: request.roles.gpu || (native?.capabilities.includes("gpu") ?? false),
    };
    let enrollment: OperationalComputerEnrollment;
    try {
      enrollment = buildRoleEnrollment({
        computerId: computer.id,
        displayName: request.label || computer.label,
        roles,
        agentCapabilities: computer.harnesses
          .filter((entry) => entry.available)
          .map((entry) => entry.harness),
        access: sshAccessFor(request),
        native,
        cpuCount:
          request.kind === "local" && typeof navigator !== "undefined"
            ? navigator.hardwareConcurrency
            : null,
      });
      // „Local“ hat keine Haken für Build und Speicher: Gespeichertes bleibt.
      if (
        request.kind === "local" &&
        native?.capabilityConfig?.length &&
        !roles.build &&
        !roles.storage
      )
        enrollment = {
          ...enrollment,
          capabilityConfig: [],
          endpoint: null,
          preserveOperationalCapabilities: true,
        };
    } catch (failure) {
      return {
        status: "error",
        message: failure instanceof Error ? failure.message : "Haken nicht speicherbar.",
      };
    }
    try {
      const build = enrollment.capabilityConfig.find((capability) => capability.kind === "build");
      if (build && build.kind === "build" && connected !== environmentId) {
        if (!environmentId)
          return { status: "error", message: "Dieser Rechner ist nicht verbunden." };
        const source = workerSourceConnectionForEnrollment(
          workerConnections.data?.connections ?? [],
          selectedInstanceId,
        );
        if (!source) return { status: "error", message: "Lumas der Instanz sind nicht verbunden." };
        const result = await enrollRemoteComputer({
          environmentId,
          targetEnvironmentId: connected,
          input: {
            selectedInstanceId: source.instanceId,
            sourceConnectionId: source.connectionId,
            computerId: computer.id,
            displayName: enrollment.displayName,
            hostingMode: enrollment.hostingMode,
            buildCapability: build,
          },
        });
        if (result._tag !== "Success")
          return { status: "error", message: "Build-Rechner nicht eingetragen." };
        enrollment = { ...enrollment, computerId: result.value.computerId };
      }
      const key = await membershipStore.enroll(
        selectedInstanceId,
        enrollment,
        window.desktopBridge?.ctox,
      );
      if (key && request.target)
        return {
          status: "key",
          publicKey: key.publicKey,
          publicKeySha256: key.publicKeySha256,
          where: `${request.target.username ?? ""}@${request.target.hostname}`.replace(/^@/, ""),
        };
      return { status: "done" };
    } catch (failure) {
      return {
        status: "error",
        message: failure instanceof Error ? failure.message : "Instanz hat nicht bestätigt.",
      };
    }
  };

  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  // Stabile Referenz: die tailnet-Liste lädt nur beim Öffnen und auf „Neu laden“.
  const discoverTailscalePeers = useMemo(
    () => (bridge?.discoverTailscalePeers ? () => bridge.discoverTailscalePeers() : undefined),
    [bridge],
  );
  const addPanel = (
    <AddComputerInline
      open={addOpen}
      onOpenChange={setAddOpen}
      alwaysOpen={setupOnly}
      segment={segment}
      onSegmentChange={setSegment}
      localAvailable={localAvailable}
      desktopAvailable={connections.desktopAvailable}
      sshAliases={connections.sshAliases}
      knownHosts={connections.knownHosts}
      sshAliasesLoading={connections.sshAliasesLoading}
      onRefreshSshAliases={connections.refreshSshAliases}
      connectionError={connections.catalogError ?? connections.sshAliasesError}
      catalogRecoveryAvailable={connections.catalogRecoveryAvailable}
      onRecoverCatalog={() => void connections.recoverCatalog()}
      rolesAvailable={rolesAvailable}
      rolesStatus={rolesStatus}
      {...(discoverTailscalePeers ? { discoverTailscalePeers } : {})}
      {...(bridge?.inspectProvisioningHostKey
        ? { inspectHostKey: (target) => bridge.inspectProvisioningHostKey!(target) }
        : {})}
      onAdd={addComputer}
      onDone={() => {
        toastManager.add({ type: "success", title: "Rechner hinzugefügt" });
        if (setupOnly) onCompleted?.();
      }}
    />
  );

  if (setupOnly) return <div className="space-y-3">{addPanel}</div>;

  const savedEnvironmentIds = connections.savedEnvironments.map((entry) => entry.environmentId);
  const connectedIds = environments
    .filter((entry) => entry.connection.phase === "connected")
    .map((entry) => entry.environmentId);
  const removeRow = async (row: ComputerMachineRow, mode: ComputerRemoveMode) => {
    if (mode === "computer") return "Entfernen auf dem Rechner noch nicht verfügbar.";
    if (row.native && selectedInstanceId) {
      const unassigned = await membershipStore.unassign(
        selectedInstanceId,
        row.native.id,
        window.desktopBridge?.ctox,
      );
      if (!unassigned) return membershipStore.getSnapshot().error ?? "Instanz hat nicht bestätigt.";
    }
    if (!row.computer) return null;
    const result = await removeComputerConnection({
      configuration,
      computer: row.computer,
      selectedInstanceId,
      membership: membershipStore.getSnapshot(),
      savedEnvironmentIds,
      removeConnection: (target) => connections.removeConnection(target),
    });
    if (result.status !== "removed")
      return result.status === "assigned"
        ? "Noch in der Instanz eingetragen."
        : "Verbindung nicht entfernbar.";
    updateSettings({ workjet: result.configuration });
    activeOverlay.setActive(row.key, true);
    return null;
  };

  return (
    <SettingsPageContainer wide className="gap-6">
      {[...new Set(configuration.computers.map((computer) => computer.environmentId))]
        .filter((target) =>
          environments.some(
            (entry) => entry.environmentId === target && entry.connection.phase === "connected",
          ),
        )
        .map((target) => (
          <ComputerHarnessProbe
            key={target}
            environmentId={target}
            revision={probeRevision[target] ?? 0}
            onInspection={recordHarnessInspection}
          />
        ))}
      <WorkjetComputersSettingsView
        configuration={configuration}
        environments={targetOptions}
        environmentsReady={environmentsReady}
        harnessInspection={harnessInspectQuery.data ?? null}
        harnessInspections={harnessInspections}
        environmentId={environmentId}
        onChange={(workjet) => updateSettings({ workjet })}
        businessOsLabel={businessOsLabel}
        membership={activeMembership}
        connectedEnvironmentIds={connectedIds}
        connectingEnvironmentIds={environments
          .filter(
            (entry) =>
              entry.connection.phase === "connecting" || entry.connection.phase === "reconnecting",
          )
          .map((entry) => entry.environmentId)}
        pendingConnectionEnvironmentId={pending?.environmentId ?? null}
        addPanel={addPanel}
        isActive={activeOverlay.isActive}
        onActiveChange={(row, active) => activeOverlay.setActive(row.key, active)}
        onRemove={removeRow}
        remoteRemoveAvailable={false}
        onRecheck={(row) => {
          if (selectedInstanceId)
            void membershipStore.refresh(selectedInstanceId, window.desktopBridge?.ctox);
          const computer = row.computer;
          if (!computer) return;
          if (
            !connectedIds.includes(computer.environmentId) &&
            savedEnvironmentIds.includes(computer.environmentId)
          ) {
            void connections.reconnect(computer.environmentId).then((failure) => {
              if (failure) toastManager.add({ type: "error", title: failure });
            });
            return;
          }
          setProbeRevision((current) => ({
            ...current,
            [computer.environmentId]: (current[computer.environmentId] ?? 0) + 1,
          }));
        }}
        onAssign={
          selectedInstanceId
            ? (computer, assigned) => {
                void membershipStore.setAssigned(
                  selectedInstanceId,
                  computer,
                  assigned,
                  window.desktopBridge?.ctox,
                );
              }
            : undefined
        }
        onRetryMembership={
          selectedInstanceId
            ? () => void membershipStore.refresh(selectedInstanceId, window.desktopBridge?.ctox)
            : undefined
        }
        renderRepair={(row, close) => {
          const computer = row.computer;
          if (!computer) return null;
          const sshTarget = connections.savedSshTargets.get(computer.environmentId);
          const online = connectedIds.includes(computer.environmentId);
          const saved = savedEnvironmentIds.includes(computer.environmentId);
          return (
            <div className="space-y-3">
              {saved ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={connections.busyEnvironmentId === computer.environmentId}
                    onClick={() => {
                      const action = online ? connections.disconnect : connections.reconnect;
                      void action(computer.environmentId).then((failure) => {
                        if (failure) toastManager.add({ type: "error", title: failure });
                      });
                    }}
                  >
                    {online ? "Trennen" : "Verbinden"}
                  </Button>
                  <Button size="xs" variant="outline" onClick={close}>
                    Schließen
                  </Button>
                </div>
              ) : null}
              <ComputerProvisioningSection
                key={computer.id}
                initialKind={computer.environmentId === environmentId ? "local" : "ssh"}
                fixedTargetKind
                {...(sshTarget
                  ? {
                      initialTarget: {
                        host: sshTarget.hostname,
                        username: sshTarget.username,
                        port: sshTarget.port,
                      },
                    }
                  : {})}
              />
            </div>
          );
        }}
        renderEdit={(row, close) =>
          row.computer ? (
            <WorkjetComputerEditor
              key={row.computer.id}
              compact
              computer={row.computer}
              environments={targetOptions}
              availability={harnessInspections[row.computer.environmentId]?.snapshot ?? null}
              onCancel={close}
              onSave={(computer) => {
                const computers = configuration.computers.map((entry) =>
                  entry.id === computer.id ? computer : entry,
                );
                updateSettings({
                  workjet: applyAutomaticCurrentComputer(
                    { ...configuration, computers },
                    environmentId,
                  ),
                });
                close();
              }}
            />
          ) : null
        }
      />
    </SettingsPageContainer>
  );
}
