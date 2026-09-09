import type {
  EnvironmentId,
  WorkjetComputer,
  WorkjetConfiguration,
  WorkjetHarnessAvailabilitySnapshot,
} from "@workjet/contracts";
import { CheckIcon, PencilIcon, PlusIcon } from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
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
import { useEnvironments, usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { applyAutomaticCurrentComputer } from "../../state/workjetSettings";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { useComputerConnections } from "./ConnectionsSettings";
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

/** Saved connections and configured computers share one catalog in the UI. */
export function includeSavedComputers(
  configuration: WorkjetConfiguration,
  targets: ReadonlyArray<WorkjetEnvironmentTargetOption>,
  primaryEnvironmentId: EnvironmentId | null,
): WorkjetConfiguration {
  const missing = targets.filter(
    (target) =>
      target.environmentId !== primaryEnvironmentId &&
      !configuration.computers.some((computer) => computer.environmentId === target.environmentId),
  );
  if (missing.length === 0) return configuration;
  return {
    ...configuration,
    computers: [
      ...configuration.computers,
      ...missing.map((target) =>
        saveWorkjetComputerDraft(
          createWorkjetComputerDraft({
            environments: [target],
            id: `connection-${target.environmentId}`,
          }),
        ),
      ),
    ],
  };
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
  onAssign,
  onAdd,
  onRemove,
  renderConnection,
  connectedEnvironmentIds,
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
  readonly onAdd?: () => void;
  readonly onRemove?: (computer: WorkjetComputer) => void;
  readonly renderConnection?: (environmentId: EnvironmentId) => ReactNode;
  readonly connectedEnvironmentIds?: ReadonlyArray<EnvironmentId>;
}) {
  const [editingComputerId, setEditingComputerId] = useState<string | null>(null);
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
          onClick={onAdd}
          disabled={onAdd === undefined}
        >
          <PlusIcon className="size-3.5" />
          Add computer
        </Button>
      }
    >
      <SettingsRow
        title={environmentsReady ? "Your computers" : "Loading computers…"}
        description="Select the computer for your next session, or edit its name and coding tools."
      />
      {configuration.computers.length === 0 ? (
        <SettingsRow
          title="No computers yet"
          description="Add this computer, an SSH host, or a computer on your Tailscale network."
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
            !(connectedEnvironmentIds ?? environments.map((entry) => entry.environmentId)).includes(
              computer.environmentId,
            );
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
                        setEditingComputerId(computer.id);
                      }}
                    >
                      <PencilIcon className="size-3.5" />
                    </Button>
                    <ConfirmingDeleteButton
                      label={`computer ${computer.label}`}
                      onDelete={() =>
                        onRemove
                          ? onRemove(computer)
                          : onChange(removeComputer(configuration, computer.id))
                      }
                    />
                  </div>
                }
              >
                {renderConnection?.(computer.environmentId)}
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
                          membership.phase !== "ready" ||
                          membership.pendingComputerId !== null ||
                          (disconnected &&
                            !membership.computers.some((entry) => entry.id === computer.id))
                        }
                        data-workjet-action={`computer-${computer.id}-${membership.computers.some((entry) => entry.id === computer.id) ? "unassign" : "assign"}`}
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
                  <details>
                    <summary className="cursor-pointer text-xs text-muted-foreground">
                      Coding tools
                    </summary>
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
                        No coding tools enabled. Edit this computer to choose them.
                      </p>
                    ) : null}
                  </details>
                </div>
              </SettingsRow>
              {editingComputer?.id === computer.id ? computerEditor : null}
            </Fragment>
          );
        })}
      </div>
    </SettingsSection>
  );
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
  const [setupComputer, setSetupComputer] = useState<WorkjetComputer | null>(null);
  const [pendingComputerId, setPendingComputerId] = useState<EnvironmentId | null>(null);
  const [pendingKind, setPendingKind] = useState<"local" | "ssh" | "tailscale" | undefined>();
  const targetOptions = workjetEnvironmentTargetOptions(environments);
  const configuration = includeSavedComputers(settings.workjet, targetOptions, environmentId);
  const connections = useComputerConnections({
    inline: setupOnly,
    localAvailable: environmentsReady && primaryEnvironment?.connection.phase === "connected",
    onConnected: (id, kind) => {
      setPendingKind(kind);
      setPendingComputerId(id);
    },
  });
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
        presentationKind: pendingKind ?? draft.presentationKind,
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
    setSetupComputer(computer);
    setPendingComputerId(null);
  }, [pendingTarget, pendingKind, pendingInspection.data, settings.workjet, updateSettings]);
  const setupBusy = connections.busy || membership.pendingComputerId !== null;
  useEffect(() => {
    onBusyChange?.(setupBusy);
    return () => onBusyChange?.(false);
  }, [setupBusy, onBusyChange]);
  // Live harness probe of this server, for the per-computer rows. Same
  // environment-query mechanics as every other read on this page.
  const harnessInspectQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.workjetHarnessInspect({ environmentId, input: {} }),
  );

  if (setupOnly)
    return (
      <div className="space-y-4">
        {setupComputer === null && pendingComputerId === null ? connections.form : null}
        {pendingComputerId !== null ? (
          <p role="status">Verbindung hergestellt. Coding-Harnesses werden geprüft…</p>
        ) : null}
        {pendingInspection.error ? (
          <div role="alert">
            <p>Die Harnesses konnten noch nicht geprüft werden.</p>
            <Button variant="outline" onClick={() => setPendingComputerId(null)}>
              Erneut verbinden
            </Button>
          </div>
        ) : null}
        {setupComputer !== null ? (
          <>
            <p className="font-medium">{setupComputer.label}</p>
            <p className="text-sm text-muted-foreground">
              Der Computer ist mit dieser App verbunden. Füge ihn jetzt dem ausgewählten
              CTOX-Netzwerk hinzu.
            </p>
            <div className="flex flex-wrap gap-2">
              {setupComputer.harnesses
                .filter((harness) => harness.available)
                .map((harness) => (
                  <span key={harness.harness} className="rounded-md bg-muted px-2 py-1 text-xs">
                    {workjetHarnessDisplayLabel(harness.harness)}
                  </span>
                ))}
            </div>
            {activeMembership?.phase === "loading" ? (
              <p role="status">Die Instanzzuordnung wird geprüft…</p>
            ) : null}
            {activeMembership?.error ? (
              <p role="alert" className="text-sm text-destructive">
                {activeMembership.error}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={
                  !selectedInstanceId ||
                  activeMembership?.phase !== "ready" ||
                  activeMembership.pendingComputerId !== null
                }
                onClick={() => {
                  if (!selectedInstanceId) return;
                  void membershipStore
                    .setAssigned(
                      selectedInstanceId,
                      setupComputer,
                      true,
                      window.desktopBridge?.ctox,
                    )
                    .then((confirmed) => {
                      if (confirmed) onCompleted?.();
                    });
                }}
              >
                Dem Netzwerk hinzufügen
              </Button>
              {activeMembership?.phase === "failed" ? (
                <Button
                  variant="outline"
                  onClick={() => {
                    if (selectedInstanceId)
                      void membershipStore.refresh(selectedInstanceId, window.desktopBridge?.ctox);
                  }}
                >
                  Zuordnung erneut prüfen
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </div>
    );

  return (
    <SettingsPageContainer className="gap-6">
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
            onInspection={recordHarnessInspection}
          />
        ))}
      {connections.dialog}
      <div className="px-3 sm:px-4">
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
      <WorkjetComputersSettingsView
        configuration={configuration}
        environments={workjetEnvironmentTargetOptions(environments)}
        environmentsReady={environmentsReady}
        harnessInspection={harnessInspectQuery.data ?? null}
        harnessInspections={harnessInspections}
        environmentId={environmentId}
        onChange={(workjet) => updateSettings({ workjet })}
        onAdd={connections.openAddComputer}
        renderConnection={connections.renderConnection}
        connectedEnvironmentIds={environments
          .filter((entry) => entry.connection.phase === "connected")
          .map((entry) => entry.environmentId)}
        onRemove={(computer) => {
          void (async () => {
            if (
              selectedInstanceId &&
              (activeMembership?.phase !== "ready" ||
                activeMembership.computers.some((entry) => entry.id === computer.id))
            ) {
              toastManager.add({
                type: "error",
                title: "Computer still assigned",
                description:
                  "Remove this computer from the selected Business OS before removing its connection.",
              });
              return;
            }
            const shared = configuration.computers.some(
              (entry) => entry.id !== computer.id && entry.environmentId === computer.environmentId,
            );
            const saved = connections.savedEnvironments.some(
              (entry) => entry.environmentId === computer.environmentId,
            );
            if (!shared && saved && !(await connections.removeConnection(computer.environmentId)))
              return;
            updateSettings({ workjet: removeComputer(configuration, computer.id) });
          })();
        }}
        membership={activeMembership}
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
      />
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
              void membershipStore.refresh(selectedInstanceId, window.desktopBridge?.ctox);
            }}
          >
            Refresh assignments
          </Button>
        </div>
      ) : (
        <p className="px-3 text-sm sm:px-4">Select a Business OS to add computers to it.</p>
      )}
      <details className="mx-3 rounded-lg border border-border p-3 sm:mx-4">
        <summary className="cursor-pointer text-sm font-medium">Advanced setup and repair</summary>
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
