import type {
  EnvironmentId,
  GreppyRuntimeReason,
  GreppyRuntimeSnapshot,
  GreppyRuntimeSource,
  WorktreeStorageInspection,
  WorkjetComputerPresentationKind,
  WorkjetConfiguration,
  WorkjetWorkerProfile,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  CheckCircle2Icon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import { useMemo, Fragment, useCallback, useEffect, useRef, useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { type EnvironmentPresentation, usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import type { WorkjetEnvironmentTargetOption } from "./WorkjetComputerEditor";
import type { WorkjetGatewaySectionState } from "./WorkjetGatewayAccounts";
import { useWorkjetGatewaySection } from "./useWorkjetGatewaySection";
import {
  workjetHarnessDisplayLabel,
  workjetReasoningDisplayLabel,
  WorkjetWorkerEditor,
  workjetHarnessAvailabilityWarning,
} from "./WorkjetWorkerEditor";
import {
  ConfirmingDeleteButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import {
  joinManagedPrompt,
  replaceSectionBody,
  sectionBody,
  splitManagedPrompt,
} from "./managedPromptSections";

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

export type WorkjetSettingsSectionId = "workers" | "prompt" | "telemetry" | "execution";

function modelPromptFor(configuration: WorkjetConfiguration, modelId: string): string {
  return configuration.modelPrompts.find((entry) => entry.modelId === modelId)?.prompt ?? "";
}

export const WORKJET_SETTINGS_SECTIONS: ReadonlyArray<{
  readonly id: WorkjetSettingsSectionId;
  readonly targetId: string;
  readonly label: string;
}> = [
  // Four tabs, mirroring the Swift original's settings page after the
  // operator's re-mapping: Computers is a TOP-LEVEL settings page, provider
  // accounts and LLM routes live on Models beside the accounts they
  // reference, and capabilities are toggled inside the worker editor.
  { id: "workers", targetId: "workjet-workers", label: "Workers" },
  { id: "prompt", targetId: "workjet-prompt", label: "Prompt" },
  { id: "telemetry", targetId: "workjet-telemetry", label: "Telemetry" },
  { id: "execution", targetId: "workjet-execution", label: "Execution" },
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
      <ConfirmingDeleteButton label={label} onDelete={onDelete} />
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
      title={searchableSetting("automatic-worktree-storage").title}
      description="Choose the server-local directory used when Workjet creates a worktree without an explicit path."
      status={
        storage.selectedServerId === null ? (
          <span role="alert">No primary Code environment is selected.</span>
        ) : (
          `Selected server: ${storage.selectedServerLabel ?? "Unnamed server"}`
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
  greppy,
  gateway,
  automaticWorktreeStorage,
  defaultSection = "workers",
  onChange,
}: {
  readonly configuration: WorkjetConfiguration;
  readonly greppy: GreppySectionState;
  readonly gateway: WorkjetGatewaySectionState;
  readonly automaticWorktreeStorage: AutomaticWorktreeStorageState;
  readonly defaultSection?: WorkjetSettingsSectionId;
  readonly onChange: (configuration: WorkjetConfiguration) => void;
}) {
  const locationHash = useLocation({ select: (location) => location.hash });
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState<WorkjetSettingsSectionId>(
    () => workjetSectionFromHash(locationHash) ?? defaultSection,
  );
  // A stashed draft means the operator left via "Add LLM route…" and came
  // back — reopen the editor they were in so the stash gets consumed (K-A7).
  const stashedWorkerEditor = useMemo(() => {
    try {
      for (let index = 0; index < window.sessionStorage.length; index += 1) {
        const key = window.sessionStorage.key(index);
        if (key?.startsWith("workjet-worker-draft:")) {
          return key.slice("workjet-worker-draft:".length);
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
  const promptSections = splitManagedPrompt(configuration.managedSystemPrompt);
  const editingWorker =
    configuration.workerProfiles.find((worker) => worker.id === editingWorkerId) ?? null;
  const workerEditor = (
    <div className="px-3 pt-2 sm:px-4">
      <WorkjetWorkerEditor
        key={editingWorker?.id ?? "new-worker"}
        worker={editingWorker}
        computers={configuration.computers}
        routes={configuration.llmRoutes}
        onAddRoute={() =>
          // LLM routes live on the Models page; "Set up access" takes the
          // operator to where an access is actually created.
          void navigate({
            to: "/settings/models",
            hash: "workjet-llm-routes",
            hashScrollIntoView: false,
          })
        }
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
          // The saved row can sit below the fold; without this the viewport
          // shows no evidence the save happened (interactive-review finding).
          toastManager.add({
            type: "success",
            title: "Worker saved",
            description: worker.name,
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
    <SettingsPageContainer className="gap-6">
      <div className="space-y-3">
        <div className="px-3 sm:px-4">
          <h1 className="text-xl font-semibold tracking-[-0.025em]">Worker</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Compose reusable workers from independent computer, harness, route, model, prompt,
            reasoning, and capability choices.
          </p>
        </div>
        <SectionNavigation
          activeSection={activeSection}
          onSelect={(section) => {
            setActiveSection(section);
            // Keep the URL truthful: after a hash-deep-link the tab click used
            // to leave the OLD anchor in the address bar, so a reload landed
            // on the wrong tab (Befund K-A15b).
            const target = WORKJET_SETTINGS_SECTIONS.find((entry) => entry.id === section);
            if (target !== undefined) {
              window.history.replaceState(window.history.state, "", `#${target.targetId}`);
            }
          }}
        />
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
          {/* The editor renders WHERE THE USER IS LOOKING: adding — right
              here under the header button; editing — directly below the
              edited row. Mounted at the list bottom it sat below the fold on
              a 12-worker list and the pencil looked dead (measured: editor
              at y=1456 in an 844px viewport). */}
          {addingWorker ? workerEditor : null}
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
                <Fragment key={worker.id}>
                  <SettingsRow
                    title={worker.name}
                    description={`${computer?.label ?? "Missing computer"} · ${workjetHarnessDisplayLabel(worker.harness)} · ${route?.label ?? "Missing route"} · ${worker.modelId}`}
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
                  {editingWorker?.id === worker.id ? workerEditor : null}
                </Fragment>
              );
            })
          )}
        </SettingsSection>
      ) : null}

      {activeSection === "prompt" ? (
        <SettingsSection
          id={searchableSetting("workjet-prompt").id}
          title={searchableSetting("workjet-prompt").title}
        >
          {/* The Swift page shows this prompt as named cards, each with its own
              edit affordance, instead of one 6 KB scroll box. Same here — but
              as a VIEW: the sections are found by the headings already in the
              text and joined straight back, because the prompt is deliberately
              one stored field and a second home would give the importer two
              targets for one source. */}
          {promptSections.map((section, index) => (
            <SettingsRow
              key={`${section.title ?? "preamble"}-${String(index)}`}
              title={section.title ?? "Preamble"}
              description={
                section.title === null
                  ? "Everything before the first heading."
                  : "Edit this part on its own; the rest of the prompt is untouched."
              }
            >
              <div className="mt-2 max-w-3xl pb-3.5">
                <Textarea
                  key={`${configuration.managedSystemPrompt.length}-${String(index)}`}
                  defaultValue={sectionBody(section)}
                  rows={Math.min(16, Math.max(4, section.bodyLines.length))}
                  aria-label={`Prompt section ${section.title ?? "preamble"}`}
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
            <SettingsRow
              title="Worker tasks"
              description="Each worker's own instructions, appended to the shared rules above when Workjet composes its prompt."
            >
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
                            )?.label ?? "unknown computer",
                            workjetReasoningDisplayLabel(worker.reasoning),
                          ].join(" · ")}
                        </span>
                      </div>
                      {/* Model rules — the Swift page's "MODELL · …" block:
                        guidance shared by every worker on this model, edited
                        here per model (changing it changes it for all of
                        them) and prepended to the task at dispatch. */}
                      <div className="mt-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                        Model rules · {worker.modelId}
                      </div>
                      {modelRulesEditorHere ? null : (
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Shared with {modelRulesOwner?.name ?? "the worker above"} — edit them
                          there.
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
                          aria-label={`Model rules for ${worker.modelId}`}
                          placeholder="No model rules — shared guidance for every worker on this model."
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
                        Worker task
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
                        aria-label={`Task for worker ${worker.name}`}
                        placeholder="No task set — describe what this worker takes on."
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
                <PositiveIntegerInput
                  ariaLabel="Workjet telemetry retention days"
                  value={configuration.telemetry.retentionDays}
                  onCommit={(retentionDays) =>
                    onChange({
                      ...configuration,
                      telemetry: { ...configuration.telemetry, retentionDays },
                    })
                  }
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
              <PositiveIntegerInput
                ariaLabel="Workjet probe timeout seconds"
                value={configuration.execution.probeTimeoutSeconds}
                onCommit={(probeTimeoutSeconds) =>
                  onChange({
                    ...configuration,
                    execution: { ...configuration.execution, probeTimeoutSeconds },
                  })
                }
                className="w-28"
              />
            }
          />
          <SettingsRow
            title="Turn timeout"
            description="Maximum runtime for one worker turn before the runtime may stop it."
            control={
              <PositiveIntegerInput
                ariaLabel="Workjet turn timeout seconds"
                value={configuration.execution.turnTimeoutSeconds}
                onCommit={(turnTimeoutSeconds) =>
                  onChange({
                    ...configuration,
                    execution: { ...configuration.execution, turnTimeoutSeconds },
                  })
                }
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
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
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
      {...(defaultSection ? { defaultSection } : {})}
      configuration={settings.workjet}
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
