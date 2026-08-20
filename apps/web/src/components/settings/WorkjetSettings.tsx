import type {
  EnvironmentId,
  GreppyRuntimeReason,
  GreppyRuntimeSnapshot,
  GreppyRuntimeSource,
  WorktreeStorageInspection,
  WorkjetComputer,
  WorkjetComputerPresentationKind,
  WorkjetConfiguration,
  WorkjetLlmRoute,
  WorkjetWorkerProfile,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useLocation } from "@tanstack/react-router";
import {
  CheckCircle2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironment,
} from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import {
  type WorkjetEnvironmentTargetOption,
  WorkjetComputerEditor,
} from "./WorkjetComputerEditor";
import type { WorkjetGatewaySectionState } from "./WorkjetGatewayAccounts";
import { WorkjetGatewayModelRoutes } from "./WorkjetGatewayModelRoutes";
import { useWorkjetGatewaySection } from "./useWorkjetGatewaySection";
import type { WorkjetLegacyImportSection } from "./useWorkjetLegacyImportSection";
import { useWorkjetLegacyImportSection } from "./useWorkjetLegacyImportSection";
import { WorkjetLegacyImportSectionView } from "./WorkjetLegacyImport";
import { WorkjetLlmRouteEditor } from "./WorkjetLlmRouteEditor";
import { WorkjetWorkerEditor, workjetHarnessAvailabilityWarning } from "./WorkjetWorkerEditor";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const SOURCE_LABELS: Readonly<Record<GreppyRuntimeSource, string>> = {
  override: "WORKJET_GREPPY_EXECUTABLE override",
  managed: "Workjet-managed runtime",
  path: "Server PATH",
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
      return "Managed Greppy installation is not supported on this server.";
    case "override-invalid":
      return "Correct or remove WORKJET_GREPPY_EXECUTABLE before trying again.";
    case "managed-invalid":
      return "The managed Greppy runtime could not be repaired.";
    case "timeout":
      return "The Greppy operation timed out.";
    case "path-unavailable":
    case "binary-unavailable":
      return "Greppy is unavailable on this server.";
    case "version-mismatch":
    case "surface-mismatch":
      return "The installed Greppy runtime is incompatible.";
    case "malformed-response":
    case "oversized-response":
      return "Greppy returned an invalid response.";
    case "index-unavailable":
      return "Greppy indexing is unavailable.";
    case "process-exit":
    case "install-failed":
    case null:
      return "The managed Greppy runtime operation failed.";
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
        title: input.action === "repair" ? "Could not repair Greppy" : "Could not install Greppy",
        description: greppyOperationFailureDescription(squashAtomCommandFailure(result)),
      });
    }
    return;
  }

  input.addToast({
    type: "success",
    title: input.action === "repair" ? "Greppy repaired" : "Greppy installed",
    description: "Server runtime status was refreshed.",
  });
}

function RuntimeStatus({
  snapshot,
  isInitialLoading,
  hasInspectFailure,
}: {
  readonly snapshot: GreppyRuntimeSnapshot | null;
  readonly isInitialLoading: boolean;
  readonly hasInspectFailure: boolean;
}) {
  if (isInitialLoading) {
    return (
      <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Checking the selected server…
      </div>
    );
  }
  if (hasInspectFailure) {
    return (
      <div role="alert" className="flex items-start gap-2 text-sm text-destructive">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
        The selected server could not report Greppy runtime status.
      </div>
    );
  }
  if (snapshot === null) {
    return <p role="status">Select a primary environment to inspect its Greppy runtime.</p>;
  }
  if (snapshot.availability === "available") {
    return (
      <div role="status" className="space-y-1 text-sm">
        <p className="flex items-center gap-2 font-medium text-foreground">
          <CheckCircle2Icon className="size-4 text-success" />
          Available
        </p>
        <p>
          Source: {SOURCE_LABELS[snapshot.source]}. Pinned version {snapshot.version}.
        </p>
      </div>
    );
  }
  if (snapshot.availability === "unsupported") {
    return (
      <div role="status" className="space-y-1 text-sm">
        <p className="font-medium text-foreground">Managed install unsupported</p>
        <p>
          This host can use an externally administered Greppy runtime, but Workjet cannot install
          it.
        </p>
      </div>
    );
  }
  if (snapshot.reason === "override-invalid") {
    return (
      <div role="alert" className="space-y-1 text-sm">
        <p className="font-medium text-foreground">Executable override is invalid</p>
        <p>
          Correct or remove <code>WORKJET_GREPPY_EXECUTABLE</code> on the server. A managed install
          cannot override this explicit setting.
        </p>
      </div>
    );
  }
  if (snapshot.reason === "managed-invalid") {
    return (
      <div role="alert" className="space-y-1 text-sm">
        <p className="font-medium text-foreground">Managed runtime needs repair</p>
        <p>
          The completed managed installation did not validate and no usable PATH fallback was found.
        </p>
      </div>
    );
  }
  return (
    <div role="status" className="space-y-1 text-sm">
      <p className="font-medium text-foreground">Unavailable</p>
      <p>No compatible Greppy runtime is available to this server.</p>
    </div>
  );
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
      icon={<WrenchIcon className="size-4" />}
    >
      <SettingsRow
        title="Server runtime"
        description="Inspect or install the pinned Greppy runtime managed by the selected server."
        status={
          <RuntimeStatus
            snapshot={snapshot}
            isInitialLoading={isInitialLoading}
            hasInspectFailure={hasInspectFailure}
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
              Check again
            </Button>
            {action ? (
              <Button type="button" size="sm" onClick={onInstall} disabled={isOperating}>
                {isOperating ? <Spinner className="size-3.5" /> : null}
                {isOperating
                  ? action === "repair"
                    ? "Repairing…"
                    : "Installing…"
                  : action === "repair"
                    ? "Repair Greppy"
                    : "Install Greppy"}
              </Button>
            ) : null}
          </div>
        }
      />
      <SettingsRow
        title="Shared server capability"
        description="The runtime and store are shared by all Codex, Claude, and Grok threads on this server. Greppy activation remains configured per thread."
      />
    </SettingsSection>
  );
}

function environmentPresentationKind(
  environment: EnvironmentPresentation,
): WorkjetComputerPresentationKind {
  switch (environment.entry.target._tag) {
    case "PrimaryConnectionTarget":
      return "local";
    case "RelayConnectionTarget":
      return "t3-connect";
    case "SshConnectionTarget":
      return "ssh";
    case "BearerConnectionTarget":
      return "remote";
  }
}

export function workjetEnvironmentTargetOptions(
  environments: ReadonlyArray<EnvironmentPresentation>,
): WorkjetEnvironmentTargetOption[] {
  return environments
    .map((environment) => {
      const presentationKind = environmentPresentationKind(environment);
      const detail =
        presentationKind === "local"
          ? "Local environment"
          : presentationKind === "t3-connect"
            ? "Relay connection"
            : presentationKind === "ssh"
              ? "SSH environment"
              : (environment.displayUrl ?? "Remote environment");
      return {
        environmentId: environment.environmentId,
        label: environment.label,
        presentationKind,
        detail,
      };
    })
    .sort((left, right) => {
      if (left.presentationKind === "local" && right.presentationKind !== "local") return -1;
      if (right.presentationKind === "local" && left.presentationKind !== "local") return 1;
      return left.label.localeCompare(right.label);
    });
}

function replaceCatalogItem<T extends { readonly id: string }>(
  items: ReadonlyArray<T>,
  item: T,
): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  return items.map((candidate) => (candidate.id === item.id ? item : candidate));
}

export type WorkjetSettingsSectionId =
  | "workers"
  | "computers"
  | "provider-accounts"
  | "llm-routes"
  | "prompt"
  | "telemetry"
  | "execution"
  | "capabilities"
  | "legacy-import";

const WORKJET_SETTINGS_SECTIONS: ReadonlyArray<{
  readonly id: WorkjetSettingsSectionId;
  readonly targetId: string;
  readonly label: string;
}> = [
  { id: "workers", targetId: "workjet-workers", label: "Workers" },
  { id: "computers", targetId: "workjet-computers", label: "Computers" },
  {
    id: "provider-accounts",
    targetId: "workjet-provider-accounts",
    label: "Provider accounts",
  },
  { id: "llm-routes", targetId: "workjet-llm-routes", label: "LLM routes" },
  { id: "prompt", targetId: "workjet-prompt", label: "Prompt" },
  { id: "telemetry", targetId: "workjet-telemetry", label: "Telemetry" },
  { id: "execution", targetId: "workjet-execution", label: "Execution" },
  { id: "capabilities", targetId: "workjet-capabilities", label: "Capabilities" },
  { id: "legacy-import", targetId: "workjet-legacy-import", label: "Legacy import" },
];

export function workjetSectionFromHash(hash: string): WorkjetSettingsSectionId | null {
  const targetId = hash.replace(/^#/, "");
  if (targetId === "greppy-runtime") return "capabilities";
  return WORKJET_SETTINGS_SECTIONS.find((section) => section.targetId === targetId)?.id ?? null;
}

function SectionNavigation({
  activeSection,
  onSelect,
}: {
  readonly activeSection: WorkjetSettingsSectionId;
  readonly onSelect: (section: WorkjetSettingsSectionId) => void;
}) {
  return (
    <nav
      aria-label="Workjet settings areas"
      role="tablist"
      className="mx-3 flex max-w-full gap-1 overflow-x-auto rounded-lg border border-border/60 bg-muted/20 p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:mx-4"
    >
      {WORKJET_SETTINGS_SECTIONS.map((section) => (
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

function ItemActions({
  label,
  onEdit,
  onDelete,
}: {
  readonly label: string;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Edit ${label}`}
        onClick={onEdit}
      >
        <PencilIcon className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Delete ${label}`}
        onClick={onDelete}
      >
        <Trash2Icon className="size-3.5" />
      </Button>
    </div>
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
  if (!Number.isFinite(bytes) || bytes < 0) return "Unavailable";
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
      title="Automatic worktree storage"
      description="Choose the server-local directory used when Workjet creates a worktree without an explicit path."
      status={
        storage.selectedServerId === null ? (
          <span role="alert">No primary Code environment is selected.</span>
        ) : (
          `Selected server: ${storage.selectedServerLabel ?? "Unnamed server"} · ${storage.selectedServerId}`
        )
      }
    >
      <div className="mt-3 max-w-3xl space-y-3 pb-3.5">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            nativeInput
            type="text"
            aria-label="Automatic worktree storage absolute path"
            placeholder="/absolute/path/on/selected/server"
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
              Check
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canApply}
              onClick={() => performAutomaticWorktreeStorageAction(storage, "apply", draftRoot)}
            >
              {storage.isApplying ? <Spinner className="size-3.5" /> : null}
              Apply
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!canReset}
              onClick={() => performAutomaticWorktreeStorageAction(storage, "reset", draftRoot)}
            >
              Use default
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
          <div className="space-y-1 text-xs text-muted-foreground">
            <p className="flex items-center gap-1.5 text-foreground">
              <CheckCircle2Icon className="size-3.5 text-success" />
              Writable · {formatAvailableBytes(checkedInspection.availableBytes)} available
            </p>
            <p className="break-all">
              Checked canonical path:{" "}
              <span className="font-mono">{checkedInspection.canonicalRoot}</span>
            </p>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Check the path on the selected server before applying it.
          </p>
        )}

        <div className="space-y-1 text-xs text-muted-foreground">
          <p className="break-all">
            Effective canonical path:{" "}
            <span className="font-mono">{storage.inspection?.effectiveRoot ?? "Checking…"}</span>
          </p>
          <p className="break-all">
            Immutable default:{" "}
            <span className="font-mono">{storage.inspection?.defaultRoot ?? "Checking…"}</span>
          </p>
          <p>
            Only newly created automatic worktrees use the location; existing worktrees are not
            moved.
          </p>
        </div>
      </div>
    </SettingsRow>
  );
}

export function WorkjetSettingsView({
  configuration,
  environments,
  environmentsReady,
  greppy,
  gateway,
  automaticWorktreeStorage,
  legacyImport,
  defaultSection = "workers",
  onChange,
}: {
  readonly configuration: WorkjetConfiguration;
  readonly environments: ReadonlyArray<WorkjetEnvironmentTargetOption>;
  readonly environmentsReady: boolean;
  readonly greppy: GreppySectionState;
  readonly gateway: WorkjetGatewaySectionState;
  readonly automaticWorktreeStorage: AutomaticWorktreeStorageState;
  /** The one-shot legacy Swift import offer. */
  readonly legacyImport: WorkjetLegacyImportSection;
  readonly defaultSection?: WorkjetSettingsSectionId;
  readonly onChange: (configuration: WorkjetConfiguration) => void;
}) {
  const locationHash = useLocation({ select: (location) => location.hash });
  const [activeSection, setActiveSection] = useState<WorkjetSettingsSectionId>(
    () => workjetSectionFromHash(locationHash) ?? defaultSection,
  );
  const [editingWorkerId, setEditingWorkerId] = useState<string | null>(null);
  const [addingWorker, setAddingWorker] = useState(false);
  const [editingComputerId, setEditingComputerId] = useState<string | null>(null);
  const [addingComputer, setAddingComputer] = useState(false);
  const [editingRouteId, setEditingRouteId] = useState<string | null>(null);
  const [addingRoute, setAddingRoute] = useState(false);
  const editingWorker =
    configuration.workerProfiles.find((worker) => worker.id === editingWorkerId) ?? null;
  const editingComputer =
    configuration.computers.find((computer) => computer.id === editingComputerId) ?? null;
  const editingRoute = configuration.llmRoutes.find((route) => route.id === editingRouteId) ?? null;

  useEffect(() => {
    const section = workjetSectionFromHash(locationHash);
    if (section !== null) setActiveSection(section);
  }, [locationHash]);

  return (
    <SettingsPageContainer className="gap-6">
      <div className="space-y-3">
        <div className="px-3 sm:px-4">
          <h1 className="text-xl font-semibold tracking-[-0.025em]">Workjet</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Compose reusable workers from independent computer, harness, route, model, prompt,
            reasoning, and capability choices.
          </p>
          {legacyImport.hasOffer && activeSection !== "legacy-import" ? (
            // A one-time offer nobody finds is a one-time offer nobody answers,
            // so the page says it is waiting instead of hiding it behind a tab.
            <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span>
                This server still holds an unanswered import offer from the legacy Swift Workjet
                app.
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setActiveSection("legacy-import")}
              >
                Review the import
              </Button>
            </p>
          ) : null}
        </div>
        <SectionNavigation activeSection={activeSection} onSelect={setActiveSection} />
      </div>

      {activeSection === "workers" ? (
        <SettingsSection
          id={searchableSetting("workjet-workers").id}
          title={searchableSetting("workjet-workers").title}
          headerAction={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setEditingWorkerId(null);
                setAddingWorker(true);
              }}
            >
              <PlusIcon className="size-3.5" />
              Add worker
            </Button>
          }
        >
          {configuration.workerProfiles.length === 0 ? (
            <SettingsRow
              title="No saved workers"
              description="Add a reusable worker after configuring a computer and LLM route."
            />
          ) : (
            configuration.workerProfiles.map((worker) => {
              const computer = configuration.computers.find(
                (candidate) => candidate.id === worker.computerId,
              );
              const route = configuration.llmRoutes.find(
                (candidate) => candidate.id === worker.llmRouteId,
              );
              const warning = workjetHarnessAvailabilityWarning(worker, configuration.computers);
              return (
                <SettingsRow
                  key={worker.id}
                  title={worker.name}
                  description={`${computer?.label ?? "Missing computer"} · ${worker.harness} · ${route?.label ?? "Missing route"} · ${worker.modelId}`}
                  status={warning ? <span role="alert">{warning}</span> : undefined}
                  control={
                    <ItemActions
                      label={`worker ${worker.name}`}
                      onEdit={() => {
                        setAddingWorker(false);
                        setEditingWorkerId(worker.id);
                      }}
                      onDelete={() =>
                        onChange({
                          ...configuration,
                          workerProfiles: configuration.workerProfiles.filter(
                            (candidate) => candidate.id !== worker.id,
                          ),
                        })
                      }
                    />
                  }
                />
              );
            })
          )}
          {addingWorker || editingWorker ? (
            <div className="px-3 pt-2 sm:px-4">
              <WorkjetWorkerEditor
                key={editingWorker?.id ?? "new-worker"}
                worker={editingWorker}
                computers={configuration.computers}
                routes={configuration.llmRoutes}
                onCancel={() => {
                  setAddingWorker(false);
                  setEditingWorkerId(null);
                }}
                onSave={(worker: WorkjetWorkerProfile) => {
                  onChange({
                    ...configuration,
                    workerProfiles: replaceCatalogItem(configuration.workerProfiles, worker),
                  });
                  setAddingWorker(false);
                  setEditingWorkerId(null);
                }}
              />
            </div>
          ) : null}
        </SettingsSection>
      ) : null}

      {activeSection === "computers" ? (
        <SettingsSection
          id={searchableSetting("workjet-computers").id}
          title={searchableSetting("workjet-computers").title}
          headerAction={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setEditingComputerId(null);
                setAddingComputer(true);
              }}
              disabled={!environmentsReady || environments.length === 0}
            >
              <PlusIcon className="size-3.5" />
              Add computer
            </Button>
          }
        >
          <SettingsRow
            title={environmentsReady ? "Connection targets" : "Loading connection targets"}
            description="Choose from existing local, relay, SSH, Tailscale, or other remote environments. Connection authority and secrets stay in Connections settings; Workjet stores only the selected target and harness availability."
          />
          {configuration.computers.map((computer) => (
            <SettingsRow
              key={computer.id}
              title={computer.label}
              description={`${computer.presentationKind} · ${computer.environmentId}`}
              status={`${computer.harnesses.filter((harness) => harness.available).length} harnesses marked available`}
              control={
                <ItemActions
                  label={`computer ${computer.label}`}
                  onEdit={() => {
                    setAddingComputer(false);
                    setEditingComputerId(computer.id);
                  }}
                  onDelete={() =>
                    onChange({
                      ...configuration,
                      computers: configuration.computers.filter(
                        (candidate) => candidate.id !== computer.id,
                      ),
                    })
                  }
                />
              }
            />
          ))}
          {addingComputer || editingComputer ? (
            <div className="px-3 pt-2 sm:px-4">
              <WorkjetComputerEditor
                key={editingComputer?.id ?? "new-computer"}
                computer={editingComputer}
                environments={environments}
                onCancel={() => {
                  setAddingComputer(false);
                  setEditingComputerId(null);
                }}
                onSave={(computer: WorkjetComputer) => {
                  onChange({
                    ...configuration,
                    computers: replaceCatalogItem(configuration.computers, computer),
                  });
                  setAddingComputer(false);
                  setEditingComputerId(null);
                }}
              />
            </div>
          ) : null}
        </SettingsSection>
      ) : null}

      {activeSection === "provider-accounts" ? (
        // Pointer only. Two interactive provider surfaces were the defect; the
        // gateway account list now lives beside the harness runtimes on the
        // single Providers page.
        <SettingsSection
          id={searchableSetting("workjet-provider-accounts").id}
          title={searchableSetting("workjet-provider-accounts").title}
        >
          <SettingsRow
            title="Provider accounts moved to Settings → Providers"
            description="Workjet gateway accounts are configured on the single provider surface, beneath the harness runtimes."
            control={
              <a
                href="/settings/providers#workjet-provider-accounts"
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              >
                Open Providers
              </a>
            }
          />
        </SettingsSection>
      ) : null}

      {activeSection === "llm-routes" ? (
        <SettingsSection
          id={searchableSetting("workjet-llm-routes").id}
          title={searchableSetting("workjet-llm-routes").title}
          headerAction={
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                setEditingRouteId(null);
                setAddingRoute(true);
              }}
            >
              <PlusIcon className="size-3.5" />
              Add route
            </Button>
          }
        >
          <SettingsRow
            title="Provider-gateway accounts"
            description="An LLM route references one Workjet provider-gateway account. Code harness drivers such as Codex, Claude, and Grok are intentionally excluded because they are not LLM accounts. Models remain selected on workers."
          />
          {configuration.llmRoutes.map((route) => (
            <SettingsRow
              key={route.id}
              title={route.label}
              description={`Provider-gateway account: ${route.gatewayAccountId}`}
              control={
                <ItemActions
                  label={`LLM route ${route.label}`}
                  onEdit={() => {
                    setAddingRoute(false);
                    setEditingRouteId(route.id);
                  }}
                  onDelete={() =>
                    onChange({
                      ...configuration,
                      llmRoutes: configuration.llmRoutes.filter(
                        (candidate) => candidate.id !== route.id,
                      ),
                    })
                  }
                />
              }
            />
          ))}
          <WorkjetGatewayModelRoutes catalog={gateway.catalog ?? null} />
          {addingRoute || editingRoute ? (
            <div className="px-3 pt-2 sm:px-4">
              <WorkjetLlmRouteEditor
                key={editingRoute?.id ?? "new-route"}
                route={editingRoute}
                accounts={gateway.catalog?.accounts ?? []}
                onCancel={() => {
                  setAddingRoute(false);
                  setEditingRouteId(null);
                }}
                onSave={(route: WorkjetLlmRoute) => {
                  onChange({
                    ...configuration,
                    llmRoutes: replaceCatalogItem(configuration.llmRoutes, route),
                  });
                  setAddingRoute(false);
                  setEditingRouteId(null);
                }}
              />
            </div>
          ) : null}
        </SettingsSection>
      ) : null}

      {activeSection === "prompt" ? (
        <SettingsSection
          id={searchableSetting("workjet-prompt").id}
          title={searchableSetting("workjet-prompt").title}
        >
          <SettingsRow
            title="Managed system prompt"
            description="Shared orchestration rules applied when Workjet composes managed worker instructions."
          >
            <div className="mt-3 max-w-3xl pb-3.5">
              <Textarea
                key={configuration.managedSystemPrompt}
                defaultValue={configuration.managedSystemPrompt}
                rows={8}
                aria-label="Workjet managed system prompt"
                placeholder="Define orchestration, delegation, verification, and recovery rules."
                onBlur={(event) => {
                  const managedSystemPrompt = event.target.value.trim();
                  if (managedSystemPrompt !== configuration.managedSystemPrompt) {
                    onChange({ ...configuration, managedSystemPrompt });
                  }
                }}
              />
            </div>
          </SettingsRow>
        </SettingsSection>
      ) : null}

      {activeSection === "telemetry" ? (
        <SettingsSection
          id={searchableSetting("workjet-telemetry").id}
          title={searchableSetting("workjet-telemetry").title}
        >
          <SettingsRow
            title="Claude Code events"
            description="Collect Workjet lifecycle events emitted by Claude Code workers for status and diagnostics."
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
                aria-label="Collect Claude Code events"
              />
            }
          />
          <SettingsRow
            title="Sidecar events"
            description="Collect Workjet sidecar events used to correlate worker starts, exits, and failures."
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
                aria-label="Collect Workjet sidecar events"
              />
            }
          />
          <SettingsRow
            title="Retention"
            description="Keep local Workjet telemetry for this many days. Runtime cleanup must honor this policy."
            control={
              <div className="flex items-center gap-2">
                <Input
                  nativeInput
                  type="number"
                  min={1}
                  aria-label="Workjet telemetry retention days"
                  value={configuration.telemetry.retentionDays}
                  onChange={(event) => {
                    const retentionDays = Number(event.target.value);
                    if (Number.isInteger(retentionDays) && retentionDays > 0) {
                      onChange({
                        ...configuration,
                        telemetry: { ...configuration.telemetry, retentionDays },
                      });
                    }
                  }}
                  className="w-24"
                />
                <span className="text-xs text-muted-foreground">days</span>
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
            title="Probe timeout"
            description="Maximum time for a bounded worker availability probe."
            control={
              <Input
                nativeInput
                type="number"
                min={1}
                aria-label="Workjet probe timeout seconds"
                value={configuration.execution.probeTimeoutSeconds}
                onChange={(event) => {
                  const probeTimeoutSeconds = Number(event.target.value);
                  if (Number.isInteger(probeTimeoutSeconds) && probeTimeoutSeconds > 0) {
                    onChange({
                      ...configuration,
                      execution: { ...configuration.execution, probeTimeoutSeconds },
                    });
                  }
                }}
                className="w-28"
              />
            }
          />
          <SettingsRow
            title="Turn timeout"
            description="Maximum runtime for one worker turn before the runtime may stop it."
            control={
              <Input
                nativeInput
                type="number"
                min={1}
                aria-label="Workjet turn timeout seconds"
                value={configuration.execution.turnTimeoutSeconds}
                onChange={(event) => {
                  const turnTimeoutSeconds = Number(event.target.value);
                  if (Number.isInteger(turnTimeoutSeconds) && turnTimeoutSeconds > 0) {
                    onChange({
                      ...configuration,
                      execution: { ...configuration.execution, turnTimeoutSeconds },
                    });
                  }
                }}
                className="w-28"
              />
            }
          />
          <SettingsRow
            title="Allow degradation"
            description="Permit an explicitly implemented runtime to use a configured degraded path. This setting does not add fallback execution by itself."
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
                aria-label="Allow Workjet degradation"
              />
            }
          />
        </SettingsSection>
      ) : null}

      {activeSection === "capabilities" ? (
        <>
          <SettingsSection
            id={searchableSetting("workjet-capabilities").id}
            title={searchableSetting("workjet-capabilities").title}
          >
            <SettingsRow
              title="Shared capabilities"
              description="Workers opt into Greppy, Web Research, and Web Stack Browser independently. Runtime availability is checked on the selected computer and does not replace worker composition."
            />
          </SettingsSection>
          <GreppyRuntimeSectionView {...greppy} />
        </>
      ) : null}

      {activeSection === "legacy-import" ? (
        <WorkjetLegacyImportSectionView
          state={legacyImport.state}
          draft={legacyImport.draft}
          onAnswer={legacyImport.onAnswer}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

export function WorkjetSettings() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const { environments, isReady: environmentsReady } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
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
  // The one-shot legacy Swift import. Server-authoritative and per environment:
  // the document lives on the machine THIS server runs on, and the import lands
  // in that server's own settings.
  const legacyImport = useWorkjetLegacyImportSection(environmentId);

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
        setStorageError("Select a primary Code environment before checking storage.");
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
        setStorageError("The selected server could not inspect this storage location.");
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
            title:
              canonicalRoot.length === 0
                ? "Using default worktree storage"
                : "Worktree storage updated",
            description: "New automatic worktrees will use the selected server location.",
          });
        } else if (!isAtomCommandInterrupted(result)) {
          setStorageError("The selected server rejected this storage location.");
        }
      })().finally(() => {
        storageOperationRef.current = false;
        setIsApplyingStorage(false);
      });
    },
    [environmentId, runStorageInspection, updateServerSettings],
  );

  return (
    <WorkjetSettingsView
      configuration={settings.workjet}
      environments={workjetEnvironmentTargetOptions(environments)}
      environmentsReady={environmentsReady}
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
      legacyImport={legacyImport}
      automaticWorktreeStorage={{
        configuredRoot: settings.automaticWorktreeRoot,
        selectedServerLabel: primaryEnvironment?.label ?? null,
        selectedServerId: environmentId,
        inspection: storageInspection,
        error: storageError,
        isChecking: isCheckingStorage,
        isApplying: isApplyingStorage,
        onCheck: (root) => void runStorageInspection(root),
        onApply: handleApplyStorage,
      }}
      onChange={(workjet) => updateSettings({ workjet })}
    />
  );
}
