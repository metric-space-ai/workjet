import type {
  EnvironmentId,
  GreppyRuntimeReason,
  GreppyRuntimeSnapshot,
  GreppyRuntimeSource,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { CheckCircle2Icon, RefreshCwIcon, TriangleAlertIcon, WrenchIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { usePrimaryEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
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
        description="Inspect or install the pinned Greppy runtime managed by this T3 server."
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

export function WorkjetSettings() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const query = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.greppyRuntimeInspect({ environmentId, input: {} }),
  );
  const install = useAtomCommand(serverEnvironment.installGreppyRuntime, { reportFailure: false });
  const operatingRef = useRef(false);
  const [isOperating, setIsOperating] = useState(false);
  const action = greppyRuntimeAction(query.data);

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

  return (
    <SettingsPageContainer>
      <GreppyRuntimeSectionView
        snapshot={query.data}
        isInitialLoading={query.isPending && query.data === null}
        hasInspectFailure={query.error !== null}
        isRefreshing={query.isPending && query.data !== null}
        isOperating={isOperating}
        onRefresh={query.refresh}
        onInstall={handleInstall}
      />
    </SettingsPageContainer>
  );
}
