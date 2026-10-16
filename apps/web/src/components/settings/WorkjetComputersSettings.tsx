import { workjetUiLanguage } from "../../workjetProjectControl";
import { ProjectFolderSettingRow } from "./SettingsPanels";
import { useAtomCommand } from "../../state/use-atom-command";
import type {
  ComputerConnection,
  ComputerControlInput,
  ComputerControlResult,
  ComputerFacts,
  ComputerMetadata,
  DesktopBridge,
  EnvironmentId,
  CtoxWorkjetComputerProjection,
  WorkjetComputer,
  WorkjetConfiguration,
  WorkjetHarnessAvailabilitySnapshot,
} from "@workjet/contracts";
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
import * as Option from "effect/Option";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { workerSourceConnectionForEnrollment } from "../../workjetWorkerSourceConnection";
import { applyAutomaticCurrentComputer } from "../../state/workjetSettings";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Empty, EmptyHeader, EmptyLoading, EmptyTitle } from "../ui/empty";
import { CapabilitySwitch } from "./CapabilitySwitch";
import { InlineExpand } from "../ui/inline-expand";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useAutomaticWorktreeStorage, WorktreeStorageInline } from "./WorkjetSettings";
import { Row, type RowDeleteOption, type RowMenuAction, type RowStatus } from "../ui/row";
import { useCtoxMode } from "../ctox/CtoxModeShell";
import {
  remoteDaemonTarget,
  remoteDaemonUpdateFor,
  remoteDaemonUpdateKey,
  useRemoteDaemonUpdates,
  type RemoteDaemonUpdates,
} from "./remoteDaemonUpdate";
import { resolveSettingsInstanceContext } from "./settingsInstanceContext";
import type { OperationalComputerEnrollment } from "../../computerCapabilityEnrollment";
import {
  buildRoleEnrollment,
  gibOf,
  gpuDetected,
  shortGpuModel,
  type ComputerSshAccess,
} from "./ComputerCapabilitiesEditor";
import { toastManager } from "../ui/toast";
import { useComputerConnections } from "./ConnectionsSettings";
import {
  type AddComputerKind,
  type AddComputerOutcome,
  type AddComputerRequest,
  type KnownComputerFacts,
} from "./AddComputerInline";
import { AddMachineEnrollment } from "./AddMachineEnrollment";
import { useMachineEnrollment } from "./useMachineEnrollment";
import type { MachineCandidate } from "./machineEnrollment";
import { type AddComputerPhase, watchSshEnvironmentProgress } from "./legacyMachineEnrollment";
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

type ComputerRecord = ComputerControlResult["computers"][number];

function emptyIdSet(): ReadonlySet<string> {
  return new Set();
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
 * Dieselbe Maschine laut Erkennung: Machine-ID, sonst Host-Schlüssel.
 * null, wenn eine Seite keine Identität kennt.
 */
export function sameDetectedMachine(
  computer: WorkjetComputer,
  native: CtoxWorkjetComputerProjection,
): boolean | null {
  const machineId = computer.metadata?.facts?.machineId ?? null;
  const nativeMachineId = native.detectedFacts?.machineId ?? null;
  if (machineId && nativeMachineId) return machineId === nativeMachineId;
  const fingerprint = computer.metadata?.hostKeyFingerprint ?? null;
  const nativeFingerprint = native.hostKeyFingerprint ?? null;
  if (fingerprint && nativeFingerprint) return fingerprint === nativeFingerprint;
  return null;
}

/**
 * Führt den Instanz-Eintrag und die Verbindung derselben Maschine zu einer
 * Zeile zusammen: (1) gleiche ID, auch eine frühere ID des zusammengeführten
 * Rechners; (2) gleiche Identität aus der Erkennung (Machine-ID oder
 * Host-Schlüssel); (3) nur ohne Identität auf einer Seite die Namensteile,
 * wenn sie in Name oder Adresse genau EINER Verbindung vorkommen.
 */
export function mergeComputerRows(
  computers: ReadonlyArray<WorkjetComputer>,
  natives: ReadonlyArray<CtoxWorkjetComputerProjection>,
  environments: ReadonlyArray<WorkjetEnvironmentTargetOption> = [],
): ComputerMachineRow[] {
  const nativeFor: Record<string, CtoxWorkjetComputerProjection> = {};
  const claimed = new Set<string>();
  const claim = (computer: WorkjetComputer, native: CtoxWorkjetComputerProjection) => {
    nativeFor[computer.id] = native;
    claimed.add(native.id);
  };
  for (const native of natives) {
    const exact =
      computers.find((computer) => computer.id === native.id) ??
      computers.find((computer) => computer.metadata?.previousIds.includes(native.id));
    if (exact && nativeFor[exact.id] === undefined) claim(exact, native);
  }
  for (const native of natives) {
    if (claimed.has(native.id)) continue;
    const candidates = computers.filter(
      (computer) =>
        nativeFor[computer.id] === undefined && sameDetectedMachine(computer, native) === true,
    );
    if (candidates.length === 1) claim(candidates[0]!, native);
  }
  for (const native of natives) {
    if (claimed.has(native.id)) continue;
    const wanted = nameTokens(native.displayName);
    if (wanted.size === 0) continue;
    const candidates = computers.filter((computer) => {
      if (nativeFor[computer.id] !== undefined) return false;
      if (sameDetectedMachine(computer, native) === false) return false;
      const target = environments.find((entry) => entry.environmentId === computer.environmentId);
      const have = nameTokens(computer.label, target?.label, target?.detail);
      return [...wanted].every((token) => have.has(token));
    });
    if (candidates.length === 1) claim(candidates[0]!, native);
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

export type ComputerCapacity = NonNullable<ComputerControlResult["computers"][number]["capacity"]>;

function gpuChip(key: string, model: string, gib: number | null, unified: boolean): ReactNode {
  return (
    <Chip
      key={key}
      data-workjet-capability="gpu"
      title={[model, gib ? `${gib} GB${unified ? " gemeinsam" : " VRAM"}` : null]
        .filter((part): part is string => !!part)
        .join(" · ")}
    >
      {`GPU ${shortGpuModel(model)}${gib ? ` · ${gib} GB` : ""}`}
    </Chip>
  );
}

export interface ComputerRoleChoice {
  readonly build: boolean;
  readonly storage: boolean;
  readonly gpu: boolean;
}

export interface ComputerCapabilityToggle {
  readonly key: keyof ComputerRoleChoice;
  readonly label: string;
  readonly title?: string;
  readonly on: boolean;
}

/**
 * Gemeldete Fähigkeiten einer Zeile als Schalter (Owner: „wieso kann ich
 * keine GPU auswählen?“). Build und Speicher gibt es für entfernte Rechner,
 * die GPU, sobald sie erkannt oder in der Instanz gemeldet ist. „Lokal“ hat
 * keine Build-/Speicher-Endpunkte; dort bleibt nur die GPU.
 */
export function computerCapabilityToggles(
  metadata: ComputerMetadata | null | undefined,
  native: CtoxWorkjetComputerProjection | null,
): ReadonlyArray<ComputerCapabilityToggle> {
  const remote = metadata?.connection ? metadata.connection._tag !== "local" : !!native?.agentless;
  const nativeHas = (kind: string) => native?.capabilities.includes(kind) ?? false;
  const roles = metadata?.roles ?? { build: nativeHas("build"), storage: nativeHas("storage") };
  const toggles: ComputerCapabilityToggle[] = [];
  // D16: ein agentloser Speicher (NAS) baut nicht; Build nur, wenn gemeldet.
  const canBuild = remote && !(native?.agentless ?? false);
  if (canBuild || roles.build || nativeHas("build"))
    toggles.push({ key: "build", label: "Build", on: roles.build || nativeHas("build") });
  if (remote || roles.storage || nativeHas("storage"))
    toggles.push({ key: "storage", label: "Speicher", on: roles.storage || nativeHas("storage") });
  const facts = metadata?.facts ?? null;
  const detected = facts?.gpus[0] ?? null;
  const saved = native?.capabilityConfig?.find((entry) => entry.kind === "gpu");
  if (detected || nativeHas("gpu")) {
    const model = detected?.model ?? (saved && saved.kind === "gpu" ? saved.model : null);
    const bytes = detected
      ? (detected.vramBytes ?? (detected.unifiedMemory ? (facts?.ramBytes ?? null) : null))
      : null;
    const gib = bytes ? gibOf(bytes) : saved && saved.kind === "gpu" ? saved.vram_gib : null;
    toggles.push({
      key: "gpu",
      label: `GPU${model ? ` ${shortGpuModel(model)}` : ""}${gib ? ` · ${gib} GB` : ""}`,
      ...(model ? { title: model } : {}),
      on: nativeHas("gpu"),
    });
  }
  return toggles;
}

export function computerRoleChoice(
  toggles: ReadonlyArray<ComputerCapabilityToggle>,
): ComputerRoleChoice {
  const on = (key: keyof ComputerRoleChoice) =>
    toggles.find((toggle) => toggle.key === key)?.on ?? false;
  return { build: on("build"), storage: on("storage"), gpu: on("gpu") };
}

/** Fähigkeits-Schalter: Klick schaltet an/aus und speichert sofort (D05, D54). */
function CapabilityToggles({
  toggles,
  disabled,
  onToggle,
}: {
  readonly toggles: ReadonlyArray<ComputerCapabilityToggle>;
  readonly disabled: boolean;
  readonly onToggle: (key: keyof ComputerRoleChoice, on: boolean) => void;
}) {
  return toggles.map((toggle) => (
    <CapabilitySwitch
      key={toggle.key}
      capability={toggle.key}
      label={toggle.label}
      title={toggle.title}
      checked={toggle.on}
      disabled={disabled}
      onCheckedChange={(on) => onToggle(toggle.key, on)}
    />
  ));
}

/**
 * Chips einer Zeile: Rollen (Build, Speicher), erkannte GPU mit Speicher und
 * die CPU-Zahl. Die Kapazität ist abgeleitet (ein Build, alle CPUs) und nur
 * als Hinweis am Build-Chip sichtbar, nie als Eingabe.
 */
export function computerFactChips(
  metadata: ComputerMetadata | null | undefined,
  native: CtoxWorkjetComputerProjection | null,
  capacity: ComputerCapacity | null = null,
  options: { readonly toggles?: boolean } = {},
): ReactNode[] {
  const facts = metadata?.facts ?? null;
  const roles = metadata
    ? metadata.roles
    : {
        build: native?.capabilities.includes("build") ?? false,
        storage: native?.capabilities.includes("storage") ?? false,
      };
  const cpus = capacity?.workersPerBuild ?? facts?.cpuCores ?? null;
  const chips: ReactNode[] = [];
  if (options.toggles) {
    // Build, Speicher und GPU stehen als Schalter-Chips (CapabilityToggles) davor.
    const more = facts?.gpus.slice(1) ?? [];
    if (more.length)
      chips.push(
        <Chip key="gpu-more" title={more.map((entry) => entry.model).join(", ")}>
          +{more.length}
        </Chip>,
      );
    if (facts)
      chips.push(
        <Chip
          key="cpu"
          tone="outline"
          data-workjet-cpu={String(facts.cpuCores)}
          title={`${gibOf(facts.ramBytes)} GB RAM`}
        >
          {facts.cpuCores} CPUs
        </Chip>,
      );
    return chips;
  }
  if (roles.build)
    chips.push(
      <Chip
        key="build"
        data-workjet-capability="build"
        title={cpus ? `1 Build · ${cpus} Jobs` : undefined}
      >
        Build
      </Chip>,
    );
  if (roles.storage)
    chips.push(
      <Chip key="storage" data-workjet-capability="storage">
        Speicher
      </Chip>,
    );
  if (facts) {
    const [gpu, ...more] = facts.gpus;
    if (gpu) {
      const bytes = gpu.vramBytes ?? (gpu.unifiedMemory ? facts.ramBytes : null);
      chips.push(gpuChip("gpu", gpu.model, bytes ? gibOf(bytes) : null, gpu.unifiedMemory));
      if (more.length)
        chips.push(
          <Chip key="gpu-more" title={more.map((entry) => entry.model).join(", ")}>
            +{more.length}
          </Chip>,
        );
    }
    chips.push(
      <Chip
        key="cpu"
        tone="outline"
        data-workjet-cpu={String(facts.cpuCores)}
        title={`${gibOf(facts.ramBytes)} GB RAM`}
      >
        {facts.cpuCores} CPUs
      </Chip>,
    );
  } else {
    const gpu = native?.capabilityConfig?.find((entry) => entry.kind === "gpu");
    if (native?.capabilities.includes("gpu"))
      chips.push(
        gpu && gpu.kind === "gpu" ? (
          gpuChip("gpu", gpu.model, gpu.vram_gib, false)
        ) : (
          <Chip key="gpu" data-workjet-capability="gpu">
            GPU
          </Chip>
        ),
      );
  }
  return chips;
}

/** „Nur Workjet“ bzw. „Auch auf dem Rechner“. */
export type ComputerRemoveMode = "workjet-only" | "workjet-and-files";

export interface ComputerRemoveOutcome {
  readonly tone: "ok" | "error";
  readonly text: string;
}

type ComputerRemoveNotice = ComputerRemoveOutcome & {
  readonly label: string;
  /** Fehler bleiben stehen, bis gehandelt wird, mit genau dieser Aktion (D07). */
  readonly retry?: () => void;
};

type Expansion = { readonly key: string; readonly kind: "repair" | "edit" };

const NOTICE_MS = 5_000;
/** Eine Werkzeugprüfung endet nach 10 s (UI-Vertrag §1.3, D03). */
const PROBE_TIMEOUT_MS = 10_000;
/**
 * Ein grüner Punkt kippt erst nach 30 s anhaltender Störung (FIX-R): ein
 * SSH-Tunnel, der neu aufgebaut wird, oder eine Werkzeugprüfung, die nach dem
 * Wiederverbinden neu läuft, lässt den Punkt sonst zwischen grün und orange
 * springen, obwohl der Dienst durchläuft.
 */
export const COMPUTER_STATUS_HOLD_MS = 30_000;

export interface HeldComputerStatus {
  readonly status: RowStatus;
  readonly statusLabel: string;
  /** Seit wann der Live-Zustand vom gezeigten „ok“ abweicht; null = keine Abweichung. */
  readonly divergedAt: number | null;
}

/**
 * Gezeigter Zustand einer Rechnerzeile: Ein Wechsel weg von „ok“, der nur aus
 * Verbindung oder Werkzeugprüfung kommt (`transient`), wird bis `holdMs`
 * gehalten. Alles andere (inaktiv, eigene Prüfung, Aktualisierung,
 * gespeicherte Erkennung „nicht erreichbar“) und jeder Wechsel zu „ok“ gilt
 * sofort.
 */
export function holdComputerStatus(
  previous: HeldComputerStatus | undefined,
  live: { readonly status: RowStatus; readonly statusLabel: string },
  input: { readonly now: number; readonly transient: boolean; readonly holdMs?: number },
): HeldComputerStatus {
  const holdMs = input.holdMs ?? COMPUTER_STATUS_HOLD_MS;
  if (!previous || previous.status !== "ok" || live.status === "ok" || !input.transient)
    return { ...live, divergedAt: null };
  const divergedAt = previous.divergedAt ?? input.now;
  if (input.now - divergedAt >= holdMs) return { ...live, divergedAt: null };
  return { status: "ok", statusLabel: previous.statusLabel, divergedAt };
}

export function WorkjetComputersSettingsView({
  worktreeStorage = null,
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
  capacities,
  checkingComputerIds,
  onActiveChange,
  onRemove,
  remoteRemoveAvailable = true,
  onRecheck,
  onAssign,
  renderRepair,
  renderEdit,
  onRetryMembership,
  onRolesChange,
  connectionAction,
  onRetryLoad,
  remoteDaemonUpdates,
  onRetryRemoteDaemonUpdate,
}: {
  /** Laufende/fehlgeschlagene Aktualisierung des Workjet-Dienstes je SSH-Ziel. */
  readonly remoteDaemonUpdates?: RemoteDaemonUpdates;
  readonly onRetryRemoteDaemonUpdate?: (row: ComputerMachineRow) => void;
  readonly configuration: WorkjetConfiguration;
  readonly environments: ReadonlyArray<WorkjetEnvironmentTargetOption>;
  readonly environmentsReady: boolean;
  /** Werkzeugprüfung dieses Servers; null bis zur ersten Antwort. */
  readonly harnessInspection?: WorkjetHarnessAvailabilitySnapshot | null;
  readonly harnessInspections?: Readonly<Record<string, ComputerHarnessInspection>>;
  /** Worktree path of this machine, shown in its inline expand (#619). */
  readonly worktreeStorage?: ReactNode;
  readonly environmentId?: EnvironmentId | null;
  readonly onChange: (configuration: WorkjetConfiguration) => void;
  readonly membership?: ComputerMembershipSnapshot | undefined;
  readonly businessOsLabel?: string | null;
  readonly connectedEnvironmentIds?: ReadonlyArray<EnvironmentId>;
  readonly connectingEnvironmentIds?: ReadonlyArray<EnvironmentId>;
  readonly pendingConnectionEnvironmentId?: EnvironmentId | null;
  /** Das Inline-Panel „Rechner hinzufügen“. */
  readonly addPanel?: ReactNode;
  /** Abgeleitete Kapazität je Rechner-ID (nur Anzeige). */
  readonly capacities?: Readonly<Record<string, ComputerCapacity | null>>;
  /** Rechner, deren Erkennung gerade läuft. */
  readonly checkingComputerIds?: ReadonlySet<string>;
  /** Aktiv-Schalter; nur für Rechner mit gespeichertem Eintrag. */
  readonly onActiveChange?: (row: ComputerMachineRow, active: boolean) => void;
  readonly onRemove?: (
    row: ComputerMachineRow,
    mode: ComputerRemoveMode,
  ) => Promise<ComputerRemoveOutcome>;
  /** „Auch auf dem Rechner entfernen“ braucht die Desktop-App. */
  readonly remoteRemoveAvailable?: boolean;
  readonly onRecheck?: (row: ComputerMachineRow) => void;
  readonly onAssign?: ((computer: WorkjetComputer, assigned: boolean) => void) | undefined;
  readonly renderRepair?: (row: ComputerMachineRow, close: () => void) => ReactNode;
  readonly renderEdit?: (row: ComputerMachineRow, close: () => void) => ReactNode;
  readonly onRetryMembership?: (() => void) | undefined;
  /** Build/Speicher/GPU je Zeile umschalten; speichert sofort. */
  readonly onRolesChange?:
    | ((row: ComputerMachineRow, roles: ComputerRoleChoice) => Promise<void>)
    | undefined;
  /** Trennen/Verbinden als eigener ⋯-Eintrag (D14). */
  readonly connectionAction?:
    | ((
        row: ComputerMachineRow,
      ) => { readonly label: string; readonly onSelect: () => void } | null)
    | undefined;
  /** Lädt die Rechnerliste neu, wenn das Laden nach 10 s nicht endet (D17). */
  readonly onRetryLoad?: (() => void) | undefined;
}) {
  const [expansion, setExpansion] = useState<Expansion | null>(null);
  // Sofort sichtbar umgeschaltet, bis die Instanz den neuen Stand meldet.
  const [roleOverrides, setRoleOverrides] = useState<Readonly<Record<string, ComputerRoleChoice>>>(
    {},
  );
  const [savingRoles, setSavingRoles] = useState(emptyIdSet);
  const [removeAsk, setRemoveAsk] = useState<string | null>(null);
  const [removeFiles, setRemoveFiles] = useState(false);
  const [probeExpired, setProbeExpired] = useState(emptyIdSet);
  const [removing, setRemoving] = useState(emptyIdSet);
  // Gezeigter Punkt je Zeile mit 30-s-Haltezeit (FIX-R); der Wecker rendert
  // neu, sobald eine gehaltene Störung die Haltezeit erreicht.
  const heldStatuses = useRef(new Map<string, HeldComputerStatus>());
  const [, setHoldTick] = useState(0);
  useEffect(() => {
    const holdExpiry = [...heldStatuses.current.values()].reduce<number | null>(
      (earliest, held) =>
        held.divergedAt === null
          ? earliest
          : Math.min(earliest ?? Infinity, held.divergedAt + COMPUTER_STATUS_HOLD_MS),
      null,
    );
    if (holdExpiry === null) return;
    const timer = window.setTimeout(
      () => setHoldTick((tick) => tick + 1),
      Math.max(0, holdExpiry - Date.now()) + 50,
    );
    return () => window.clearTimeout(timer);
  });
  const [notices, setNotices] = useState<Readonly<Record<string, ComputerRemoveNotice>>>({});
  const noticeTimers = useRef(new Map<string, number>());
  useEffect(() => {
    const timers = noticeTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
    };
  }, []);
  const showNotice = (key: string, notice: ComputerRemoveNotice) => {
    setNotices((current) => ({ ...current, [key]: notice }));
    const previous = noticeTimers.current.get(key);
    if (previous !== undefined) window.clearTimeout(previous);
    noticeTimers.current.delete(key);
    // Fehler verschwinden nicht von selbst (D07); nur Erfolgszeilen gehen nach 5 s.
    if (notice.tone === "error") return;
    noticeTimers.current.set(
      key,
      window.setTimeout(() => {
        noticeTimers.current.delete(key);
        setNotices((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
      }, NOTICE_MS),
    );
  };
  const runRemove = (row: ComputerMachineRow, label: string, mode: ComputerRemoveMode) => {
    if (!onRemove) return;
    setRemoving((current) => new Set(current).add(row.key));
    const retry = () => runRemove(row, label, mode);
    void onRemove(row, mode)
      .then(
        (outcome) =>
          showNotice(row.key, {
            ...outcome,
            label,
            ...(outcome.tone === "error" ? { retry } : {}),
          }),
        (failure: unknown) =>
          showNotice(row.key, {
            tone: "error",
            text: failure instanceof Error ? failure.message : "Entfernen fehlgeschlagen",
            label,
            retry,
          }),
      )
      .finally(() =>
        setRemoving((current) => {
          const next = new Set(current);
          next.delete(row.key);
          return next;
        }),
      );
  };
  // Während die Instanz neu prüft, bleiben die zuletzt bestätigten Einträge
  // stehen (die Membership-Ablage behält sie für dieselbe Instanz). Zeilen
  // erscheinen und verschwinden nicht; es gibt keinen Text „prüft…“ (D19,
  // Owner-Regel: keine Zustandstexte).
  const natives =
    membership && membership.phase !== "failed"
      ? membership.computers.filter((entry) => entry.status === "assigned")
      : [];
  const membershipUnreachable = useMembershipFailureVisible(membership);
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
  const rowKeys = new Set(rows.map((row) => row.key));
  const toggle = (key: string, kind: Expansion["kind"]) =>
    setExpansion((current) =>
      current?.key === key && current.kind === kind ? null : { key, kind },
    );
  const close = () => setExpansion(null);
  const isRowActive = (row: ComputerMachineRow) =>
    row.computer?.metadata ? row.computer.metadata.active : (row.native?.active ?? true);
  // D03: inaktive Rechner werden nicht geprüft; eine Prüfung endet nach 10 s.
  const probingKeys = rows
    .filter((row) => {
      if (!row.computer || !isRowActive(row)) return false;
      const { connecting, disconnected, inspection, snapshot } = stateFor(row.computer);
      return !disconnected && !connecting && !snapshot && !inspection?.error;
    })
    .map((row) => row.key)
    .join("\n");
  useEffect(() => {
    if (probingKeys === "") return;
    const timer = window.setTimeout(
      () => setProbeExpired(new Set(probingKeys.split("\n"))),
      PROBE_TIMEOUT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [probingKeys]);

  const noticeLine = (key: string, withLabel: boolean) => {
    const notice = notices[key];
    if (!notice) return null;
    return (
      <div
        key={`notice-${key}`}
        role={notice.tone === "error" ? "alert" : "status"}
        data-slot="computer-remove-result"
        className={cn(
          "flex flex-wrap items-center gap-2 px-3 pb-2 pl-8 text-xs",
          notice.tone === "error" ? "text-destructive" : "text-muted-foreground",
          withLabel && "pt-2",
        )}
      >
        <span className="min-w-0">
          {withLabel ? `${notice.label}: ${notice.text}` : notice.text}
        </span>
        {notice.tone === "error" && notice.retry ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setNotices((current) => {
                const next = { ...current };
                delete next[key];
                return next;
              });
              notice.retry?.();
            }}
          >
            Erneut versuchen
          </Button>
        ) : null}
      </div>
    );
  };

  // D18: Fehler als eine Zeile unter dem Titel mit genau einer Aktion, kein Chip.
  const membershipError = membershipUnreachable ? (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2 pb-2 text-xs text-destructive"
      data-slot="computer-membership-error"
    >
      <span>Rechnerliste nicht abrufbar</span>
      {onRetryMembership ? (
        <Button size="xs" variant="outline" onClick={onRetryMembership}>
          Erneut versuchen
        </Button>
      ) : null}
    </div>
  ) : null;

  return (
    <SettingsSection
      id={searchableSetting("workjet-computers").id}
      title={searchableSetting("workjet-computers").title}
    >
      {membershipError}
      <div
        className="divide-y divide-border/60 border-y border-border/60"
        data-workjet-computers-table
      >
        {rows.map((row) => {
          const { computer, native } = row;
          const metadata = computer?.metadata ?? null;
          const active = isRowActive(row);
          const label = computer?.label ?? native?.displayName ?? row.key;
          let status: RowStatus = "off";
          let statusLabel = "Getrennt";
          let meta: ReactNode = null;
          const toggles = onRolesChange
            ? computerCapabilityToggles(metadata, native).map((toggle) => ({
                ...toggle,
                on: roleOverrides[row.key]?.[toggle.key] ?? toggle.on,
              }))
            : [];
          const chips: ReactNode[] = [
            ...(toggles.length && onRolesChange
              ? [
                  <CapabilityToggles
                    key="capabilities"
                    toggles={toggles}
                    disabled={savingRoles.has(row.key) || !active}
                    onToggle={(key, on) => {
                      const next = { ...computerRoleChoice(toggles), [key]: on };
                      setRoleOverrides((current) => ({ ...current, [row.key]: next }));
                      setSavingRoles((current) => new Set(current).add(row.key));
                      void onRolesChange(row, next)
                        .catch(() =>
                          // Nicht gespeichert: der Chip springt still zurück.
                          setRoleOverrides((current) => {
                            const { [row.key]: _dropped, ...rest } = current;
                            return rest;
                          }),
                        )
                        .finally(() =>
                          setSavingRoles((current) => {
                            const rest = new Set(current);
                            rest.delete(row.key);
                            return rest;
                          }),
                        );
                    }}
                  />,
                ]
              : []),
            ...computerFactChips(
              metadata,
              native,
              computer ? (capacities?.[computer.id] ?? null) : null,
              { toggles: !!onRolesChange },
            ),
          ];
          const busyRow =
            (computer !== null && checkingComputerIds?.has(computer.id) === true) ||
            removing.has(row.key) ||
            savingRoles.has(row.key);
          if (computer) {
            const { connecting, disconnected, inspection, snapshot } = stateFor(computer);
            const target = environments.find(
              (entry) => entry.environmentId === computer.environmentId,
            );
            const checking =
              !environmentsReady || computer.environmentId === pendingConnectionEnvironmentId;
            // Kein „prüft…“/„verbindet…“ als Text mehr: der Punkt trägt den Zustand.
            const unreachable = metadata?.status === "unreachable";
            const toolsFailed = !disconnected && !connecting && !snapshot && !!inspection?.error;
            const probingNow =
              active && !disconnected && !connecting && !snapshot && !inspection?.error;
            const probeTimedOut = probingNow && probeExpired.has(row.key);
            const probing = probingNow && !probeTimedOut;
            status = !active
              ? "off"
              : checking || connecting || busyRow || probing
                ? "busy"
                : unreachable || toolsFailed || probeTimedOut
                  ? "error"
                  : disconnected
                    ? "off"
                    : "ok";
            statusLabel = !active
              ? "Inaktiv"
              : checking || busyRow || probing
                ? "Prüft"
                : connecting
                  ? "Verbindet"
                  : unreachable
                    ? "Nicht erreichbar"
                    : toolsFailed || probeTimedOut
                      ? "Werkzeuge nicht prüfbar"
                      : disconnected
                        ? "Getrennt"
                        : "Verbunden";
            // Aktualisierung des Dienstes: nur der Punkt (orange), kein Satz.
            const updating =
              active &&
              remoteDaemonUpdateFor(remoteDaemonUpdates, metadata?.connection) === "updating";
            if (updating) status = "busy";
            // Kurze Aussetzer der Verbindung oder eine erneute Werkzeugprüfung
            // schalten den Punkt erst nach 30 s um (FIX-R Punkt 1/2).
            const held = holdComputerStatus(
              heldStatuses.current.get(row.key),
              { status, statusLabel },
              {
                now: Date.now(),
                transient: active && !busyRow && !updating && !unreachable,
              },
            );
            heldStatuses.current.set(row.key, held);
            status = held.status;
            statusLabel = held.statusLabel;
            meta =
              computer.environmentId === environmentId
                ? "Dieser Rechner"
                : target
                  ? [target.label !== computer.label ? target.label : null, target.detail]
                      .filter((part): part is string => !!part)
                      .join(" · ")
                  : computer.presentationKind === "local"
                    ? "Lokal"
                    : null;
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
                  <Chip
                    key="tool-more"
                    tone="outline"
                    title={tools
                      .slice(3)
                      .map((declared) => workjetHarnessDisplayLabel(declared.harness))
                      .join(", ")}
                  >
                    +{tools.length - 3}
                  </Chip>,
                );
            }
            if (configuration.selectedComputerId === computer.id)
              chips.push(
                <Chip key="current" tone="outline" data-slot="computer-current">
                  Standard
                </Chip>,
              );
          } else if (native) {
            status = "off";
            statusLabel = "Nur Instanz";
            // D16: kein doppeltes „Speicher“ neben dem Schalter.
            meta = native.agentless ? null : "Instanz";
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
          const connection = connectionAction?.(row) ?? null;
          if (connection) menuActions.push(connection);
          if (onRecheck) menuActions.push({ label: "Neu prüfen", onSelect: () => onRecheck(row) });
          // D10: ein klarer Begriff, „Standard“, statt „aktuell“/„nicht mehr aktuell“.
          if (computer)
            menuActions.push({
              label:
                configuration.selectedComputerId === computer.id ? "Kein Standard" : "Als Standard",
              onSelect: () => onChange(toggleCurrentComputer(configuration, computer.id)),
            });
          if (computer && !native && onAssign && membership?.phase === "ready")
            menuActions.push({
              label: "Zur Instanz hinzufügen",
              onSelect: () => onAssign(computer, true),
            });

          // Papierkorb: die Frage, ob auch auf dem Rechner entfernt werden soll.
          const remoteComputer =
            computer !== null &&
            (metadata?.connection
              ? metadata.connection._tag !== "local"
              : computer.presentationKind !== "local");
          const deleteOptions: RowDeleteOption[] = onRemove
            ? [
                {
                  label: "Nur Workjet",
                  disabled: removing.has(row.key),
                  onSelect: () => runRemove(row, label, "workjet-only"),
                },
                ...(remoteComputer
                  ? [
                      {
                        label: "Auch auf dem Rechner",
                        disabled:
                          removing.has(row.key) ||
                          !remoteRemoveAvailable ||
                          !metadata?.facts ||
                          !metadata.connection,
                        onSelect: () => runRemove(row, label, "workjet-and-files"),
                      },
                    ]
                  : []),
              ]
            : [];

          if (deleteOptions.length)
            menuActions.push({
              label: "Entfernen",
              destructive: true,
              onSelect: () => {
                setRemoveFiles(false);
                setRemoveAsk(row.key);
              },
            });
          const expanded = expansion?.key === row.key ? expansion.kind : null;
          return (
            <Fragment key={row.key}>
              <div
                {...(computer
                  ? { "data-workjet-computer": computer.id }
                  : { "data-workjet-native-computer": native?.id ?? row.key })}
                data-active={active ? "true" : "false"}
                className={cn(!active && "opacity-55")}
              >
                <Row
                  className="flex-wrap sm:flex-nowrap max-sm:[&>div:has(>[data-slot=row-name])]:basis-[calc(100%-1.25rem)] max-sm:[&>[data-slot=row-open]]:basis-[calc(100%-1.25rem)] max-sm:[&>[data-slot=row-chips]]:flex-1 max-sm:[&>[data-slot=row-chips]]:shrink max-sm:[&>[data-slot=row-chips]]:flex-wrap max-sm:[&>[data-slot=row-chips]]:pl-5 max-sm:[&>[data-slot=row-actions]]:ml-auto max-sm:[&>[data-slot=row-actions]]:max-w-full max-sm:[&>[data-slot=row-actions]]:flex-wrap max-sm:[&_[data-slot=row-confirm]]:min-w-0 max-sm:[&_[data-slot=row-confirm]]:flex-wrap"
                  status={status}
                  statusLabel={statusLabel}
                  name={label}
                  meta={meta}
                  chips={
                    <span className="flex min-w-0 flex-wrap items-center gap-1 max-sm:flex-1">
                      {chips}
                    </span>
                  }
                  {...(onActiveChange
                    ? {
                        active,
                        activeLabel: `${label} aktiv`,
                        // Ohne Metadaten bleibt der Schalter sichtbar, aber gesperrt:
                        // jede Zeile hat dieselbe Spalte.
                        activeDisabled: !computer || !metadata,
                        onActiveChange: (checked: boolean) => onActiveChange(row, checked),
                      }
                    : {})}
                  menuActions={menuActions}
                  menuLabel={`Weitere Aktionen für ${label}`}
                  {...(computer && renderEdit
                    ? {
                        expanded: expanded === "edit",
                        onToggleExpanded: () => toggle(row.key, "edit"),
                      }
                    : {})}
                />
              </div>
              {computer &&
              remoteDaemonUpdateFor(remoteDaemonUpdates, metadata?.connection) === "failed" ? (
                <div
                  role="alert"
                  data-slot="computer-update-failed"
                  className="flex flex-wrap items-center gap-2 px-3 pb-2 pl-8 text-xs text-destructive"
                >
                  <span className="min-w-0">Aktualisierung fehlgeschlagen</span>
                  {onRetryRemoteDaemonUpdate ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => onRetryRemoteDaemonUpdate(row)}
                    >
                      Erneut
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {removeAsk === row.key && deleteOptions.length ? (
                // D12: eine destructive Aktion plus Haken für die Dateien auf dem Rechner.
                <div
                  className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5 px-3 pb-2"
                  data-slot="computer-remove-confirm"
                  role="group"
                  aria-label={`${label} entfernen`}
                >
                  {deleteOptions.length > 1 ? (
                    <label className="flex items-center gap-1.5 text-xs has-disabled:opacity-64">
                      <Checkbox
                        checked={removeFiles}
                        disabled={deleteOptions[1]!.disabled === true}
                        onCheckedChange={(checked) => setRemoveFiles(checked === true)}
                      />
                      Auch Dateien auf dem Rechner
                    </label>
                  ) : null}
                  <span className="flex items-center gap-1.5">
                    <Button size="xs" variant="outline" onClick={() => setRemoveAsk(null)}>
                      Abbrechen
                    </Button>
                    <Button
                      size="xs"
                      variant="destructive"
                      disabled={removing.has(row.key)}
                      onClick={() => {
                        const option =
                          removeFiles && deleteOptions.length > 1
                            ? deleteOptions[1]!
                            : deleteOptions[0]!;
                        setRemoveAsk(null);
                        option.onSelect();
                      }}
                    >
                      Entfernen
                    </Button>
                  </span>
                </div>
              ) : null}
              {noticeLine(row.key, false)}
              {renderRepair ? (
                <InlineExpand
                  label={`${label} reparieren`}
                  open={expanded === "repair"}
                  onOpenChange={(open) => {
                    if (!open && expanded === "repair") close();
                  }}
                >
                  <div className="px-3 pb-3 pl-8" data-slot="computer-repair">
                    {expanded === "repair" ? renderRepair(row, close) : null}
                  </div>
                </InlineExpand>
              ) : null}
              {renderEdit && computer ? (
                <InlineExpand
                  hideCollapseControl
                  label={label}
                  open={expanded === "edit"}
                  onOpenChange={(open) => {
                    if (!open && expanded === "edit") close();
                  }}
                >
                  <div className="space-y-3 px-3 pb-3 pl-8" data-slot="computer-edit">
                    {expanded === "edit" ? renderEdit(row, close) : null}
                    {expanded === "edit" && computer.environmentId === environmentId
                      ? worktreeStorage
                      : null}
                  </div>
                </InlineExpand>
              ) : null}
            </Fragment>
          );
        })}
        {Object.keys(notices)
          .filter((key) => !rowKeys.has(key))
          .map((key) => noticeLine(key, true))}
        {rows.length === 0 ? (
          // D17: Leerzustand als ui/empty; „Rechner hinzufügen“ steht direkt darunter.
          environmentsReady ? (
            <Empty className="py-6" data-slot="computers-empty">
              <EmptyHeader>
                <EmptyTitle className="text-[13.5px]">Noch keine Rechner</EmptyTitle>
              </EmptyHeader>
            </Empty>
          ) : (
            <EmptyLoading
              className="py-6"
              title="Rechner werden geladen …"
              slowMessage="Rechner nicht geladen"
              {...(onRetryLoad ? { onRetry: onRetryLoad } : {})}
            />
          )
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

export type ComputerControl = NonNullable<DesktopBridge["controlComputers"]>;

/** Datensatz des Backends zu einem Rechner, auch unter einer früheren ID. */
export function computerRecordFor(
  records: ReadonlyArray<ComputerRecord>,
  id: string,
): ComputerRecord | undefined {
  return (
    records.find((record) => record.id === id) ??
    records.find((record) => record.metadata.previousIds.includes(id))
  );
}

/**
 * Umgebungen, deren Rechnerzeile als verbunden gilt. „Dieser Rechner“ ist die
 * Umgebung, über die diese App selbst läuft: Hat ihr Verbindungsaufseher
 * gerade keinen Zustand („available“, etwa während die Registrierung den
 * Aufseher neu anlegt), läuft die App trotzdem; nur ein echter Aufbau,
 * Abbruch oder Fehler zählt (FIX-R Punkt 2). Entfernte Rechner brauchen eine
 * bestehende Verbindung.
 */
export function computerOnlineEnvironmentIds(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly connection: { readonly phase: string };
  }>,
  primaryEnvironmentId: EnvironmentId | null,
): EnvironmentId[] {
  return environments
    .filter(
      (entry) =>
        entry.connection.phase === "connected" ||
        (entry.environmentId === primaryEnvironmentId && entry.connection.phase === "available"),
    )
    .map((entry) => entry.environmentId);
}

/**
 * Gespeicherte Rechner mit dem jüngsten Stand des Backends (Erkennung,
 * Rollen, aktiv) und dem gerade umgelegten Aktiv-Schalter.
 */
export function withComputerRecords(
  configuration: WorkjetConfiguration,
  records: ReadonlyArray<ComputerRecord>,
  pendingActive: Readonly<Record<string, boolean>> = {},
): WorkjetConfiguration {
  if (records.length === 0 && Object.keys(pendingActive).length === 0) return configuration;
  return {
    ...configuration,
    computers: configuration.computers.map((computer) => {
      const metadata = computerRecordFor(records, computer.id)?.metadata ?? computer.metadata;
      if (!metadata) return computer;
      const pending = pendingActive[computer.id];
      return {
        ...computer,
        metadata: pending === undefined ? metadata : { ...metadata, active: pending },
      };
    }),
  };
}

/** Aktiv/Inaktiv dauerhaft im Backend; ohne Desktop-App oder Eintrag nichts. */
export async function changeComputerActive(input: {
  readonly control: ComputerControl | undefined;
  readonly row: ComputerMachineRow;
  readonly active: boolean;
}): Promise<ComputerControlResult | null> {
  if (!input.control || !input.row.computer) return null;
  return input.control({ _tag: "setActive", id: input.row.computer.id, active: input.active });
}

/** Eine Zeile Ergebnis: „3 Pfade entfernt“ oder die Pfade, die blieben. */
export function removedPathsSummary(
  paths: ComputerControlResult["removedPaths"],
): ComputerRemoveOutcome {
  const plural = (count: number) => (count === 1 ? "Pfad" : "Pfade");
  const failed = paths.filter((path) => path.status === "failed" || path.status === "refused");
  if (failed.length > 0)
    return { tone: "error", text: `${failed.length} ${plural(failed.length)} nicht entfernt` };
  const removed = paths.filter((path) => path.status === "removed").length;
  return { tone: "ok", text: `${removed} ${plural(removed)} entfernt` };
}

/**
 * Papierkorb einer Zeile: zuerst aus der Instanz austragen, dann den
 * Rechner im Backend entfernen (mit oder ohne Dateien), zuletzt die nicht
 * mehr gebrauchte Verbindung. Bleiben Pfade stehen, bleibt der Rechner
 * (inaktiv) und die Verbindung erhalten.
 */
export async function removeComputerRow(input: {
  readonly row: ComputerMachineRow;
  readonly mode: ComputerRemoveMode;
  readonly control: ComputerControl | undefined;
  /** Austragen aus der Instanz; Fehlertext oder null. */
  readonly unassign: ((nativeId: string) => Promise<string | null>) | null;
  /** Verbindung entfernen, wenn sie sonst niemand nutzt; Fehlertext oder null. */
  readonly removeConnection: (computer: WorkjetComputer) => Promise<string | null>;
  /** Ohne Desktop-App: nur die gespeicherte Konfiguration ändern. */
  readonly removeWithoutBackend: (computer: WorkjetComputer) => Promise<string | null>;
}): Promise<ComputerRemoveOutcome> {
  const removedFromWorkjet: ComputerRemoveOutcome = { tone: "ok", text: "Aus Workjet entfernt" };
  if (input.row.native && input.unassign) {
    const failure = await input.unassign(input.row.native.id);
    if (failure) return { tone: "error", text: failure };
  }
  const computer = input.row.computer;
  if (!computer) return removedFromWorkjet;
  if (!input.control) {
    if (input.mode === "workjet-and-files")
      return { tone: "error", text: "Nur mit der Desktop-App" };
    const failure = await input.removeWithoutBackend(computer);
    return failure ? { tone: "error", text: failure } : removedFromWorkjet;
  }
  let result: ComputerControlResult;
  try {
    result = await input.control({ _tag: "remove", id: computer.id, mode: input.mode });
  } catch {
    return {
      tone: "error",
      text:
        input.mode === "workjet-and-files"
          ? "Auf dem Rechner nicht entfernbar"
          : "Entfernen fehlgeschlagen",
    };
  }
  const summary =
    input.mode === "workjet-and-files" ? removedPathsSummary(result.removedPaths) : null;
  if (summary?.tone === "error") return summary;
  const failure = await input.removeConnection(computer);
  if (failure) return { tone: "error", text: failure };
  return summary ?? removedFromWorkjet;
}

/** Die Verbindung, über die das Backend den Rechner erkennt. */
/** Schmaler Desktop-Kanal (preload `workjetComputerKeys`) für den Schlüsseleintrag. */
interface ComputerKeysBridge {
  readonly install: (target: {
    alias: string;
    hostname: string;
    username: string | null;
    port: number | null;
  }) => Promise<{ readonly ok: boolean; readonly message: string }>;
}
function computerKeysBridge(): ComputerKeysBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { workjetComputerKeys?: ComputerKeysBridge }).workjetComputerKeys;
}

/** Steht der Eintrag der Quellenliste schon als Rechner in der Liste? */
export function isKnownComputer(
  computers: ReadonlyArray<WorkjetComputer>,
  candidate: MachineCandidate,
  localEnvironmentId: EnvironmentId | null,
): boolean {
  return knownComputerFor(computers, candidate, localEnvironmentId) !== null;
}

/**
 * Steht der Rechner eines Beitritts schon verbunden in der Liste? Dann ist die
 * Fortschrittszeile des Beitritts überflüssig (FIX-R Punkt 3).
 */
export function isListedOnlineComputer(
  computers: ReadonlyArray<WorkjetComputer>,
  candidate: MachineCandidate,
  localEnvironmentId: EnvironmentId | null,
  onlineEnvironmentIds: ReadonlyArray<EnvironmentId>,
  environmentTargets: ReadonlyMap<EnvironmentId, ComputerSshTarget> = new Map(),
): boolean {
  const known = knownComputerFor(computers, candidate, localEnvironmentId);
  if (known !== null && onlineEnvironmentIds.includes(known.environmentId)) return true;
  // Frisch angelegt hat die Zeile noch keine erkannte Verbindung: dann zählt
  // das SSH-Ziel ihrer verbundenen Umgebung.
  if (candidate.transport === "local") return false;
  return computers.some((computer) => {
    if (!onlineEnvironmentIds.includes(computer.environmentId)) return false;
    const target = environmentTargets.get(computer.environmentId);
    return (
      target !== undefined &&
      ((candidate.host !== null && target.hostname === candidate.host) ||
        (candidate.sshAlias !== null && target.alias === candidate.sshAlias))
    );
  });
}

type ComputerSshTarget = Extract<ComputerConnection, { readonly _tag: "ssh" }>["target"];

/** SSH-Ziel je verbundener Umgebung aus dem Verbindungskatalog. */
export function environmentSshTargets(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly entry: { readonly profile: Option.Option<unknown> };
  }>,
): ReadonlyMap<EnvironmentId, ComputerSshTarget> {
  const targets = new Map<EnvironmentId, ComputerSshTarget>();
  for (const environment of environments) {
    const profile = environment.entry.profile;
    if (Option.isNone(profile)) continue;
    const value = profile.value as {
      readonly _tag?: string;
      readonly target?: ComputerSshTarget;
    };
    if (value._tag === "SshConnectionProfile" && value.target)
      targets.set(environment.environmentId, value.target);
  }
  return targets;
}

/**
 * Erkennung für eine verbundene Zeile ohne Fakten (FIX-R Punkt 4). Eine
 * Verbindung, die ohne gespeicherten Rechner in der Liste steht (Zeile aus dem
 * Verbindungskatalog) oder deren Erkennung beim Hinzufügen abriss, hat sonst
 * nie Fakten: keine Build-/Speicher-/GPU-Chips, obwohl die Probe auf dem
 * Rechner die GPU findet. null = nichts zu tun.
 */
export function computerDetectionRequest(
  computer: WorkjetComputer,
  input: {
    readonly online: boolean;
    readonly primaryEnvironmentId: EnvironmentId | null;
    readonly target: ComputerSshTarget | null;
  },
): ComputerControlInput | null {
  const metadata = computer.metadata;
  if (!input.online || metadata?.facts || metadata?.active === false) return null;
  if (metadata?.connection) return { _tag: "recheck", id: computer.id };
  const connection: ComputerConnection | null =
    computer.environmentId === input.primaryEnvironmentId
      ? { _tag: "local" }
      : input.target
        ? {
            _tag: computer.presentationKind === "tailscale" ? "tailscale" : "ssh",
            target: input.target,
          }
        : null;
  if (!connection) return null;
  return {
    _tag: "add",
    id: computer.id,
    label: computer.label,
    environmentId: computer.environmentId,
    connection,
  };
}

function knownComputerFor(
  computers: ReadonlyArray<WorkjetComputer>,
  candidate: MachineCandidate,
  localEnvironmentId: EnvironmentId | null,
): WorkjetComputer | null {
  return (
    computers.find((entry) => {
      if (candidate.transport === "local") return entry.environmentId === localEnvironmentId;
      const connection = entry.metadata?.connection;
      if (!connection || connection._tag === "local") return false;
      return (
        connection.target.hostname === candidate.host ||
        (candidate.sshAlias !== null && connection.target.alias === candidate.sshAlias)
      );
    }) ?? null
  );
}

export function computerConnectionFor(request: AddComputerRequest): ComputerConnection {
  if (request.kind === "local" || !request.target) return { _tag: "local" };
  const port = request.target.port;
  return {
    _tag: request.kind,
    target: {
      alias: request.target.alias,
      hostname: request.target.hostname,
      username: request.target.username,
      port: port && Number.isInteger(port) && port > 0 && port <= 65535 ? port : null,
    },
  };
}

/** Schon erkannte Fakten für das Hinzufügen-Panel (Local oder eine Adresse). */
export function knownComputerFacts(
  computers: ReadonlyArray<WorkjetComputer>,
  kind: AddComputerKind,
  hostname: string | null,
  localEnvironmentId: EnvironmentId | null,
): KnownComputerFacts | null {
  const wanted = hostname?.trim().toLowerCase() ?? null;
  const match = computers.find((computer) => {
    const connection = computer.metadata?.connection;
    if (kind === "local")
      return connection?._tag === "local" || computer.environmentId === localEnvironmentId;
    if (!wanted || !connection || connection._tag === "local") return false;
    return (
      connection.target.hostname.toLowerCase() === wanted ||
      connection.target.alias.toLowerCase() === wanted
    );
  });
  if (!match?.metadata) return null;
  return { facts: match.metadata.facts, identityFiles: match.metadata.identityFiles };
}

const PENDING_COMPUTER_TIMEOUT_MS = 90_000;

function PrimaryWorktreeStorage({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const storage = useAutomaticWorktreeStorage(environmentId, settings.automaticWorktreeRoot, label);
  return <WorktreeStorageInline storage={storage} />;
}

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
  // „Rechner hinzufügen“ von anderswo (z. B. Netzdiagramm): Panel offen starten.
  const [addOpen] = useState(() => {
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
  const connections = useComputerConnections({
    discoverSshHosts: addOpen || setupOnly,
  });
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const [remoteDaemonUpdates, setRemoteDaemonUpdate] = useRemoteDaemonUpdates(bridge);
  // „Erneut“: ein neues Ensure startet den Aktualisierungsversuch des Dienstes neu.
  const retryRemoteDaemonUpdate = (row: ComputerMachineRow) => {
    const target = remoteDaemonTarget(row.computer?.metadata?.connection);
    if (!target || !bridge) return;
    const key = remoteDaemonUpdateKey(target);
    setRemoteDaemonUpdate(key, null);
    void bridge.ensureSshEnvironment(target).catch(() => setRemoteDaemonUpdate(key, "failed"));
  };
  // Rechner-Backend (Desktop): Erkennung, Rollen, aktiv, Entfernen.
  const control = useMemo<ComputerControl | undefined>(
    () =>
      bridge?.controlComputers
        ? (input: ComputerControlInput) => bridge.controlComputers!(input)
        : undefined,
    [bridge],
  );
  const [records, setRecords] = useState<ReadonlyArray<ComputerRecord>>([]);
  const [pendingActive, setPendingActive] = useState<Readonly<Record<string, boolean>>>({});
  const [checkingComputerIds, setCheckingComputerIds] = useState(emptyIdSet);
  const runControl = useCallback(
    async (input: ComputerControlInput): Promise<ComputerControlResult> => {
      if (!control) throw new Error("Nur mit der Desktop-App");
      const result = await control(input);
      setRecords(result.computers);
      return result;
    },
    [control],
  );
  // Neu lesen, sobald sich die gespeicherten Rechner ändern (z. B. nach einer
  // Erkennung im Hintergrund). Der Schlüssel hält die Abfrage ruhig.
  const settingsComputersKey = JSON.stringify(
    settings.workjet.computers.map((computer) => [
      computer.id,
      computer.metadata?.active,
      computer.metadata?.roles,
      computer.metadata?.status,
      computer.metadata?.facts?.checkedAt,
    ]),
  );
  useEffect(() => {
    if (!control) return;
    let current = true;
    void control({ _tag: "list" }).then(
      (result) => {
        if (current) setRecords(result.computers);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [control, settingsComputersKey]);

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
  const configuration = withComputerRecords(
    includeSavedComputers(settings.workjet, targetOptions, environmentId),
    records,
    pendingActive,
  );
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
  // Verbundene Zeilen ohne Fakten einmal je Sitzung still erkennen (FIX-R
  // Punkt 4); das Ergebnis kommt über die Rechnerliste zurück. Läuft das
  // Hinzufügen gerade, erkennt dessen eigener Schritt.
  const autoDetected = useRef(new Set<string>());
  const onlineIds = computerOnlineEnvironmentIds(environments, environmentId);
  const sshTargets = environmentSshTargets(environments);
  const autoDetectRequests =
    control && pending === null && !connections.busy
      ? configuration.computers.flatMap((computer) => {
          if (autoDetected.current.has(computer.id)) return [];
          const request = computerDetectionRequest(computer, {
            online: onlineIds.includes(computer.environmentId),
            primaryEnvironmentId: environmentId,
            target: sshTargets.get(computer.environmentId) ?? null,
          });
          return request ? [request] : [];
        })
      : [];
  const autoDetectKey = autoDetectRequests.map((request) => JSON.stringify(request)).join("\n");
  useEffect(() => {
    for (const request of autoDetectRequests) {
      if (request._tag === "list" || !("id" in request)) continue;
      if (autoDetected.current.has(request.id)) continue;
      autoDetected.current.add(request.id);
      void runControl(request).catch(() => undefined);
    }
    // autoDetectKey trägt den Inhalt von autoDetectRequests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoDetectKey, runControl]);

  const enrollRemoteComputer = useAtomCommand(serverEnvironment.enrollWorkjetRemoteComputer, {
    reportFailure: false,
  });
  const workerConnections = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.workjetDecisionHubConnections({ environmentId, input: {} }),
  );

  const rolesAvailable = !!selectedInstanceId && activeMembership?.phase === "ready";

  const addComputer = async (
    request: AddComputerRequest,
    progress?: (step: string) => void,
    phase?: AddComputerPhase,
  ): Promise<AddComputerOutcome & { readonly environmentId?: EnvironmentId }> => {
    // 1. Verbinden (SSH: ensureEnvironment kopiert und startet den Workjet-Dienst).
    let connected: EnvironmentId;
    phase?.("transport_connected", "running");
    if (request.kind === "local") {
      if (environmentId === null || !localAvailable)
        return { status: "error", message: "Dieser Rechner ist nicht verbunden." };
      connected = environmentId;
    } else {
      if (!request.target) return { status: "error", message: "Adresse fehlt." };
      const stopProgress = phase
        ? watchSshEnvironmentProgress(bridge, request.target, phase)
        : () => undefined;
      const result = await connections
        .connectSsh(request.target, request.label)
        .finally(stopProgress);
      if (!result.ok) return { status: "error", message: result.message ?? "Abgebrochen." };
      connected = result.environmentId;
    }
    phase?.("transport_connected", "done");
    phase?.("package_copied", "done");
    // 2. Werkzeuge prüfen und den Rechner anlegen (oder den bekannten nehmen).
    phase?.("installed", "running");
    let computer: WorkjetComputer;
    try {
      computer = await waitForComputer(connected, request.kind);
    } catch (failure) {
      return {
        status: "error",
        message: failure instanceof Error ? failure.message : "Werkzeuge nicht prüfbar.",
      };
    }
    phase?.("installed", "done");
    // 3. Erkennen (CPU, RAM, GPU, Platte, Werkzeuge) und die Haken speichern.
    phase?.("service_started", "running");
    let facts: ComputerFacts | null = null;
    if (control) {
      progress?.("Erkennt Rechner…");
      // Dieser Schritt erkennt selbst; die stille Erkennung lässt ihn aus.
      autoDetected.current.add(computer.id);
      try {
        const result = await runControl({
          _tag: "add",
          id: computer.id,
          label: request.label || computer.label,
          environmentId: computer.environmentId,
          connection: computerConnectionFor(request),
        });
        const record = computerRecordFor(result.computers, computer.id);
        facts = record?.metadata.facts ?? null;
        if (
          record &&
          request.kind !== "local" &&
          rolesAvailable &&
          (record.metadata.roles.build !== request.roles.build ||
            record.metadata.roles.storage !== request.roles.storage)
        )
          await runControl({
            _tag: "setRoles",
            id: record.id,
            roles: { build: request.roles.build, storage: request.roles.storage },
          });
      } catch {
        return { status: "error", message: "Erkennung fehlgeschlagen." };
      }
    }
    phase?.("service_started", "done");
    phase?.("device_bound", "running");
    const enrolled = await enrollInInstance(request, connected, computer, facts);
    if (enrolled.status !== "error") phase?.("device_bound", "done");
    return enrolled.status === "error" ? enrolled : { ...enrolled, environmentId: connected };
  };

  /** Schritt 4: in der gewählten Instanz eintragen, mit Build/Speicher/GPU. */
  const enrollInInstance = async (
    request: AddComputerRequest,
    connected: EnvironmentId,
    computer: WorkjetComputer,
    facts: ComputerFacts | null,
  ): Promise<AddComputerOutcome> => {
    if (!selectedInstanceId) return { status: "done" };
    const snapshot = membershipStore.getSnapshot();
    const wantsRoles = request.roles.build || request.roles.storage;
    if (snapshot.instanceId !== selectedInstanceId || snapshot.phase !== "ready") {
      return wantsRoles
        ? { status: "error", message: "Instanz prüft noch. Erneut versuchen." }
        : { status: "done" };
    }
    const native = snapshot.computers.find((entry) => entry.id === computer.id) ?? null;
    // „Wenn eine GPU da ist, kann sie benutzt werden“: erkannt oder schon
    // gespeichert gilt als angehakt, außer der Haken wurde bewusst entfernt.
    const roles = {
      ...request.roles,
      gpu: request.gpuDecided
        ? request.roles.gpu
        : request.roles.gpu ||
          gpuDetected(facts) ||
          (native?.capabilities.includes("gpu") ?? false),
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
        facts,
        cpuCount:
          request.kind === "local" && typeof navigator !== "undefined"
            ? navigator.hardwareConcurrency
            : null,
      });
      // „Local“ hat keine Haken für Build und Speicher: Gespeichertes bleibt.
      if (
        request.kind === "local" &&
        native?.capabilityConfig?.some((capability) => capability.kind !== "gpu") &&
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
        if (!source) return { status: "error", message: "Presets der Instanz nicht abrufbar." };
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

  /** Build/Speicher/GPU einer Zeile sofort speichern (derselbe Weg wie beim Hinzufügen). */
  const saveRoles = async (row: ComputerMachineRow, roles: ComputerRoleChoice) => {
    const computer = row.computer;
    if (!computer) throw new Error("Rechner fehlt.");
    const metadata = computer.metadata ?? null;
    const connection = metadata?.connection ?? null;
    const target = connection && connection._tag !== "local" ? connection.target : null;
    const kind: AddComputerKind =
      connection?._tag ?? (computer.presentationKind === "local" ? "local" : "ssh");
    let hostKey: AddComputerRequest["hostKey"] = null;
    if (target && (roles.build || roles.storage) && bridge?.inspectProvisioningHostKey) {
      // Erkennen statt fragen: der Host-Schlüssel des schon verbundenen Rechners.
      const inspected = await bridge.inspectProvisioningHostKey({
        _tag: "ssh",
        ssh: {
          alias: target.alias,
          hostname: target.hostname,
          username: target.username,
          port: target.port ?? 22,
        },
      });
      if (inspected._tag !== "ready") throw new Error("Host-Schlüssel nicht lesbar.");
      hostKey = { algorithm: inspected.algorithm, fingerprint: inspected.fingerprint };
    }
    if (control && kind !== "local")
      await runControl({
        _tag: "setRoles",
        id: computer.id,
        roles: { build: roles.build, storage: roles.storage },
      });
    const outcome = await enrollInInstance(
      {
        kind,
        target,
        label: computer.label,
        roles,
        hostKey,
        identityFile: metadata?.identityFiles[0] ?? null,
        gpuDecided: true,
      },
      computer.environmentId,
      computer,
      metadata?.facts ?? null,
    );
    if (outcome.status === "error") throw new Error(outcome.message);
  };

  // Ein-Klick-Beitritt (sync v4 §16.41) über den heutigen Installationsweg.
  const localComputer =
    environmentId === null
      ? null
      : (configuration.computers.find((entry) => entry.environmentId === environmentId) ?? null);
  const machineEnrollment = useMachineEnrollment({
    listSshHosts: () =>
      bridge?.discoverSshHosts
        ? bridge.discoverSshHosts()
        : Promise.resolve(connections.sshAliases),
    discoverTailscalePeers: bridge?.discoverTailscalePeers
      ? () => bridge.discoverTailscalePeers()
      : undefined,
    localName: localAvailable ? (localComputer?.label ?? "Dieser Rechner") : null,
    installKey: computerKeysBridge()?.install,
    add: (request, phase) => addComputer(request, undefined, phase),
    isOnline: (target) =>
      environments.some(
        (entry) => entry.environmentId === target && entry.connection.phase === "connected",
      ),
  });
  const addPanel = (
    <AddMachineEnrollment
      source={machineEnrollment.source}
      transport={machineEnrollment.transport}
      defaultOpen={setupOnly || addOpen}
      onOpenTailscale={() => void bridge?.openExternal?.("https://tailscale.com/download")}
      isKnown={(candidate) => isKnownComputer(configuration.computers, candidate, environmentId)}
      isListedOnline={(candidate) =>
        isListedOnlineComputer(
          configuration.computers,
          candidate,
          environmentId,
          computerOnlineEnvironmentIds(environments, environmentId),
          environmentSshTargets(environments),
        )
      }
      onGreen={() => {
        if (setupOnly) onCompleted?.();
      }}
    />
  );

  if (setupOnly) return <div className="space-y-3">{addPanel}</div>;

  const savedEnvironmentIds = connections.savedEnvironments.map((entry) => entry.environmentId);
  const connectedIds = computerOnlineEnvironmentIds(environments, environmentId);
  const removeRow = (row: ComputerMachineRow, mode: ComputerRemoveMode) =>
    removeComputerRow({
      row,
      mode,
      control: control ? runControl : undefined,
      unassign: selectedInstanceId
        ? async (nativeId) =>
            (await membershipStore.unassign(
              selectedInstanceId,
              nativeId,
              window.desktopBridge?.ctox,
            ))
              ? null
              : (membershipStore.getSnapshot().error ?? "Instanz hat nicht bestätigt.")
        : null,
      removeConnection: async (computer) => {
        const shared = configuration.computers.some(
          (entry) => entry.id !== computer.id && entry.environmentId === computer.environmentId,
        );
        if (
          !shared &&
          savedEnvironmentIds.includes(computer.environmentId) &&
          !(await connections.removeConnection(computer.environmentId))
        )
          return "Verbindung nicht entfernbar.";
        return null;
      },
      removeWithoutBackend: async (computer) => {
        const result = await removeComputerConnection({
          configuration,
          computer,
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
        return null;
      },
    });
  const recheckRow = (row: ComputerMachineRow) => {
    const id = row.computer?.id;
    if (!id || !control) return;
    setCheckingComputerIds((current) => new Set(current).add(id));
    void runControl({ _tag: "recheck", id })
      .catch(() => toastManager.add({ type: "error", title: "Erkennung fehlgeschlagen" }))
      .finally(() =>
        setCheckingComputerIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        }),
      );
  };

  return (
    <SettingsPageContainer className="gap-6">
      {[...new Set(configuration.computers.map((computer) => computer.environmentId))]
        .filter((target) => connectedIds.includes(target))
        .map((target) => (
          <ComputerHarnessProbe
            key={target}
            environmentId={target}
            revision={probeRevision[target] ?? 0}
            onInspection={recordHarnessInspection}
          />
        ))}
      <WorkjetComputersSettingsView
        remoteDaemonUpdates={remoteDaemonUpdates}
        {...(bridge ? { onRetryRemoteDaemonUpdate: retryRemoteDaemonUpdate } : {})}
        worktreeStorage={
          environmentId === null ? null : (
            <PrimaryWorktreeStorage
              environmentId={environmentId}
              label={primaryEnvironment?.label ?? null}
            />
          )
        }
        configuration={configuration}
        environments={targetOptions}
        environmentsReady={environmentsReady}
        onRetryLoad={() => window.location.reload()}
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
        capacities={Object.fromEntries(
          configuration.computers.map((computer) => [
            computer.id,
            computerRecordFor(records, computer.id)?.capacity ?? null,
          ]),
        )}
        checkingComputerIds={checkingComputerIds}
        {...(control
          ? {
              onActiveChange: (row: ComputerMachineRow, active: boolean) => {
                const id = row.computer?.id;
                if (!id) return;
                setPendingActive((current) => ({ ...current, [id]: active }));
                void changeComputerActive({ control: runControl, row, active })
                  .catch(() =>
                    toastManager.add({ type: "error", title: "Schalter nicht gespeichert" }),
                  )
                  .finally(() =>
                    setPendingActive((current) => {
                      const next = { ...current };
                      delete next[id];
                      return next;
                    }),
                  );
              },
            }
          : {})}
        onRemove={removeRow}
        remoteRemoveAvailable={control !== undefined}
        onRecheck={(row) => {
          recheckRow(row);
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
        onRolesChange={saveRoles}
        onRetryMembership={
          selectedInstanceId
            ? () => void membershipStore.refresh(selectedInstanceId, window.desktopBridge?.ctox)
            : undefined
        }
        connectionAction={(row) => {
          const computer = row.computer;
          if (!computer || !savedEnvironmentIds.includes(computer.environmentId)) return null;
          const online = connectedIds.includes(computer.environmentId);
          if (connections.busyEnvironmentId === computer.environmentId) return null;
          return {
            label: online ? "Trennen" : "Verbinden",
            onSelect: () => {
              const action = online ? connections.disconnect : connections.reconnect;
              void action(computer.environmentId).then((failure) => {
                if (failure) toastManager.add({ type: "error", title: failure });
              });
            },
          };
        }}
        renderRepair={(row) => {
          const computer = row.computer;
          if (!computer) return null;
          const sshTarget = connections.savedSshTargets.get(computer.environmentId);
          // D14: ein Schließen-Weg (der Bereich selbst); Trennen/Verbinden liegt im ⋯-Menü.
          return (
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
      <SettingsSection title={workjetUiLanguage() === "en" ? "This computer" : "Dieser Rechner"}>
        <ProjectFolderSettingRow />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

/**
 * Die Fehlerzeile „Rechnerliste nicht abrufbar“ erscheint erst, wenn die Ablage
 * sie freigibt (Nutzeraktion sofort, sonst nach 2 min stiller Wiederholung).
 * Ohne Zeitstempel (ältere Aufrufer, Fixtures) gilt ein Fehler als sichtbar.
 */
export function membershipFailureVisible(
  membership: Pick<ComputerMembershipSnapshot, "phase" | "failureVisibleAtMs"> | null | undefined,
  now: number,
): boolean {
  if (!membership) return false;
  const visibleAt = membership.failureVisibleAtMs;
  if (visibleAt === undefined) return membership.phase === "failed";
  return visibleAt !== null && now >= visibleAt;
}

function useMembershipFailureVisible(
  membership: Pick<ComputerMembershipSnapshot, "phase" | "failureVisibleAtMs"> | null | undefined,
): boolean {
  const [now, setNow] = useState(() => Date.now());
  const visibleAt = membership?.failureVisibleAtMs ?? null;
  useEffect(() => {
    if (visibleAt === null) return;
    const wait = visibleAt - Date.now();
    if (wait <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = window.setTimeout(() => setNow(Date.now()), wait);
    return () => window.clearTimeout(timer);
  }, [visibleAt]);
  return membershipFailureVisible(membership, now);
}
