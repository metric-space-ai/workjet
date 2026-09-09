import type {
  EnvironmentId,
  WorkjetComputer,
  WorkjetConfiguration,
  WorkjetHarnessAvailabilitySnapshot,
} from "@workjet/contracts";
import { CheckIcon, PencilIcon, PlusIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useActiveWorkjetScope } from "../../activeWorkjetScope";
import {
  workjetComputerMembership,
  type ComputerMembershipSnapshot,
} from "../../workjetComputerMembership";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { applyAutomaticCurrentComputer } from "../../state/workjetSettings";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { RemoteEnvironmentsSection } from "./ConnectionsSettings";
import {
  type WorkjetEnvironmentTargetOption,
  WorkjetComputerEditor,
  createWorkjetComputerDraft,
  saveWorkjetComputerDraft,
} from "./WorkjetComputerEditor";
import { workjetEnvironmentTargetOptions } from "./WorkjetSettings";
import {
  ConfirmingDeleteButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { workjetComputerKindLabel } from "../chat/ComposerWorkjetTargetControls";
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
  onInspection,
}: {
  readonly environmentId: EnvironmentId;
  readonly onInspection: (
    environmentId: EnvironmentId,
    inspection: ComputerHarnessInspection | null,
  ) => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.workjetHarnessInspect({ environmentId, input: {} }),
  );
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

/**
 * Computers as a TOP-LEVEL settings page, as the operator specified twice:
 * machines are not a detail of worker configuration — a worker references a
 * computer, so the computer has to exist first and deserves its own place
 * beside Models and Harnesses. The page owns the whole subject: the Workjet
 * computer catalog on top, and the remote environments those computers
 * reference right below it. The legacy Connections route redirects here; its
 * implementation remains an internal source for environment controls.
 */
export function WorkjetComputersSettingsView({
  configuration,
  environments,
  environmentsReady,
  harnessInspection = null,
  harnessInspections,
  environmentId = null,
  onChange,
  membership,
  onAssign,
}: {
  readonly configuration: WorkjetConfiguration;
  readonly environments: ReadonlyArray<WorkjetEnvironmentTargetOption>;
  readonly environmentsReady: boolean;
  /**
   * Live probe of THIS server's harnesses (`workjet.harness.inspect`), plus
   * which environment it describes. Null before the first probe answers —
   * rows then show the declared state with "not probed from here" instead of
   * implying agreement.
   */
  readonly harnessInspection?: WorkjetHarnessAvailabilitySnapshot | null;
  readonly harnessInspections?: Readonly<Record<string, ComputerHarnessInspection>>;
  readonly environmentId?: EnvironmentId | null;
  readonly onChange: (configuration: WorkjetConfiguration) => void;
  readonly membership?: ComputerMembershipSnapshot | undefined;
  readonly onAssign?: ((computer: WorkjetComputer, assigned: boolean) => void) | undefined;
}) {
  const [editingComputerId, setEditingComputerId] = useState<string | null>(null);
  const [addingComputer, setAddingComputer] = useState(() => {
    // Set by the composer's "+ Add computer…" entry: arriving here should
    // open the create editor, not just the list (Befund F8).
    try {
      if (window.sessionStorage.getItem("workjet-computer-create") !== null) {
        window.sessionStorage.removeItem("workjet-computer-create");
        return true;
      }
    } catch {
      // Blocked storage: plain list.
    }
    return false;
  });
  const editingComputer =
    configuration.computers.find((computer) => computer.id === editingComputerId) ?? null;
  const computerEditor = (
    <div className="px-3 pt-2 sm:px-4">
      <WorkjetComputerEditor
        key={editingComputer?.id ?? "new-computer"}
        computer={editingComputer}
        environments={environments}
        availability={
          editingComputer === null
            ? null
            : harnessInspections !== undefined
              ? (harnessInspections[editingComputer.environmentId]?.snapshot ?? null)
              : environmentId === editingComputer.environmentId
                ? harnessInspection
                : null
        }
        onCancel={() => {
          setAddingComputer(false);
          setEditingComputerId(null);
        }}
        onSave={(computer: WorkjetComputer) => {
          onChange(
            applyAutomaticCurrentComputer(
              {
                ...configuration,
                computers: replaceComputer(computer),
              },
              environmentId,
            ),
          );
          setAddingComputer(false);
          setEditingComputerId(null);
          toastManager.add({
            type: "success",
            title: "Computer saved",
            description: computer.label,
          });
        }}
      />
    </div>
  );

  const replaceComputer = (computer: WorkjetComputer): ReadonlyArray<WorkjetComputer> => {
    const existing = configuration.computers;
    return existing.some((candidate) => candidate.id === computer.id)
      ? existing.map((candidate) => (candidate.id === computer.id ? computer : candidate))
      : [...existing, computer];
  };

  return (
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
          Add existing connection
        </Button>
      }
    >
      <SettingsRow
        title={environmentsReady ? "Computer targets" : "Loading computer targets"}
        description="Select the computer for your next session, or edit its name and coding tools."
      />
      {/* The editor renders where the user is looking: adding — right here
          under the header button; editing — directly below the edited row
          (mounted at the page bottom it sat below the fold and the pencil
          looked dead). */}
      {addingComputer ? computerEditor : null}
      {configuration.computers.length === 0 ? (
        <SettingsRow
          title="No computers yet"
          description="Use this computer or connect another one with the setup buttons above."
        />
      ) : null}
      <div role="radiogroup" aria-label="Current computer" className="space-y-1">
        {configuration.computers.map((computer) => {
          // Each probe belongs to its target environment. Never present this
          // Mac's tools as the capabilities of an SSH or Tailscale computer.
          const inspection = harnessInspections?.[computer.environmentId];
          const disconnected =
            environmentsReady &&
            computer.environmentId !== environmentId &&
            !environments.some((entry) => entry.environmentId === computer.environmentId);
          const computerInspection = disconnected
            ? null
            : harnessInspections !== undefined
              ? (inspection?.snapshot ?? null)
              : environmentId === computer.environmentId
                ? harnessInspection
                : null;
          // The environment's human label, never its raw id — an operator
          // recognises "gpu3-a4500", not a UUID. When the environment left the
          // catalog, the kind alone is the only truthful thing left to show.
          const environmentLabel =
            environments.find((environment) => environment.environmentId === computer.environmentId)
              ?.label ?? null;
          const isCurrent = configuration.selectedComputerId === computer.id;
          const locationDescription =
            environmentId === computer.environmentId
              ? "This machine"
              : environmentLabel === null
                ? workjetComputerKindLabel(computer.presentationKind)
                : `${workjetComputerKindLabel(computer.presentationKind)} · ${environmentLabel}`;
          return (
            <Fragment key={computer.id}>
              <SettingsRow
                title={computer.label}
                description={
                  isCurrent ? `${locationDescription} · Current computer` : locationDescription
                }
                control={
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant={isCurrent ? "secondary" : "ghost"}
                      role="radio"
                      aria-checked={isCurrent}
                      aria-label={
                        isCurrent
                          ? `Stop using ${computer.label} as current computer`
                          : `Use ${computer.label} as current computer`
                      }
                      onClick={() => onChange(toggleCurrentComputer(configuration, computer.id))}
                    >
                      {isCurrent ? <CheckIcon className="size-3.5" /> : null}
                      {isCurrent ? "Current computer" : "Use as current computer"}
                    </Button>
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Edit computer ${computer.label}`}
                      onClick={() => {
                        setAddingComputer(false);
                        setEditingComputerId(computer.id);
                      }}
                    >
                      <PencilIcon className="size-3.5" />
                    </Button>
                    <ConfirmingDeleteButton
                      label={`computer ${computer.label}`}
                      onDelete={() => onChange(removeComputer(configuration, computer.id))}
                    />
                  </div>
                }
              >
                <div className="mt-1 space-y-1 pb-3">
                  {onAssign && membership ? (
                    <div className="flex flex-wrap items-center gap-2 pb-2">
                      <span className="text-xs text-muted-foreground">
                        {membership.phase === "loading"
                          ? "Checking Business OS assignment…"
                          : membership.phase === "failed"
                            ? "Business OS assignment could not be checked"
                            : membership.computers.some((entry) => entry.id === computer.id)
                              ? "Available in the selected Business OS"
                              : "Not added to the selected Business OS"}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={
                          membership.phase !== "ready" || membership.pendingComputerId !== null
                        }
                        aria-label={`${membership.computers.some((entry) => entry.id === computer.id) ? "Remove" : "Add"} ${computer.label} ${membership.computers.some((entry) => entry.id === computer.id) ? "from" : "to"} selected Business OS`}
                        onClick={() =>
                          onAssign(
                            computer,
                            !membership.computers.some((entry) => entry.id === computer.id),
                          )
                        }
                      >
                        {membership.pendingComputerId === computer.id
                          ? "Waiting for confirmation…"
                          : membership.computers.some((entry) => entry.id === computer.id)
                            ? "Remove from Business OS"
                            : "Add to Business OS"}
                      </Button>
                    </div>
                  ) : null}
                  {(disconnected || harnessInspections !== undefined) &&
                  computerInspection === null ? (
                    <p role="status" className="text-xs text-muted-foreground">
                      {disconnected
                        ? "Disconnected. Reconnect this computer to check its coding tools."
                        : inspection?.error
                          ? "Could not check coding tools. Check this computer’s connection."
                          : "Checking coding tools…"}
                    </p>
                  ) : null}
                  {computer.harnesses.map((declared) => {
                    const live =
                      computerInspection?.harnesses.find(
                        (entry) => entry.harness === declared.harness,
                      ) ?? null;
                    const state =
                      live === null
                        ? declared.available
                          ? "declared"
                          : "off"
                        : live.availability === "available"
                          ? "ok"
                          : "missing";
                    const detail =
                      live === null
                        ? declared.available
                          ? "declared available · not probed from here"
                          : "not offered"
                        : live.availability === "available"
                          ? `${live.version ? `v${live.version} · ` : ""}${live.executablePath}`
                          : humanizeHarnessProbeReason(live.reason);
                    return (
                      <p
                        key={declared.harness}
                        className="flex items-center gap-2 pl-1 text-xs text-muted-foreground"
                      >
                        <span
                          aria-hidden
                          className={
                            state === "ok"
                              ? "size-1.5 shrink-0 rounded-full bg-emerald-500"
                              : state === "missing"
                                ? "size-1.5 shrink-0 rounded-full bg-amber-500"
                                : "size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
                          }
                        />
                        <span className="w-28 shrink-0 font-medium text-foreground">
                          {workjetHarnessDisplayLabel(declared.harness)}
                        </span>
                        <span className="min-w-0 truncate">{detail}</span>
                      </p>
                    );
                  })}
                  {computer.harnesses.length === 0 ? (
                    <p className="pl-1 text-xs text-muted-foreground">
                      No harnesses declared — edit the computer to declare them.
                    </p>
                  ) : null}
                </div>
              </SettingsRow>
              {editingComputer?.id === computer.id ? computerEditor : null}
            </Fragment>
          );
        })}
      </div>
      <SettingsRow
        title="Connection security"
        description="Remote environments are paired and removed below, then become selectable computer targets. Authentication material remains with its owning environment and is never copied into a computer entry."
      />
    </SettingsSection>
  );
}

export function WorkjetComputersSettings() {
  const { selectedInstanceId } = useActiveWorkjetScope();
  const membership = useSyncExternalStore(
    workjetComputerMembership.subscribe,
    workjetComputerMembership.getSnapshot,
    workjetComputerMembership.getSnapshot,
  );
  const activeMembership = membership.instanceId === selectedInstanceId ? membership : undefined;
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const { environments, isReady: environmentsReady } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const [harnessInspections, setHarnessInspections] = useState<
    Readonly<Record<string, ComputerHarnessInspection>>
  >({});
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
  const [connectionRequest, setConnectionRequest] = useState<{
    kind: "ssh" | "tailscale";
    sequence: number;
  } | null>(null);
  const [pendingComputerId, setPendingComputerId] = useState<EnvironmentId | null>(null);
  const targetOptions = workjetEnvironmentTargetOptions(environments);
  const pendingTarget = targetOptions.find((target) => target.environmentId === pendingComputerId);
  const pendingInspection = useEnvironmentQuery(
    pendingComputerId === null
      ? null
      : serverEnvironment.workjetHarnessInspect({ environmentId: pendingComputerId, input: {} }),
  );
  useEffect(() => {
    if (!pendingTarget || !pendingInspection.data) return;
    const existing = settings.workjet.computers.find(
      (computer) => computer.environmentId === pendingTarget.environmentId,
    );
    const draft = createWorkjetComputerDraft({ environments: [pendingTarget] });
    const computer =
      existing ??
      saveWorkjetComputerDraft({
        ...draft,
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
    setPendingComputerId(null);
  }, [pendingTarget, pendingInspection.data, settings.workjet, updateSettings]);
  // Live harness probe of this server, for the per-computer rows. Same
  // environment-query mechanics as every other read on this page.
  const harnessInspectQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.workjetHarnessInspect({ environmentId, input: {} }),
  );

  return (
    <SettingsPageContainer className="gap-6">
      {[...new Set(settings.workjet.computers.map((computer) => computer.environmentId))]
        .filter((target) => targetOptions.some((option) => option.environmentId === target))
        .map((target) => (
          <ComputerHarnessProbe
            key={target}
            environmentId={target}
            onInspection={recordHarnessInspection}
          />
        ))}
      <div className="px-3 sm:px-4">
        <h1 className="text-xl font-semibold tracking-[-0.025em]">Computers</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Connect a computer, check its coding tools, and choose where your next task runs.
        </p>
      </div>
      <SettingsSection title="Set up a computer">
        <div className="space-y-3 px-3 sm:px-4">
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={!environmentsReady || environmentId === null || pendingComputerId !== null}
              onClick={() => setPendingComputerId(environmentId)}
            >
              Use this computer
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                setConnectionRequest((current) => ({
                  kind: "ssh",
                  sequence: (current?.sequence ?? 0) + 1,
                }))
              }
            >
              Connect over SSH
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                setConnectionRequest((current) => ({
                  kind: "tailscale",
                  sequence: (current?.sequence ?? 0) + 1,
                }))
              }
            >
              Connect over Tailscale
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Workjet checks the connection and installed coding tools, then adds the computer to your
            list.
          </p>
          {pendingComputerId ? (
            <p role="status" className="text-sm">
              Checking {pendingTarget?.label ?? "the connected computer"} and its coding tools…
            </p>
          ) : null}
          {pendingComputerId && pendingInspection.error ? (
            <div role="alert" className="text-sm text-destructive">
              The computer did not report its coding tools. Check its connection and try again.
              <Button variant="outline" onClick={() => setPendingComputerId(null)}>
                Dismiss
              </Button>
            </div>
          ) : null}
        </div>
      </SettingsSection>
      {selectedInstanceId ? (
        <div className="space-y-2 px-3 sm:px-4">
          <p className="text-sm">
            Add a computer to the selected Business OS to make it available for coding tasks there.
          </p>
          {activeMembership?.phase === "loading" ? (
            <p role="status" className="text-sm">
              Checking assigned computers…
            </p>
          ) : null}
          {activeMembership?.error ? (
            <p role="alert" className="text-sm text-destructive">
              {activeMembership.error}
            </p>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={
              activeMembership?.phase === "loading" || activeMembership?.pendingComputerId != null
            }
            onClick={() => {
              void workjetComputerMembership.refresh(
                selectedInstanceId,
                window.desktopBridge?.ctox,
              );
            }}
          >
            Refresh assignments
          </Button>
        </div>
      ) : (
        <p className="px-3 text-sm sm:px-4">Select a Business OS to add computers to it.</p>
      )}
      <WorkjetComputersSettingsView
        configuration={settings.workjet}
        environments={workjetEnvironmentTargetOptions(environments)}
        environmentsReady={environmentsReady}
        harnessInspection={harnessInspectQuery.data ?? null}
        harnessInspections={harnessInspections}
        environmentId={environmentId}
        onChange={(workjet) => updateSettings({ workjet })}
        membership={activeMembership}
        onAssign={
          selectedInstanceId
            ? (computer, assigned) => {
                void workjetComputerMembership.setAssigned(
                  selectedInstanceId,
                  computer,
                  assigned,
                  window.desktopBridge?.ctox,
                );
              }
            : undefined
        }
      />
      <RemoteEnvironmentsSection
        connectionRequest={connectionRequest}
        onConnected={setPendingComputerId}
      />
      <details className="mx-3 rounded-lg border border-border p-3 sm:mx-4">
        <summary className="cursor-pointer text-sm font-medium">
          Install or repair backend software
        </summary>
        <ComputerProvisioningSection />
      </details>
    </SettingsPageContainer>
  );
}

/** Probe reasons arrive as slugs; the row speaks prose (Befund F11). */
function humanizeHarnessProbeReason(reason: string): string {
  const known: Record<string, string> = {
    "executable-not-found": "Executable not found",
    "probe-failed": "Probe failed",
    "not-supported": "Not supported on this computer",
  };
  const mapped = known[reason];
  if (mapped !== undefined) return mapped;
  const spaced = reason.replace(/-/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
