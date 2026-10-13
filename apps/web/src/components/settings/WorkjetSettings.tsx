import { workjetUiLanguage } from "../../workjetProjectControl";
import { useInstanceProviders } from "./useInstanceProviders";
import { nativeLumaRoutes, requireNativeLumaModel } from "../../lib/workjetNativeProviders";
import type {
  EnvironmentId,
  GreppyRuntimeReason,
  GreppyRuntimeSnapshot,
  GreppyRuntimeSource,
  WorktreeStorageInspection,
  WorkjetConfiguration,
  WorkjetWorkerProfile,
} from "@workjet/contracts";
import {
  applyLumaInstanceDocument,
  extractLumaInstanceDocument,
  compileWorkjetWorkerPersonaPrompt,
  WorkjetWorkerProfileId,
  WS_METHODS,
  type WorkjetLumaTarget,
} from "@workjet/contracts";
import {
  createEnvironmentRpcCommand,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@workjet/client-runtime/state/runtime";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  CheckCircle2Icon,
  PlusIcon,
  RefreshCwIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useMemo, Fragment, useCallback, useEffect, useRef, useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import type { EnvironmentPresentation } from "../../state/environments";
import { usePrimaryEnvironment } from "../../state/environments";
import { useBusinessOsCodeScope } from "../../businessOsCodeScope";
import { ctoxConnectionMatchesSelectedInstance } from "../../workjetCtoxConnections";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyLoading, EmptyTitle } from "../ui/empty";
import { InlineExpand } from "../ui/inline-expand";
import { Input } from "../ui/input";
import { Row } from "../ui/row";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import type { WorkjetGatewaySectionState } from "./WorkjetGatewayAccounts";
import { useWorkjetGatewaySection } from "./useWorkjetGatewaySection";

import {
  workjetHarnessDisplayLabel,
  workjetReasoningDisplayLabel,
  WorkjetWorkerEditor,
  workjetHarnessAvailabilityWarning,
} from "./WorkjetWorkerEditor";
import { sanitizeWorkjetWorkerGraph } from "./WorkjetWorkerOrganigram";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useClientSettings } from "../../hooks/useSettings";
import { useUiText } from "../../hooks/useUiText";
import { searchableSetting } from "./settingsSearch";
import {
  joinManagedPrompt,
  replaceSectionBody,
  sectionBody,
  splitManagedPrompt,
} from "./managedPromptSections";

const SOURCE_LABELS: Readonly<Record<GreppyRuntimeSource, string>> = {
  override: "Manuell gesetzt",
  managed: "Von Workjet verwaltet",
  path: "Server-PATH",
};

const PUBLIC_OPERATION_REASONS = new Set<GreppyRuntimeReason>([
  "unsupported-host",
  "override-invalid",
  "managed-invalid",
  "path-unavailable",
  "binary-unavailable",
  "version-mismatch",
  "surface-mismatch",
  "timeout",
  "process-exit",
  "malformed-response",
  "oversized-response",
  "index-unavailable",
  "install-failed",
]);

export type GreppyRuntimeAction = "install" | "repair" | null;

export function greppyRuntimeAction(snapshot: GreppyRuntimeSnapshot | null): GreppyRuntimeAction {
  if (snapshot?.availability !== "unavailable" || !snapshot.installSupported) return null;
  if (snapshot.reason === "override-invalid") return null;
  return snapshot.reason === "managed-invalid" ? "repair" : "install";
}

export function greppyOperationFailureDescription(error: unknown): string {
  const reason =
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "WorkjetGreppyOperationError" &&
    "reason" in error &&
    typeof error.reason === "string" &&
    PUBLIC_OPERATION_REASONS.has(error.reason as GreppyRuntimeReason)
      ? (error.reason as GreppyRuntimeReason)
      : null;

  switch (reason) {
    case "unsupported-host":
      return "Auf diesem Server nicht unterstützt.";
    case "override-invalid":
      return "WORKJET_GREPPY_EXECUTABLE ist ungültig.";
    case "managed-invalid":
      return "Reparatur fehlgeschlagen.";
    case "timeout":
      return "Zeitüberschreitung.";
    case "path-unavailable":
    case "binary-unavailable":
      return "Greppy fehlt auf diesem Server.";
    case "version-mismatch":
    case "surface-mismatch":
      return "Greppy-Version passt nicht.";
    case "malformed-response":
    case "oversized-response":
      return "Ungültige Antwort von Greppy.";
    case "index-unavailable":
      return "Greppy-Index nicht verfügbar.";
    case "process-exit":
    case "install-failed":
    case null:
      return "Greppy-Vorgang fehlgeschlagen.";
  }
}

export async function performGreppyRuntimeInstall(input: {
  readonly environmentId: EnvironmentId;
  readonly action: Exclude<GreppyRuntimeAction, null>;
  readonly install: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: Record<string, never>;
  }) => Promise<AtomCommandResult<GreppyRuntimeSnapshot, unknown>>;
  readonly addToast: typeof toastManager.add;
}): Promise<void> {
  const result = await input.install({ environmentId: input.environmentId, input: {} });
  if (result._tag === "Failure") {
    if (!isAtomCommandInterrupted(result)) {
      input.addToast({
        type: "error",
        title:
          input.action === "repair"
            ? "Greppy-Reparatur fehlgeschlagen"
            : "Greppy-Installation fehlgeschlagen",
        description: greppyOperationFailureDescription(squashAtomCommandFailure(result)),
      });
    }
    return;
  }

  input.addToast({
    type: "success",
    title: input.action === "repair" ? "Greppy repariert" : "Greppy installiert",
  });
}

/** Nach dieser Zeit endet jedes Laden mit Statuszeile und „Erneut versuchen“. */
const LOADING_TIMEOUT_MS = 10_000;

function RuntimeStatus({
  snapshot,
  isInitialLoading,
  hasInspectFailure,
  onRetry,
}: {
  readonly snapshot: GreppyRuntimeSnapshot | null;
  readonly isInitialLoading: boolean;
  readonly hasInspectFailure: boolean;
  readonly onRetry: () => void;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!isInitialLoading) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), LOADING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isInitialLoading]);

  if (isInitialLoading) {
    return slow ? (
      <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        Keine Antwort vom Server.
        <Button type="button" size="xs" variant="outline" onClick={onRetry}>
          Erneut versuchen
        </Button>
      </div>
    ) : (
      <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        Prüft …
      </div>
    );
  }
  if (hasInspectFailure) {
    return (
      <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
        <TriangleAlertIcon className="size-3.5 shrink-0" />
        Abfrage fehlgeschlagen.
      </div>
    );
  }
  if (snapshot === null) {
    return <span role="status">Kein Rechner gewählt.</span>;
  }
  if (snapshot.availability === "available") {
    return (
      <span role="status" className="flex items-center gap-1.5">
        <CheckCircle2Icon className="size-3.5 text-success" />
        Verfügbar · {SOURCE_LABELS[snapshot.source]} · {snapshot.version}
      </span>
    );
  }
  if (snapshot.availability === "unsupported") {
    return <span role="status">Installation hier nicht unterstützt.</span>;
  }
  if (snapshot.reason === "override-invalid") {
    return <span role="alert">WORKJET_GREPPY_EXECUTABLE ist ungültig.</span>;
  }
  if (snapshot.reason === "managed-invalid") {
    return <span role="alert">Reparatur nötig.</span>;
  }
  return <span role="status">Nicht verfügbar.</span>;
}

export function GreppyRuntimeSectionView({
  snapshot,
  isInitialLoading,
  hasInspectFailure,
  isRefreshing,
  isOperating,
  onRefresh,
  onInstall,
}: {
  readonly snapshot: GreppyRuntimeSnapshot | null;
  readonly isInitialLoading: boolean;
  readonly hasInspectFailure: boolean;
  readonly isRefreshing: boolean;
  readonly isOperating: boolean;
  readonly onRefresh: () => void;
  readonly onInstall: () => void;
}) {
  const action = greppyRuntimeAction(snapshot);
  return (
    <SettingsSection
      id={searchableSetting("greppy-runtime").id}
      title={searchableSetting("greppy-runtime").title}
      icon={<TerminalIcon className="size-4" />}
    >
      <SettingsRow
        title="Server-Laufzeit"
        status={
          <RuntimeStatus
            snapshot={snapshot}
            isInitialLoading={isInitialLoading}
            hasInspectFailure={hasInspectFailure}
            onRetry={onRefresh}
          />
        }
        control={
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRefresh}
              disabled={isOperating || isRefreshing}
            >
              <RefreshCwIcon className={isRefreshing ? "size-3.5 animate-spin" : "size-3.5"} />
              Erneut prüfen
            </Button>
            {action ? (
              <Button type="button" size="sm" onClick={onInstall} disabled={isOperating}>
                {isOperating ? <Spinner className="size-3.5" /> : null}
                {isOperating
                  ? action === "repair"
                    ? "Repariert …"
                    : "Installiert …"
                  : action === "repair"
                    ? "Greppy reparieren"
                    : "Greppy installieren"}
              </Button>
            ) : null}
          </div>
        }
      />
    </SettingsSection>
  );
}

export { workjetEnvironmentTargetOptions } from "./workjetEnvironmentTargetOptions";
function replaceCatalogItem<T extends { readonly id: string }>(
  items: ReadonlyArray<T>,
  item: T,
): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  return items.map((candidate) => (candidate.id === item.id ? item : candidate));
}

export type WorkjetSettingsSectionId = "workers" | "prompt" | "telemetry" | "execution";

function modelPromptFor(configuration: WorkjetConfiguration, modelId: string): string {
  return configuration.modelPrompts.find((entry) => entry.modelId === modelId)?.prompt ?? "";
}

export const WORKJET_SETTINGS_SECTIONS: ReadonlyArray<{
  readonly id: WorkjetSettingsSectionId;
  readonly targetId: string;
  readonly label: string;
}> = [
  // Settings stay shallow: Workers owns profiles, Organigram owns their graph.
  // operator's re-mapping: Computers is a TOP-LEVEL settings page, provider
  // accounts and LLM routes live on Models beside the accounts they
  // reference, and capabilities are toggled inside the worker editor.
  // Tab labels are the settings-search titles: one source for both names.
  {
    id: "workers",
    targetId: "workjet-workers",
    label: searchableSetting("workjet-workers").title,
  },
  { id: "prompt", targetId: "workjet-prompt", label: searchableSetting("workjet-prompt").title },
  {
    id: "telemetry",
    targetId: "workjet-telemetry",
    label: searchableSetting("workjet-telemetry").title,
  },
  {
    id: "execution",
    targetId: "workjet-execution",
    label: searchableSetting("workjet-execution").title,
  },
];

export function workjetSectionFromHash(hash: string): WorkjetSettingsSectionId | null {
  const targetId = hash.replace(/^#/, "");
  // Old anchors keep working: the Greppy runtime moved under Workers.
  // Computers is its own page (/settings/computers) and no longer renders here.
  if (targetId === "greppy-runtime") return "workers";
  return WORKJET_SETTINGS_SECTIONS.find((section) => section.targetId === targetId)?.id ?? null;
}

/**
 * Positive-integer input that tolerates EMPTY intermediate states: the old
 * controlled inputs re-snapped on every keystroke, so clearing the field or
 * retyping "30"→"1" was impossible (Befund K-AH5). Commits on blur; an
 * invalid or empty field reverts to the last committed value.
 */
function PositiveIntegerInput({
  value,
  ariaLabel,
  className,
  onCommit,
}: {
  readonly value: number;
  readonly ariaLabel: string;
  readonly className: string;
  readonly onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText(String(value));
  }, [value]);
  return (
    <Input
      nativeInput
      type="number"
      min={1}
      aria-label={ariaLabel}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        const parsed = Number(text);
        if (Number.isInteger(parsed) && parsed > 0) {
          if (parsed !== value) onCommit(parsed);
          return;
        }
        setText(String(value));
      }}
      className={className}
    />
  );
}

/**
 * Prompt, Telemetrie and Ausführung tune the engine, not a preset: they are
 * developer tools. Without developer mode only the preset list remains and the
 * tab bar disappears.
 */
export function visibleWorkjetSettingsSections(developerMode: boolean) {
  return WORKJET_SETTINGS_SECTIONS.filter((section) => developerMode || section.id === "workers");
}

function SectionNavigation({
  activeSection,
  onSelect,
}: {
  readonly activeSection: WorkjetSettingsSectionId;
  readonly onSelect: (section: WorkjetSettingsSectionId) => void;
}) {
  const developerMode = useClientSettings().developerMode;
  const sections = visibleWorkjetSettingsSections(developerMode);
  if (sections.length < 2) return null;
  return (
    <nav
      aria-label="Bereiche"
      role="tablist"
      className="mx-3 flex max-w-full gap-1 overflow-x-auto rounded-lg border border-border/60 bg-muted/20 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-4"
    >
      {sections.map((section) => (
        <button
          key={section.id}
          type="button"
          role="tab"
          aria-selected={activeSection === section.id}
          aria-controls={section.targetId}
          onClick={() => onSelect(section.id)}
          className={
            activeSection === section.id
              ? "shrink-0 rounded-md bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              : "shrink-0 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground outline-none hover:bg-background/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          }
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
}

interface GreppySectionState {
  readonly snapshot: GreppyRuntimeSnapshot | null;
  readonly isInitialLoading: boolean;
  readonly hasInspectFailure: boolean;
  readonly isRefreshing: boolean;
  readonly isOperating: boolean;
  readonly onRefresh: () => void;
  readonly onInstall: () => void;
}

const inspectAutomaticWorktreeRootCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:workjet:worktrees:inspect",
  tag: WS_METHODS.workjetWorktreesInspect,
  concurrency: {
    mode: "singleFlight",
    key: ({ environmentId }) => environmentId,
  },
});

export function formatAvailableBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1_000 && unitIndex < units.length - 1) {
    value /= 1_000;
    unitIndex += 1;
  }
  const digits = value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

interface AutomaticWorktreeStorageState {
  readonly configuredRoot: string;
  readonly selectedServerLabel: string | null;
  readonly selectedServerId: EnvironmentId | null;
  readonly inspection: WorktreeStorageInspection | null;
  readonly error: string | null;
  readonly isChecking: boolean;
  readonly isApplying: boolean;
  readonly onCheck: (root: string) => void;
  readonly onApply: (root: string) => void;
}

export function automaticWorktreeStorageControlState(
  storage: AutomaticWorktreeStorageState,
  draftRoot: string,
) {
  const requestedRoot = draftRoot.trim();
  const checkedInspection =
    storage.inspection?.requestedRoot === requestedRoot ? storage.inspection : null;
  return {
    requestedRoot,
    checkedInspection,
    canCheck: storage.selectedServerId !== null && !storage.isChecking,
    canApply:
      storage.selectedServerId !== null &&
      requestedRoot.length > 0 &&
      checkedInspection?.status === "valid" &&
      requestedRoot !== storage.configuredRoot &&
      !storage.isApplying,
    canReset:
      storage.selectedServerId !== null && storage.configuredRoot.length > 0 && !storage.isApplying,
  } as const;
}

export function performAutomaticWorktreeStorageAction(
  storage: AutomaticWorktreeStorageState,
  action: "check" | "apply" | "reset",
  draftRoot: string,
): void {
  const controls = automaticWorktreeStorageControlState(storage, draftRoot);
  if (action === "check" && controls.canCheck) {
    storage.onCheck(controls.requestedRoot);
  } else if (action === "apply" && controls.canApply) {
    storage.onApply(controls.requestedRoot);
  } else if (action === "reset" && controls.canReset) {
    storage.onApply("");
  }
}

export function AutomaticWorktreeStorageSettings({
  storage,
}: {
  readonly storage: AutomaticWorktreeStorageState;
}) {
  const [draftRoot, setDraftRoot] = useState(storage.configuredRoot);

  useEffect(() => {
    setDraftRoot(storage.configuredRoot);
  }, [storage.configuredRoot]);

  const { checkedInspection, canApply, canCheck, canReset } = automaticWorktreeStorageControlState(
    storage,
    draftRoot,
  );

  return (
    <SettingsRow
      title={searchableSetting("automatic-worktree-storage").title}
      status={
        storage.selectedServerId === null ? (
          <span role="alert">Kein Rechner gewählt.</span>
        ) : (
          `Rechner: ${storage.selectedServerLabel ?? "—"}`
        )
      }
    >
      <div className="mt-3 max-w-3xl space-y-3 pb-3.5">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            nativeInput
            type="text"
            aria-label="Worktree-Pfad"
            placeholder={storage.inspection?.defaultRoot ?? "/pfad"}
            value={draftRoot}
            onChange={(event) => setDraftRoot(event.target.value)}
            className="min-w-0 flex-1 font-mono text-xs"
          />
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canCheck}
              onClick={() => performAutomaticWorktreeStorageAction(storage, "check", draftRoot)}
            >
              {storage.isChecking ? <Spinner className="size-3.5" /> : null}
              Prüfen
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canApply}
              onClick={() => performAutomaticWorktreeStorageAction(storage, "apply", draftRoot)}
            >
              {storage.isApplying ? <Spinner className="size-3.5" /> : null}
              Übernehmen
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canReset}
              onClick={() => performAutomaticWorktreeStorageAction(storage, "reset", draftRoot)}
            >
              Standard
            </Button>
          </div>
        </div>

        {storage.error ? (
          <p role="alert" className="text-xs text-destructive">
            {storage.error}
          </p>
        ) : checkedInspection?.status === "invalid" ? (
          <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
            <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            {checkedInspection.message}
          </p>
        ) : checkedInspection?.status === "valid" ? (
          <p className="flex items-center gap-1.5 text-xs text-foreground">
            <CheckCircle2Icon className="size-3.5 text-success" />
            Beschreibbar · {formatAvailableBytes(checkedInspection.availableBytes)} frei
          </p>
        ) : null}
      </div>
    </SettingsRow>
  );
}

function uiText(de: string, en: string): string {
  return workjetUiLanguage() === "en" ? en : de;
}


export function WorkjetSettingsView({
  configuration,
  draftScopeKey,
  greppy,
  gateway,
  gatewayEnvironmentId = null,
  nativeInstanceId = null,
  nativeInstanceLabel = "CTOX-Instanz",
  onSaveWorkerConfiguration,
  automaticWorktreeStorage,
  defaultSection = "workers",
  onChange,
}: {
  readonly configuration: WorkjetConfiguration;
  readonly draftScopeKey: string;
  readonly greppy: GreppySectionState;
  readonly gateway: WorkjetGatewaySectionState;
  readonly gatewayEnvironmentId?: EnvironmentId | null;
  readonly nativeInstanceId?: string | null;
  readonly nativeInstanceLabel?: string;
  readonly onSaveWorkerConfiguration?: (configuration: WorkjetConfiguration) => Promise<void>;
  readonly automaticWorktreeStorage: AutomaticWorktreeStorageState;
  readonly defaultSection?: WorkjetSettingsSectionId;
  readonly onChange: (configuration: WorkjetConfiguration) => void;
}) {
  const nativeProviders = useInstanceProviders(nativeInstanceId);
  const availableRoutes = nativeLumaRoutes(
    configuration.llmRoutes,
    nativeProviders.registry,
    nativeInstanceLabel,
  );
  const locationHash = useLocation({ select: (location) => location.hash });
  const navigate = useNavigate();
  const t = useUiText();
  const [activeSection, setActiveSection] = useState<WorkjetSettingsSectionId>(
    () => workjetSectionFromHash(locationHash) ?? defaultSection,
  );
  // A stashed draft means the operator left via "Add LLM route…" and came
  // back — reopen the editor they were in so the stash gets consumed (K-A7).
  const stashedWorkerEditor = useMemo(() => {
    try {
      for (let index = 0; index < window.sessionStorage.length; index += 1) {
        const key = window.sessionStorage.key(index);
        const prefix = `workjet-worker-draft:${encodeURIComponent(draftScopeKey)}:`;
        if (key?.startsWith(prefix)) {
          return key.slice(prefix.length);
        }
      }
    } catch {
      // Blocked storage: nothing to restore.
    }
    return null;
    // Read once per mount on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [editingWorkerId, setEditingWorkerId] = useState<string | null>(
    stashedWorkerEditor !== null && stashedWorkerEditor !== "new" ? stashedWorkerEditor : null,
  );
  const [addingWorker, setAddingWorker] = useState(stashedWorkerEditor === "new");
  const [pendingWorkerParentId, setPendingWorkerParentId] = useState<WorkjetWorkerProfileId | null>(
    null,
  );
  const promptSections = splitManagedPrompt(configuration.managedSystemPrompt);
  const editingWorker =
    configuration.workerProfiles.find((worker) => worker.id === editingWorkerId) ?? null;
  const openAddWorker = () => {
    setEditingWorkerId(null);
    setAddingWorker(true);
    setPendingWorkerParentId(null);
  };
  const workerEditor = (
    <div className="px-3 pt-2 sm:px-4">
      <WorkjetWorkerEditor
        key={editingWorker?.id ?? "new-worker"}
        worker={editingWorker}
        draftScopeKey={draftScopeKey}
        computers={configuration.computers}
        routes={availableRoutes}
        nativeAccounts={nativeProviders.registry?.accounts ?? []}
        nativeModelsBusy={nativeProviders.busy}
        nativeModelsError={nativeProviders.error}
        onRefreshNativeModels={(account) => {
          void nativeProviders.run({
            action: "instance.providers.observe",
            accountId: account.id,
            expectedAccountRevision: account.revision,
          });
        }}
        onValidateNativeModel={async (account, model) => {
          const registry = await nativeProviders.run({
            action: "instance.providers.observe",
            accountId: account.id,
            expectedAccountRevision: account.revision,
          });
          requireNativeLumaModel(
            registry?.accounts.find(
              (current) =>
                current.id === account.id &&
                current.holder.id === account.holder.id &&
                current.revision === account.revision,
            ),
            model,
          );
        }}
        gatewayAccounts={gateway.catalog?.accounts ?? []}
        gatewayEnvironmentId={gatewayEnvironmentId}
        onCreateRoute={(route) =>
          // The access is created right inside the Luma editor; no jump to
          // the Models page.
          onChange({
            ...configuration,
            llmRoutes: replaceCatalogItem(configuration.llmRoutes, route),
          })
        }
        onCancel={() => {
          setAddingWorker(false);
          setEditingWorkerId(null);
          setPendingWorkerParentId(null);
        }}
        onSave={async (worker: WorkjetWorkerProfile) => {
          const workerProfiles = replaceCatalogItem(configuration.workerProfiles, worker);
          const cleanGraph = sanitizeWorkjetWorkerGraph(configuration.workerGraph, workerProfiles);
          const workerGraph =
            pendingWorkerParentId === null ||
            cleanGraph.dependencies.some(
              (dependency) =>
                dependency.fromWorkerId === pendingWorkerParentId &&
                dependency.toWorkerId === worker.id,
            )
              ? cleanGraph
              : {
                  ...cleanGraph,
                  dependencies: [
                    ...cleanGraph.dependencies,
                    { fromWorkerId: pendingWorkerParentId, toWorkerId: worker.id },
                  ],
                };
          const nextConfiguration = {
            ...configuration,
            workerProfiles,
            workerGraph,
            llmRoutes: (() => {
              const selected = availableRoutes.find((route) => route.id === worker.llmRouteId);
              return selected?.nativeAccountReference
                ? replaceCatalogItem(configuration.llmRoutes, selected)
                : configuration.llmRoutes;
            })(),
          };
          if (onSaveWorkerConfiguration) await onSaveWorkerConfiguration(nextConfiguration);
          else onChange(nextConfiguration);
          setAddingWorker(false);
          setEditingWorkerId(null);
          setPendingWorkerParentId(null);
          // The saved row can sit below the fold; without this the viewport
          // shows no evidence the save happened (interactive-review finding).
          toastManager.add({
            type: "success",
            title: `${worker.name} gespeichert`,
          });
        }}
      />
    </div>
  );

  useEffect(() => {
    const section = workjetSectionFromHash(locationHash);
    if (section !== null) setActiveSection(section);
  }, [locationHash]);

  return (
    <SettingsPageContainer className="gap-6" title={searchableSetting("workjet-workers").title}>
      <div className="space-y-3">
        <SectionNavigation
          activeSection={activeSection}
          onSelect={(section) => {
            setActiveSection(section);
            // Keep the URL truthful: after a hash-deep-link the tab click used
            // to leave the OLD anchor in the address bar, so a reload landed
            // on the wrong tab (Befund K-A15b). Through the router — a raw
            // replaceState would replace the ROUTE in this hash-router.
            const target = WORKJET_SETTINGS_SECTIONS.find((entry) => entry.id === section);
            if (target !== undefined) {
              void navigate({
                to: "/settings/workjet",
                hash: target.targetId,
                replace: true,
                hashScrollIntoView: false,
              });
            }
          }}
        />
      </div>

      {activeSection === "workers" ? (
        <SettingsSection id={searchableSetting("workjet-workers").id} title="">
          {/* Inline-Panel-Muster: der Auslöser steht dort, wo das Formular
              aufklappt; Bearbeiten klappt direkt unter der Zeile auf. Kein
              Dialog, kein Popover. */}
          <InlineExpand
            label={t("Preset hinzufügen", "Add preset")}
            open={addingWorker}
            onOpenChange={(open) => {
              if (!open) {
                setAddingWorker(false);
                setPendingWorkerParentId(null);
              }
            }}
          >
            {addingWorker ? workerEditor : null}
          </InlineExpand>
          {addingWorker ? null : configuration.workerProfiles.length === 0 ? null : (
            <div className="px-3 sm:px-4">
              <Button type="button" size="sm" variant="outline" onClick={openAddWorker}>
                <PlusIcon className="size-3.5" />
                {t("Preset hinzufügen", "Add preset")}
              </Button>
            </div>
          )}
          {configuration.workerProfiles.length === 0 ? (
            addingWorker ? null : (
              <Empty className="p-4">
                <EmptyHeader>
                  <EmptyTitle className="text-base">
                    {t("Keine Worker-Presets", "No worker presets")}
                  </EmptyTitle>
                </EmptyHeader>
                <EmptyContent>
                  <Button type="button" onClick={openAddWorker}>
                    <PlusIcon className="size-3.5" />
                    {t("Preset hinzufügen", "Add preset")}
                  </Button>
                </EmptyContent>
              </Empty>
            )
          ) : (
            <div className="divide-y divide-border/60">
              {configuration.workerProfiles.map((worker) => {
                const computer = configuration.computers.find(
                  (candidate) => candidate.id === worker.computerId,
                );
                const warning = workjetHarnessAvailabilityWarning(worker, configuration.computers);
                const deleteWorker = () => {
                  const workerProfiles = configuration.workerProfiles.filter(
                    (candidate) => candidate.id !== worker.id,
                  );
                  if (editingWorkerId === worker.id) setEditingWorkerId(null);
                  onChange({
                    ...configuration,
                    workerProfiles,
                    workerGraph: sanitizeWorkjetWorkerGraph(
                      configuration.workerGraph,
                      workerProfiles,
                    ),
                  });
                };
                const duplicateWorker = () => {
                  const copy: WorkjetWorkerProfile = {
                    ...worker,
                    id: WorkjetWorkerProfileId.make(randomUUID()),
                    name: `${worker.name} (Kopie)`,
                  };
                  const workerProfiles = [...configuration.workerProfiles, copy];
                  onChange({
                    ...configuration,
                    workerProfiles,
                    workerGraph: sanitizeWorkjetWorkerGraph(
                      configuration.workerGraph,
                      workerProfiles,
                    ),
                  });
                };
                return (
                  <Fragment key={worker.id}>
                    <Row
                      name={worker.name}
                      meta={[
                        worker.modelId,
                        workjetHarnessDisplayLabel(worker.harness),
                        computer?.label ?? t("Rechner: —", "Computer: —"),
                      ].join(" · ")}
                      // One signal: a red dot only when the preset cannot run; the reason is its label.
                      {...(warning === null
                        ? {}
                        : {
                            status: "error" as const,
                            statusLabel:
                              computer === undefined
                                ? t("Rechner fehlt", "Computer missing")
                                : t("Harness fehlt", "Harness missing"),
                          })}
                      onDelete={deleteWorker}
                      deleteConfirmTitle={t("Preset löschen?", "Delete preset?")}
                      expanded={editingWorkerId === worker.id}
                      onToggleExpanded={() => {
                        setAddingWorker(false);
                        setPendingWorkerParentId(null);
                        setEditingWorkerId((current) => (current === worker.id ? null : worker.id));
                      }}
                      menuActions={[
                        { label: t("Duplizieren", "Duplicate"), onSelect: duplicateWorker },
                      ]}
                    />
                    <InlineExpand
                      hideCollapseControl
                      label={worker.name}
                      open={editingWorker?.id === worker.id}
                      onOpenChange={(open) => {
                        if (!open && editingWorkerId === worker.id) setEditingWorkerId(null);
                      }}
                    >
                      {editingWorker?.id === worker.id ? workerEditor : null}
                    </InlineExpand>
                  </Fragment>
                );
              })}
            </div>
          )}
        </SettingsSection>
      ) : null}

      {activeSection === "prompt" ? (
        <SettingsSection
          id={searchableSetting("workjet-prompt").id}
          title={searchableSetting("workjet-prompt").title}
        >
          <SettingsRow title="Workjet Manager">
            <div className="mt-2 max-w-3xl pb-3.5">
              <Textarea
                key={configuration.managerThreadReference}
                defaultValue={configuration.managerThreadReference}
                rows={2}
                placeholder="workjet://app/threads/…"
                aria-label="Workjet-Manager-Thread"
                onBlur={(event) => {
                  const managerThreadReference = event.target.value.trim();
                  if (managerThreadReference !== configuration.managerThreadReference) {
                    onChange({ ...configuration, managerThreadReference });
                  }
                }}
              />
            </div>
          </SettingsRow>

          {/* The Swift page shows this prompt as named cards, each with its own
              edit affordance, instead of one 6 KB scroll box. Same here — but
              as a VIEW: the sections are found by the headings already in the
              text and joined straight back, because the prompt is deliberately
              one stored field and a second home would give the importer two
              targets for one source. */}
          {promptSections.map((section, index) => (
            <SettingsRow
              key={`${section.title ?? "preamble"}-${String(index)}`}
              title={section.title ?? "Vorspann"}
            >
              <div className="mt-2 max-w-3xl pb-3.5">
                <Textarea
                  key={`${configuration.managedSystemPrompt.length}-${String(index)}`}
                  defaultValue={sectionBody(section)}
                  rows={Math.min(16, Math.max(4, section.bodyLines.length))}
                  aria-label={`Prompt-Abschnitt ${section.title ?? "Vorspann"}`}
                  onBlur={(event) => {
                    const next = joinManagedPrompt(
                      replaceSectionBody(promptSections, index, event.target.value),
                    );
                    if (next !== configuration.managedSystemPrompt) {
                      onChange({ ...configuration, managedSystemPrompt: next });
                    }
                  }}
                />
              </div>
            </SettingsRow>
          ))}

          {/* Each worker's own task text, which the Swift page lists right
              below the shared rules with its facts beside it — because the
              question "what will this worker be told" is answered by both
              together, and they lived on different pages here. */}
          {configuration.workerProfiles.length === 0 ? null : (
            <SettingsRow title="Luma-Aufgaben">
              <div className="mt-2 space-y-2 pb-3.5">
                {configuration.workerProfiles.map((worker, workerIndex) => {
                  // The rules are stored PER MODEL — two workers on the same
                  // model used to render the same stored field as two editors
                  // (Befund K-A13). Only the first occurrence edits; later
                  // ones point up.
                  const firstWithModel = configuration.workerProfiles.findIndex(
                    (candidate) => candidate.modelId === worker.modelId,
                  );
                  const modelRulesEditorHere = firstWithModel === workerIndex;
                  const modelRulesOwner = modelRulesEditorHere
                    ? null
                    : configuration.workerProfiles[firstWithModel];
                  return (
                    <div key={worker.id} className="rounded-lg bg-muted/25 p-2.5">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span className="text-xs font-medium text-foreground">{worker.name}</span>
                        <span className="text-[11px] text-muted-foreground">
                          {[
                            worker.modelId,
                            workjetHarnessDisplayLabel(worker.harness),
                            configuration.computers.find(
                              (computer) => computer.id === worker.computerId,
                            )?.label ?? "—",
                            workjetReasoningDisplayLabel(worker.reasoning),
                          ].join(" · ")}
                        </span>
                      </div>
                      {/* Model rules — the Swift page's "MODELL · …" block:
                        guidance shared by every worker on this model, edited
                        here per model (changing it changes it for all of
                        them) and prepended to the task at dispatch. */}
                      <div className="mt-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                        Modellregeln · {worker.modelId}
                      </div>
                      {modelRulesEditorHere ? null : (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Geteilt mit {modelRulesOwner?.name ?? "—"}
                        </p>
                      )}
                      {!modelRulesEditorHere ? null : (
                        <Textarea
                          key={`${worker.id}-model-${modelPromptFor(configuration, worker.modelId)}`}
                          defaultValue={modelPromptFor(configuration, worker.modelId)}
                          rows={Math.min(
                            8,
                            Math.max(
                              2,
                              modelPromptFor(configuration, worker.modelId).split("\n").length,
                            ),
                          )}
                          aria-label={`Modellregeln ${worker.modelId}`}
                          placeholder="Keine Modellregeln"
                          className="mt-1 text-[12px]"
                          onBlur={(event) => {
                            const prompt = event.target.value;
                            if (prompt === modelPromptFor(configuration, worker.modelId)) return;
                            const rest = configuration.modelPrompts.filter(
                              (entry) => entry.modelId !== worker.modelId,
                            );
                            onChange({
                              ...configuration,
                              modelPrompts:
                                prompt.trim() === ""
                                  ? rest
                                  : [...rest, { modelId: worker.modelId, prompt }],
                            });
                          }}
                        />
                      )}
                      <div className="mt-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                        Aufgabe
                      </div>
                      {/* Editable in place, like the Swift page's per-worker
                        Bearbeiten: the task is prompt text, and the prompt
                        page is where prompt text is edited. Saved on blur into
                        the worker profile — same field the worker editor
                        writes, one storage, two doors. */}
                      <Textarea
                        key={`${worker.id}-${worker.instructions ?? ""}`}
                        defaultValue={worker.instructions ?? ""}
                        rows={Math.min(
                          10,
                          Math.max(2, (worker.instructions ?? "").split("\n").length),
                        )}
                        aria-label={`Aufgabe ${worker.name}`}
                        placeholder="Keine Aufgabe"
                        className="mt-1 text-[12px]"
                        onBlur={(event) => {
                          const instructions = event.target.value;
                          if (instructions === (worker.instructions ?? "")) return;
                          onChange({
                            ...configuration,
                            workerProfiles: configuration.workerProfiles.map((candidate) =>
                              candidate.id === worker.id
                                ? { ...candidate, instructions }
                                : candidate,
                            ),
                          });
                        }}
                      />
                      <div className="mt-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                        Persona-Systemprompt
                      </div>
                      <Textarea
                        value={compileWorkjetWorkerPersonaPrompt(worker, {
                          currentWorkerId: worker.id,
                          workers: configuration.workerProfiles,
                          graph: configuration.workerGraph,
                        })}
                        readOnly
                        rows={20}
                        aria-label={`Persona-Systemprompt ${worker.name}`}
                        className="mt-1 font-mono text-[11px] leading-relaxed"
                      />
                    </div>
                  );
                })}
              </div>
            </SettingsRow>
          )}
        </SettingsSection>
      ) : null}

      {activeSection === "telemetry" ? (
        <SettingsSection
          id={searchableSetting("workjet-telemetry").id}
          title={searchableSetting("workjet-telemetry").title}
        >
          <SettingsRow
            title="Claude-Code-Ereignisse"
            control={
              <Switch
                checked={configuration.telemetry.claudeCodeEvents}
                onCheckedChange={(claudeCodeEvents) =>
                  onChange({
                    ...configuration,
                    telemetry: {
                      ...configuration.telemetry,
                      claudeCodeEvents: Boolean(claudeCodeEvents),
                    },
                  })
                }
                aria-label="Claude-Code-Ereignisse erfassen"
              />
            }
          />
          <SettingsRow
            title="Luma-Ereignisse"
            control={
              <Switch
                checked={configuration.telemetry.sidecarEvents}
                onCheckedChange={(sidecarEvents) =>
                  onChange({
                    ...configuration,
                    telemetry: {
                      ...configuration.telemetry,
                      sidecarEvents: Boolean(sidecarEvents),
                    },
                  })
                }
                aria-label="Luma-Ereignisse erfassen"
              />
            }
          />
          <SettingsRow
            title="Aufbewahrung"
            control={
              <div className="flex items-center gap-2">
                <PositiveIntegerInput
                  ariaLabel="Aufbewahrung (Tage)"
                  value={configuration.telemetry.retentionDays}
                  onCommit={(retentionDays) =>
                    onChange({
                      ...configuration,
                      telemetry: { ...configuration.telemetry, retentionDays },
                    })
                  }
                  className="w-24"
                />
                <span className="text-xs text-muted-foreground">Tage</span>
              </div>
            }
          />
        </SettingsSection>
      ) : null}

      {activeSection === "execution" ? (
        <SettingsSection
          id={searchableSetting("workjet-execution").id}
          title={searchableSetting("workjet-execution").title}
        >
          <AutomaticWorktreeStorageSettings storage={automaticWorktreeStorage} />
          <SettingsRow
            title="Prüf-Timeout"
            control={
              <div className="flex items-center gap-2">
                <PositiveIntegerInput
                  ariaLabel="Prüf-Timeout (Sekunden)"
                  value={configuration.execution.probeTimeoutSeconds}
                  onCommit={(probeTimeoutSeconds) =>
                    onChange({
                      ...configuration,
                      execution: { ...configuration.execution, probeTimeoutSeconds },
                    })
                  }
                  className="w-28"
                />
                <span className="text-xs text-muted-foreground">Sek.</span>
              </div>
            }
          />
          <SettingsRow
            title="Turn-Timeout"
            control={
              <div className="flex items-center gap-2">
                <PositiveIntegerInput
                  ariaLabel="Turn-Timeout (Sekunden)"
                  value={configuration.execution.turnTimeoutSeconds}
                  onCommit={(turnTimeoutSeconds) =>
                    onChange({
                      ...configuration,
                      execution: { ...configuration.execution, turnTimeoutSeconds },
                    })
                  }
                  className="w-28"
                />
                <span className="text-xs text-muted-foreground">Sek.</span>
              </div>
            }
          />
          <SettingsRow
            title="Degradation erlauben"
            control={
              <Switch
                checked={configuration.execution.degradationAllowed}
                onCheckedChange={(degradationAllowed) =>
                  onChange({
                    ...configuration,
                    execution: {
                      ...configuration.execution,
                      degradationAllowed: Boolean(degradationAllowed),
                    },
                  })
                }
                aria-label="Degradation erlauben"
              />
            }
          />
        </SettingsSection>
      ) : null}

      {/* The Greppy RUNTIME (install/pin state) supports worker composition,
          so it sits under Workers instead of a tab of its own; the per-worker
          capability toggles already live in the worker editor. */}
      {activeSection === "workers" ? <GreppyRuntimeSectionView {...greppy} /> : null}
    </SettingsPageContainer>
  );
}

export function WorkjetSettings({
  defaultSection,
}: {
  readonly defaultSection?: WorkjetSettingsSectionId;
} = {}) {
  const scope = useBusinessOsCodeScope();
  const environment = usePrimaryEnvironment();
  const connections = useEnvironmentQuery(
    environment === null
      ? null
      : serverEnvironment.workjetDecisionHubConnections({
          environmentId: environment.environmentId,
          input: {},
        }),
  );
  const matches =
    scope.phase === "ready"
      ? (connections.data?.connections ?? []).filter(
          (connection) =>
            connection.status === "ready" &&
            ctoxConnectionMatchesSelectedInstance(connection, scope.presentationInstanceId),
        )
      : [];
  const connection =
    matches.length === 1
      ? matches[0]
      : matches.find(
          (entry) =>
            entry.connectionId ===
            `ctox-dev:${scope.presentationInstanceId?.replace(/^managed:/, "")}`,
        );
  const target =
    scope.phase === "ready" && connection !== undefined
      ? { connectionId: connection.connectionId, instanceId: connection.instanceId }
      : null;

  if (target === null || environment === null) {
    const resolving = scope.phase === "resolving" || connections.isPending;
    const noInstance = scope.phase === "blocked" && scope.blocker === "no-active-instance";
    return (
      <SettingsPageContainer title={searchableSetting("workjet-workers").title}>
        {resolving ? (
          <EmptyLoading
            title={uiText("Instanz wird geladen", "Loading instance")}
            slowMessage={uiText(
              "Keine Antwort von der Instanz.",
              "The instance is not responding.",
            )}
            onRetry={connections.refresh}
          />
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>
                {noInstance
                  ? uiText("Keine Instanz", "No instance")
                  : uiText("Worker-Presets nicht abrufbar", "Worker presets unavailable")}
              </EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              {noInstance ? (
                <Button render={<Link to="/settings/business-os" />}>
                  {uiText("Instanz auswählen", "Choose instance")}
                </Button>
              ) : (
                <Button render={<Link to="/settings/business-os" />}>
                  {uiText("Instanzen verwalten", "Manage instances")}
                </Button>
              )}
            </EmptyContent>
          </Empty>
        )}
      </SettingsPageContainer>
    );
  }

  return (
    <ScopedWorkjetSettings
      key={`${environment.environmentId}:${target.instanceId}:${target.connectionId}`}
      environment={environment}
      target={target}
      nativeInstanceId={scope.presentationInstanceId}
      {...(defaultSection ? { defaultSection } : {})}
    />
  );
}

function ScopedWorkjetSettings({
  environment,
  nativeInstanceId,
  target,
  defaultSection,
}: {
  readonly environment: EnvironmentPresentation;
  readonly target: WorkjetLumaTarget;
  readonly nativeInstanceId: string | null;
  readonly defaultSection?: WorkjetSettingsSectionId;
}) {
  const environmentId = environment.environmentId;
  const settings = useEnvironmentSettings(environmentId);
  const instance = useEnvironmentQuery(
    serverEnvironment.lumaConfiguration({ environmentId, input: target }),
  );
  const saveInstance = useAtomCommand(serverEnvironment.updateLumaConfiguration, {
    reportFailure: false,
  });
  const [saveError, setSaveError] = useState<string | null>(null);
  const configuration =
    instance.data?.configuration === null || instance.data === null
      ? settings.workjet
      : applyLumaInstanceDocument(settings.workjet, instance.data.configuration);
  const persistInstanceConfiguration = useCallback(
    async (next: WorkjetConfiguration) => {
      if (instance.data === null || instance.isPending) throw new Error("Konfiguration lädt noch.");
      setSaveError(null);
      const result = await saveInstance({
        environmentId,
        input: {
          target,
          expectedRevision: instance.data.revision,
          configuration: extractLumaInstanceDocument(next),
        },
      });
      const failure =
        result._tag === "Failure"
          ? uiText("Worker-Presets nicht gespeichert.", "Worker presets not saved.")
          : result.value.status === "conflict"
            ? uiText(
                "Worker-Presets wurden anderswo geändert. Bitte neu laden.",
                "Worker presets changed elsewhere. Please reload.",
              )
            : null;
      if (failure !== null) {
        setSaveError(failure);
        throw new Error(failure);
      }
    },
    [environmentId, instance.data, instance.isPending, saveInstance, target],
  );
  const updateConfiguration = useCallback(
    (next: WorkjetConfiguration) => {
      void persistInstanceConfiguration(next).catch(() => undefined);
    },
    [persistInstanceConfiguration],
  );
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.greppyRuntimeInspect({ environmentId, input: {} }),
  );
  const install = useAtomCommand(serverEnvironment.installGreppyRuntime, { reportFailure: false });
  const inspectAutomaticWorktreeRoot = useAtomCommand(inspectAutomaticWorktreeRootCommand, {
    reportFailure: false,
  });
  const updateServerSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const operatingRef = useRef(false);
  const storageOperationRef = useRef(false);
  const [isOperating, setIsOperating] = useState(false);
  const [storageInspection, setStorageInspection] = useState<WorktreeStorageInspection | null>(
    null,
  );
  const [storageError, setStorageError] = useState<string | null>(null);
  const [isCheckingStorage, setIsCheckingStorage] = useState(false);
  const [isApplyingStorage, setIsApplyingStorage] = useState(false);
  const action = greppyRuntimeAction(query.data);

  // One provider surface: the interactive gateway account section lives in
  // Settings → Providers. This page keeps the same state only so an LLM route
  // can pick from the gateway's account catalog.
  const gateway = useWorkjetGatewaySection(environmentId);

  const handleInstall = useCallback(() => {
    if (environmentId === null || action === null || operatingRef.current) return;
    operatingRef.current = true;
    setIsOperating(true);
    void performGreppyRuntimeInstall({
      environmentId,
      action,
      install,
      addToast: toastManager.add,
    }).finally(() => {
      operatingRef.current = false;
      setIsOperating(false);
    });
  }, [action, environmentId, install]);

  const runStorageInspection = useCallback(
    async (root: string): Promise<WorktreeStorageInspection | null> => {
      if (environmentId === null) {
        setStorageError("Kein Rechner verfügbar.");
        return null;
      }
      setIsCheckingStorage(true);
      setStorageError(null);
      const result = await inspectAutomaticWorktreeRoot({
        environmentId,
        input: { root },
      });
      setIsCheckingStorage(false);
      if (result._tag === "Success") {
        setStorageInspection(result.value);
        return result.value;
      }
      if (!isAtomCommandInterrupted(result)) {
        setStorageError("Pfad nicht prüfbar.");
      }
      return null;
    },
    [environmentId, inspectAutomaticWorktreeRoot],
  );

  useEffect(() => {
    setStorageInspection(null);
    setStorageError(null);
    if (environmentId !== null) {
      void runStorageInspection(settings.automaticWorktreeRoot);
    }
  }, [environmentId, runStorageInspection, settings.automaticWorktreeRoot]);

  const handleApplyStorage = useCallback(
    (root: string) => {
      if (environmentId === null || storageOperationRef.current) return;
      storageOperationRef.current = true;
      setIsApplyingStorage(true);
      setStorageError(null);
      void (async () => {
        const result = await updateServerSettings({
          environmentId,
          input: { patch: { automaticWorktreeRoot: root } },
        });
        if (result._tag === "Success") {
          const canonicalRoot = result.value.automaticWorktreeRoot;
          await runStorageInspection(canonicalRoot);
          toastManager.add({
            type: "success",
            title: canonicalRoot.length === 0 ? "Standardpfad aktiv" : "Worktree-Pfad gespeichert",
          });
        } else if (!isAtomCommandInterrupted(result)) {
          setStorageError("Pfad abgelehnt.");
        }
      })().finally(() => {
        storageOperationRef.current = false;
        setIsApplyingStorage(false);
      });
    },
    [environmentId, runStorageInspection, updateServerSettings],
  );

  if (instance.data === null)
    return (
      <SettingsPageContainer title={searchableSetting("workjet-workers").title}>
        {instance.isPending ? (
          <EmptyLoading
            title={uiText("Worker-Presets werden geladen", "Loading worker presets")}
            slowMessage={uiText(
              "Keine Antwort von der Instanz.",
              "The instance is not responding.",
            )}
            onRetry={instance.refresh}
          />
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>
                {uiText("Konfiguration nicht verfügbar", "Configuration unavailable")}
              </EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={instance.refresh}>{uiText("Erneut laden", "Reload")}</Button>
            </EmptyContent>
          </Empty>
        )}
      </SettingsPageContainer>
    );

  return (
    <>
      {saveError !== null ? (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {saveError}
        </p>
      ) : null}
      <WorkjetSettingsView
        {...(defaultSection ? { defaultSection } : {})}
        draftScopeKey={`${environmentId}:${target.instanceId}:${target.connectionId}`}
        nativeInstanceId={nativeInstanceId}
        nativeInstanceLabel={target.instanceId}
        onSaveWorkerConfiguration={persistInstanceConfiguration}
        configuration={configuration}
        greppy={{
          snapshot: query.data,
          isInitialLoading: query.isPending && query.data === null,
          hasInspectFailure: query.error !== null,
          isRefreshing: query.isPending && query.data !== null,
          isOperating,
          onRefresh: query.refresh,
          onInstall: handleInstall,
        }}
        gateway={gateway}
        gatewayEnvironmentId={environmentId}
        automaticWorktreeStorage={{
          configuredRoot: settings.automaticWorktreeRoot,
          selectedServerLabel: environment.label,
          selectedServerId: environmentId,
          inspection: storageInspection,
          error: storageError,
          isChecking: isCheckingStorage,
          isApplying: isApplyingStorage,
          onCheck: (root) => void runStorageInspection(root),
          onApply: handleApplyStorage,
        }}
        onChange={updateConfiguration}
      />
    </>
  );
}
