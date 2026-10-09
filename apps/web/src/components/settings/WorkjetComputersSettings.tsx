import { useAtomCommand } from "../../state/use-atom-command";
import type {
  EnvironmentId,
  CtoxWorkjetComputerProjection,
  CtoxComputerOperationalCapability,
  WorkjetComputer,
  WorkjetConfiguration,
  WorkjetHarnessAvailabilitySnapshot,
} from "@workjet/contracts";
import { MoreHorizontalIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
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
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuSeparator } from "../ui/menu";
import {
  Sheet,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
  SheetDescription,
} from "../ui/sheet";
import { useCtoxMode } from "../ctox/CtoxModeShell";
import { resolveSettingsInstanceContext } from "./settingsInstanceContext";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import { ComputerCapabilitiesEditor } from "./ComputerCapabilitiesEditor";
import type { OperationalComputerEnrollment } from "../../computerCapabilityEnrollment";
import { toastManager } from "../ui/toast";
import { useComputerConnections } from "./ConnectionsSettings";
import {
  type WorkjetEnvironmentTargetOption,
  WorkjetComputerEditor,
  createWorkjetComputerDraft,
  saveWorkjetComputerDraft,
} from "./WorkjetComputerEditor";
import { workjetEnvironmentTargetOptions } from "./WorkjetSettings";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
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

/** Host identity is presentation metadata; it never authorizes a connection or worker. */
export function findComputerForTarget(
  configuration: WorkjetConfiguration,
  target: WorkjetEnvironmentTargetOption,
  targets: ReadonlyArray<WorkjetEnvironmentTargetOption>,
): WorkjetComputer | undefined {
  const exact = configuration.computers.find(
    (computer) => computer.environmentId === target.environmentId,
  );
  if (exact) return exact;
  const hostId = target.hostId?.trim();
  if (!hostId) return undefined;
  return configuration.computers.find((computer) =>
    targets.some(
      (option) =>
        option.environmentId === computer.environmentId && option.hostId?.trim() === hostId,
    ),
  );
}

/** Saved connections and configured computers share one catalog in the UI. */
export function includeSavedComputers(
  configuration: WorkjetConfiguration,
  targets: ReadonlyArray<WorkjetEnvironmentTargetOption>,
  primaryEnvironmentId: EnvironmentId | null,
): WorkjetConfiguration {
  const computers = [...configuration.computers];
  const catalog = { ...configuration, computers };
  let added = false;
  const primaryHostId = targets
    .find((target) => target.environmentId === primaryEnvironmentId)
    ?.hostId?.trim();
  for (const target of targets) {
    if (
      target.environmentId === primaryEnvironmentId ||
      (primaryHostId && target.hostId?.trim() === primaryHostId) ||
      findComputerForTarget(catalog, target, targets)
    )
      continue;
    computers.push(
      saveWorkjetComputerDraft(
        createWorkjetComputerDraft({
          environments: [target],
          id: `connection-${target.environmentId}`,
        }),
      ),
    );
    added = true;
  }
  return added ? catalog : configuration;
}

const OPERATIONAL_CAPABILITIES = [
  { kind: "build", label: "Build" },
  { kind: "storage", label: "Storage" },
  { kind: "gpu", label: "GPU" },
] as const;

function ComputerCapabilityChips({
  capabilities,
  capabilityConfig,
  label,
  onClick,
  disabled,
}: {
  readonly capabilities: readonly string[];
  readonly capabilityConfig?: readonly CtoxComputerOperationalCapability[] | undefined;
  readonly label: string;
  readonly onClick?: (() => void) | undefined;
  readonly disabled?: boolean;
}) {
  const declared = OPERATIONAL_CAPABILITIES.filter(({ kind }) => capabilities.includes(kind));
  const gpu = capabilityConfig?.find((entry) => entry.kind === "gpu");
  return (
    <button
      type="button"
      disabled={disabled || !onClick}
      onClick={onClick}
      aria-label={`Edit capabilities for ${label}`}
      title={
        declared.length
          ? declared.map(({ kind }) => kind).join(", ")
          : "No registered operational capabilities"
      }
      className="flex max-w-full items-center gap-1 overflow-hidden rounded text-left disabled:cursor-default enabled:hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring"
    >
      {declared.length === 0 ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        declared.map(({ kind }) => (
          <span
            key={kind}
            data-workjet-capability={kind}
            className="min-w-0 truncate rounded bg-muted px-1 py-0.5 text-[10px] font-medium"
          >
            {kind === "gpu" && gpu
              ? `gpu ${gpu.model.replace(/^(?:NVIDIA\s+)?(?:GeForce\s+)?RTX\s+/i, "")} ${gpu.vram_gib} GB`
              : kind}
          </span>
        ))
      )}
    </button>
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
  onAssign,
  onCapabilities,
  onUnassignNative,
  onNativeCapabilities,
  businessOsLabel,
  onAdd,
  onRemove,
  renderConnection,
  connectedEnvironmentIds,
  connectingEnvironmentIds,
  pendingConnectionEnvironmentId,
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
  readonly onCapabilities?: ((computer: WorkjetComputer) => void) | undefined;
  readonly onUnassignNative?: ((computerId: string) => void) | undefined;
  readonly onNativeCapabilities?: ((computer: CtoxWorkjetComputerProjection) => void) | undefined;
  readonly businessOsLabel?: string | null;
  readonly onAdd?: () => void;
  readonly onRemove?: (computer: WorkjetComputer) => void;
  readonly renderConnection?: (environmentId: EnvironmentId) => ReactNode;
  readonly connectedEnvironmentIds?: ReadonlyArray<EnvironmentId>;
  readonly connectingEnvironmentIds?: ReadonlyArray<EnvironmentId>;
  readonly pendingConnectionEnvironmentId?: EnvironmentId | null;
}) {
  const [editingComputerId, setEditingComputerId] = useState<string | null>(null);
  const [connectionComputerId, setConnectionComputerId] = useState<string | null>(null);
  const [removingComputer, setRemovingComputer] = useState<WorkjetComputer | null>(null);
  const [capabilityFilter, setCapabilityFilter] = useState<string>("all");
  const editingComputer =
    configuration.computers.find((entry) => entry.id === editingComputerId) ?? null;
  const connectionComputer =
    configuration.computers.find((entry) => entry.id === connectionComputerId) ?? null;
  const nativeComputers =
    membership?.phase === "ready"
      ? membership.computers.filter((entry) => entry.status === "assigned")
      : [];
  const nativeOnlyComputers = nativeComputers.filter(
    (entry) => !configuration.computers.some((configured) => configured.id === entry.id),
  );
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
  const configured = [...configuration.computers].sort((left, right) => {
    const rank = (computer: WorkjetComputer) =>
      computer.environmentId === environmentId
        ? 0
        : stateFor(computer).disconnected || stateFor(computer).connecting
          ? 2
          : 1;
    return rank(left) - rank(right) || left.label.localeCompare(right.label);
  });
  const matchesFilter = (capabilities: readonly string[]) =>
    capabilityFilter === "all" || capabilities.includes(capabilityFilter);
  const assignmentTitle =
    membership?.phase === "loading"
      ? "Checking Business OS assignment…"
      : membership?.phase === "failed"
        ? "Business OS assignment could not be checked"
        : "Not added to the selected Business OS";
  const assignmentBadge = (assigned: boolean) =>
    assigned ? (
      <span
        title="Available in the selected Business OS"
        className="inline-flex max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-[11px]"
      >
        in {businessOsLabel ?? "Business OS"}
      </span>
    ) : (
      <span className="text-muted-foreground" title={assignmentTitle}>
        —
      </span>
    );

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
      {configuration.computers.length + nativeOnlyComputers.length > 5 ? (
        <div
          className="flex items-center gap-1 pb-3"
          role="group"
          aria-label="Filter computers by capability"
        >
          {["all", ...OPERATIONAL_CAPABILITIES.map((entry) => entry.kind)].map((kind) => (
            <Button
              key={kind}
              size="xs"
              variant={capabilityFilter === kind ? "secondary" : "ghost"}
              aria-pressed={capabilityFilter === kind}
              onClick={() => setCapabilityFilter(kind)}
            >
              {kind === "all" ? "All computers" : kind}
            </Button>
          ))}
        </div>
      ) : null}
      <div className="overflow-x-auto">
        <table
          className="w-full table-fixed text-left text-xs"
          aria-label="Computers"
          data-workjet-computers-table
        >
          <colgroup>
            <col className="w-7" />
            <col className="w-[22%]" />
            <col className="w-[16%]" />
            <col className="w-[32%]" />
            <col />
            <col className="w-24" />
          </colgroup>
          <thead className="border-b border-border text-[11px] text-muted-foreground">
            <tr>
              <th className="py-2 font-normal">
                <span className="sr-only">Status</span>
              </th>
              {["Computer", "Capabilities", "Coding tools", "Business OS"].map((label) => (
                <th key={label} className="px-2 py-2 font-normal">
                  {label}
                </th>
              ))}
              <th className="px-1 py-2 text-right font-normal">Action</th>
            </tr>
          </thead>
          <tbody>
            {configured
              .filter((computer) =>
                matchesFilter(
                  nativeComputers.find((entry) => entry.id === computer.id)?.capabilities ?? [],
                ),
              )
              .map((computer) => {
                const { connecting, disconnected, inspection, snapshot } = stateFor(computer);
                const nativeComputer = nativeComputers.find((entry) => entry.id === computer.id);
                const target = environments.find(
                  (entry) => entry.environmentId === computer.environmentId,
                );
                const isCurrent = configuration.selectedComputerId === computer.id;
                const status = !environmentsReady
                  ? "Checking connection…"
                  : connecting
                    ? "Connecting"
                    : disconnected
                      ? "Offline"
                      : "Online";
                const probeTitle = disconnected
                  ? "Disconnected. Reconnect this computer to check its coding tools."
                  : connecting
                    ? "Connecting. Coding tools will be checked once connected."
                    : inspection?.error
                      ? "Could not check coding tools. Check this computer’s connection."
                      : "Checking coding tools…";
                const location =
                  computer.environmentId === environmentId
                    ? "This machine"
                    : (target?.detail ?? workjetComputerKindLabel(computer.presentationKind));
                return (
                  <tr
                    key={computer.id}
                    data-workjet-computer={computer.id}
                    className="h-14 border-b border-border/60 hover:bg-muted/30"
                  >
                    <td className="pl-1">
                      <span
                        role="img"
                        aria-label={status}
                        title={status}
                        className={
                          status === "Online"
                            ? "block size-1.5 rounded-full bg-emerald-500"
                            : "block size-1.5 rounded-full bg-muted-foreground/40"
                        }
                      />
                    </td>
                    <td className="min-w-0 px-2 py-1.5">
                      <div className="truncate font-medium text-foreground" title={computer.label}>
                        {computer.label}
                      </div>
                      <div
                        className="truncate text-[11px] text-muted-foreground"
                        title={target ? `${location} · ${target.label}` : location}
                      >
                        {location}
                      </div>
                    </td>
                    <td className="px-2">
                      <ComputerCapabilityChips
                        capabilities={nativeComputer?.capabilities ?? []}
                        capabilityConfig={nativeComputer?.capabilityConfig}
                        label={computer.label}
                        onClick={onCapabilities ? () => onCapabilities(computer) : undefined}
                        disabled={
                          membership?.phase !== "ready" || membership.pendingComputerId !== null
                        }
                      />
                    </td>
                    <td className="px-2">
                      {snapshot === null ? (
                        <span title={probeTitle} className="text-muted-foreground">
                          —
                        </span>
                      ) : (
                        <div className="flex flex-wrap items-center gap-1 py-1">
                          {computer.harnesses.map((declared) => {
                            const live = snapshot.harnesses.find(
                              (entry) => entry.harness === declared.harness,
                            );
                            const available = live?.availability === "available";
                            const detail =
                              live?.availability === "available"
                                ? `${live.version ? `v${live.version} · ` : ""}${live.executablePath}`
                                : live
                                  ? humanizeHarnessProbeReason(live.reason)
                                  : declared.available
                                    ? "declared available · not probed from here"
                                    : "not offered";
                            return (
                              <span
                                key={declared.harness}
                                title={detail}
                                className="inline-flex shrink-0 items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[10px]"
                              >
                                {workjetHarnessDisplayLabel(declared.harness).replace(
                                  /\s+(CLI|Code)$/,
                                  "",
                                )}
                                <span
                                  className={
                                    available
                                      ? "text-emerald-600 dark:text-emerald-400"
                                      : "text-muted-foreground"
                                  }
                                >
                                  {available ? "✓" : "—"}
                                </span>
                              </span>
                            );
                          })}
                          {computer.harnesses.length === 0 ? (
                            <span
                              title="No coding tools enabled. Edit this computer to choose them."
                              className="text-muted-foreground"
                            >
                              —
                            </span>
                          ) : null}
                        </div>
                      )}
                    </td>
                    <td className="px-2">{assignmentBadge(nativeComputer !== undefined)}</td>
                    <td className="px-1">
                      <div className="flex items-center justify-end gap-0.5">
                        <Button
                          type="button"
                          size="xs"
                          variant={isCurrent ? "secondary" : "ghost"}
                          role="radio"
                          aria-checked={isCurrent}
                          title={isCurrent ? "Current computer" : "Use as current computer"}
                          aria-label={
                            isCurrent
                              ? `Stop using ${computer.label} as current computer`
                              : `Use ${computer.label} as current computer`
                          }
                          onClick={() =>
                            onChange(toggleCurrentComputer(configuration, computer.id))
                          }
                        >
                          {isCurrent ? "Current" : "Use"}
                        </Button>
                        <Menu>
                          <MenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                aria-label={`More actions for ${computer.label}`}
                              />
                            }
                          >
                            <MoreHorizontalIcon className="size-3.5" />
                          </MenuTrigger>
                          <MenuPopup align="end">
                            <MenuItem onClick={() => setEditingComputerId(computer.id)}>
                              Edit
                            </MenuItem>
                            {renderConnection ? (
                              <MenuItem onClick={() => setConnectionComputerId(computer.id)}>
                                Connection
                              </MenuItem>
                            ) : null}
                            {onAssign && membership ? (
                              <MenuItem
                                disabled={
                                  membership.phase !== "ready" ||
                                  membership.pendingComputerId !== null ||
                                  (disconnected && !nativeComputer)
                                }
                                data-workjet-action={`computer-${computer.id}-${nativeComputer ? "unassign" : "assign"}`}
                                aria-label={`${nativeComputer ? "Remove" : "Add"} ${computer.label} ${nativeComputer ? "from" : "to"} selected Business OS`}
                                onClick={() => onAssign(computer, nativeComputer === undefined)}
                              >
                                {nativeComputer ? "Remove from Business OS" : "Add to Business OS"}
                              </MenuItem>
                            ) : null}
                            <MenuSeparator />
                            <MenuItem
                              variant="destructive"
                              onClick={() => setRemovingComputer(computer)}
                            >
                              Remove
                            </MenuItem>
                          </MenuPopup>
                        </Menu>
                      </div>
                    </td>
                  </tr>
                );
              })}
            {nativeOnlyComputers
              .filter((computer) => matchesFilter(computer.capabilities))
              .map((computer) => (
                <tr
                  key={computer.id}
                  data-workjet-native-computer={computer.id}
                  className="h-14 border-b border-border/60 hover:bg-muted/30"
                >
                  <td className="pl-1">
                    <span
                      role="img"
                      aria-label="Connection not observed"
                      title="Connection not observed from this app"
                      className="block size-1.5 rounded-full bg-muted-foreground/40"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="truncate font-medium" title={computer.displayName}>
                      {computer.displayName}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {computer.agentless ? "Storage endpoint" : "Business OS computer"}
                    </div>
                  </td>
                  <td className="px-2">
                    <ComputerCapabilityChips
                      capabilities={computer.capabilities}
                      capabilityConfig={computer.capabilityConfig}
                      label={computer.displayName}
                      onClick={
                        onNativeCapabilities ? () => onNativeCapabilities(computer) : undefined
                      }
                      disabled={
                        membership?.phase !== "ready" ||
                        membership.pendingComputerId !== null ||
                        computer.agentless === undefined ||
                        computer.selfHostedColocation
                      }
                    />
                  </td>
                  <td className="px-2 text-muted-foreground">
                    <span title="No coding connection to this computer">—</span>
                  </td>
                  <td className="px-2">{assignmentBadge(true)}</td>
                  <td className="px-1 text-right">
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={`More actions for ${computer.displayName}`}
                          />
                        }
                      >
                        <MoreHorizontalIcon className="size-3.5" />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        {onNativeCapabilities ? (
                          <MenuItem
                            disabled={
                              computer.agentless === undefined || computer.selfHostedColocation
                            }
                            onClick={() => onNativeCapabilities(computer)}
                          >
                            Edit
                          </MenuItem>
                        ) : null}
                        <MenuItem
                          variant="destructive"
                          disabled={
                            !onUnassignNative ||
                            membership?.phase !== "ready" ||
                            membership.pendingComputerId !== null
                          }
                          aria-label={`Remove ${computer.displayName} from selected Business OS`}
                          onClick={() => onUnassignNative?.(computer.id)}
                        >
                          Remove from Business OS
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {configuration.computers.length + nativeOnlyComputers.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground">
          {environmentsReady
            ? "No computers yet. Add this computer, an SSH host, or a computer on your Tailscale network."
            : "Loading computers…"}
        </p>
      ) : null}
      {capabilityFilter !== "all" &&
      !configured.some((computer) =>
        matchesFilter(
          nativeComputers.find((entry) => entry.id === computer.id)?.capabilities ?? [],
        ),
      ) &&
      !nativeOnlyComputers.some((computer) => matchesFilter(computer.capabilities)) ? (
        <p className="py-4 text-sm text-muted-foreground">No computers with this capability.</p>
      ) : null}
      <Sheet
        open={editingComputer !== null}
        onOpenChange={(open) => {
          if (!open) setEditingComputerId(null);
        }}
      >
        <SheetPopup className="motion-reduce:transition-none">
          <SheetHeader>
            <SheetTitle>Edit computer</SheetTitle>
            <SheetDescription>Name and coding tools for this connection.</SheetDescription>
          </SheetHeader>
          <SheetPanel>
            {editingComputer ? (
              <WorkjetComputerEditor
                key={editingComputer.id}
                computer={editingComputer}
                environments={environments}
                availability={stateFor(editingComputer).snapshot}
                onCancel={() => setEditingComputerId(null)}
                onSave={(computer) => {
                  const computers = configuration.computers.map((entry) =>
                    entry.id === computer.id ? computer : entry,
                  );
                  onChange(
                    applyAutomaticCurrentComputer({ ...configuration, computers }, environmentId),
                  );
                  setEditingComputerId(null);
                  toastManager.add({
                    type: "success",
                    title: "Computer saved",
                    description: computer.label,
                  });
                }}
              />
            ) : null}
          </SheetPanel>
        </SheetPopup>
      </Sheet>
      <Dialog
        open={connectionComputer !== null}
        onOpenChange={(open) => {
          if (!open) setConnectionComputerId(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{connectionComputer?.label} connection</DialogTitle>
            <DialogDescription>Reconnect or disconnect this computer.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {connectionComputer ? renderConnection?.(connectionComputer.environmentId) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={removingComputer !== null}
        onOpenChange={(open) => {
          if (!open) setRemovingComputer(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Remove {removingComputer?.label}?</DialogTitle>
            <DialogDescription>
              Remove this saved connection. Unassign it from the Business OS first if it is still
              assigned.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRemovingComputer(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (removingComputer) {
                  if (onRemove) onRemove(removingComputer);
                  else onChange(removeComputer(configuration, removingComputer.id));
                  setRemovingComputer(null);
                }
              }}
            >
              Remove
            </Button>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
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
  const { discovery } = useCtoxMode();
  const businessOsLabel = resolveSettingsInstanceContext(
    discovery,
    selectedInstanceId,
  ).activeInstanceName;
  const [nativeCapabilityComputer, setNativeCapabilityComputer] =
    useState<CtoxWorkjetComputerProjection | null>(null);
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
  const [addMode, setAddMode] = useState<"choose" | "capabilities" | null>(null);
  const [capabilityComputer, setCapabilityComputer] = useState<WorkjetComputer | null>(null);
  useEffect(() => {
    setAddMode(null);
    setCapabilityComputer(null);
    setSetupComputer(null);
  }, [selectedInstanceId]);
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
    const existing = findComputerForTarget(settings.workjet, pendingTarget, targetOptions);
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
    if (!setupOnly) {
      setCapabilityComputer(computer);
      setAddMode("capabilities");
    }
    setPendingComputerId(null);
  }, [
    pendingTarget,
    pendingKind,
    pendingInspection.data,
    settings.workjet,
    setupOnly,
    targetOptions,
    updateSettings,
  ]);
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

  const enrollRemoteComputer = useAtomCommand(serverEnvironment.enrollWorkjetRemoteComputer, {
    reportFailure: false,
  });
  const saveCapabilities = async (enrollment: OperationalComputerEnrollment) => {
    if (!selectedInstanceId) throw new Error("Select a Business OS before adding this computer.");
    const computer = setupOnly ? setupComputer : capabilityComputer;
    const build = enrollment.capabilityConfig.find((capability) => capability.kind === "build");
    let assigned = enrollment;
    if (build && computer?.environmentId !== environmentId) {
      if (!computer || !environmentId)
        throw new Error("Connect this build computer over SSH before saving its capabilities.");
      const result = await enrollRemoteComputer({
        environmentId,
        targetEnvironmentId: computer.environmentId,
        input: {
          selectedInstanceId,
          computerId: computer.id,
          displayName: enrollment.displayName,
          hostingMode: enrollment.hostingMode,
          buildCapability: build,
        },
      });
      if (result._tag !== "Success")
        throw new Error(
          "Build computer enrollment failed. Check its SSH connection and the selected Business OS grant, then retry.",
        );
      assigned = { ...enrollment, computerId: result.value.computerId };
    }
    await membershipStore.enroll(selectedInstanceId, assigned, window.desktopBridge?.ctox);
    setAddMode(null);
    setCapabilityComputer(null);
    if (setupOnly) onCompleted?.();
  };
  const enrollmentAvailable =
    !!selectedInstanceId &&
    activeMembership?.phase === "ready" &&
    activeMembership.pendingComputerId === null;
  const addChoices = (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Connect a computer for coding, or register a build, GPU, or storage computer such as a NAS.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            setAddMode(null);
            connections.openAddComputer();
          }}
        >
          Coding computer
        </Button>
        <Button
          variant="outline"
          disabled={!enrollmentAvailable}
          onClick={() => {
            setCapabilityComputer(null);
            setAddMode("capabilities");
          }}
        >
          Build, GPU, or storage computer
        </Button>
      </div>
      {!enrollmentAvailable ? (
        <p role="status" className="text-sm text-muted-foreground">
          Select a connected Business OS and wait for its computer list to register capabilities.
        </p>
      ) : null}
    </div>
  );

  if (setupOnly)
    return (
      <div className="space-y-4">
        {setupComputer === null && pendingComputerId === null ? (
          addMode === "capabilities" ? (
            <ComputerCapabilitiesEditor
              onSave={saveCapabilities}
              onCancel={() => setAddMode(null)}
            />
          ) : (
            <>
              {addChoices}
              {connections.form}
            </>
          )
        ) : null}
        {pendingComputerId !== null ? <p role="status">Connected. Checking coding tools…</p> : null}
        {pendingInspection.error ? (
          <div role="alert">
            <p>The coding tools could not be checked.</p>
            <Button variant="outline" onClick={() => setPendingComputerId(null)}>
              Reconnect
            </Button>
          </div>
        ) : null}
        {setupComputer !== null ? (
          <>
            <p className="font-medium">{setupComputer.label}</p>
            <p className="text-sm text-muted-foreground">
              This computer is connected to the app. Add it to the selected Business OS.
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
              <p role="status">Checking Business OS assignment…</p>
            ) : null}
            {activeMembership?.error ? (
              <p role="alert" className="text-sm text-destructive">
                {activeMembership.error}
              </p>
            ) : null}
            <ComputerCapabilitiesEditor
              key={setupComputer.id}
              computer={setupComputer}
              preserveExistingCapabilities={
                activeMembership?.computers.some(
                  (entry) =>
                    entry.id === setupComputer.id &&
                    entry.capabilities.some((kind) =>
                      OPERATIONAL_CAPABILITIES.some((capability) => capability.kind === kind),
                    ),
                ) ?? false
              }
              onSave={saveCapabilities}
              onCancel={() => setSetupComputer(null)}
            />
            {activeMembership?.phase === "failed" ? (
              <Button
                variant="outline"
                onClick={() => {
                  if (selectedInstanceId)
                    void membershipStore.refresh(selectedInstanceId, window.desktopBridge?.ctox);
                }}
              >
                Recheck assignment
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    );

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
            onInspection={recordHarnessInspection}
          />
        ))}
      {connections.dialog}
      <Dialog
        open={addMode === "choose"}
        onOpenChange={(open) => {
          if (!open && !setupBusy) setAddMode(null);
        }}
      >
        <DialogPopup showCloseButton={!setupBusy}>
          <DialogHeader>
            <DialogTitle>Add computer</DialogTitle>
            <DialogDescription>
              Add a coding connection or a build, GPU, or storage computer.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>{addChoices}</DialogPanel>
        </DialogPopup>
      </Dialog>
      <Sheet
        open={addMode === "capabilities"}
        onOpenChange={(open) => {
          if (!open && !setupBusy) setAddMode(null);
        }}
      >
        <SheetPopup showCloseButton={!setupBusy} className="motion-reduce:transition-none">
          <SheetHeader>
            <SheetTitle>Computer capabilities</SheetTitle>
            <SheetDescription>
              Save capabilities after the selected Business OS confirms access.
            </SheetDescription>
          </SheetHeader>
          <SheetPanel>
            <ComputerCapabilitiesEditor
              key={nativeCapabilityComputer?.id ?? capabilityComputer?.id ?? "operational-new"}
              {...(capabilityComputer ? { computer: capabilityComputer } : {})}
              {...(nativeCapabilityComputer ? { nativeComputer: nativeCapabilityComputer } : {})}
              preserveExistingCapabilities={
                !nativeCapabilityComputer?.agentless &&
                (activeMembership?.computers.some(
                  (entry) =>
                    entry.id === (nativeCapabilityComputer?.id ?? capabilityComputer?.id) &&
                    entry.capabilities.some((kind) =>
                      OPERATIONAL_CAPABILITIES.some((capability) => capability.kind === kind),
                    ),
                ) ??
                  false)
              }
              onSave={saveCapabilities}
              onCancel={() => setAddMode(null)}
            />
          </SheetPanel>
        </SheetPopup>
      </Sheet>
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
        businessOsLabel={businessOsLabel}
        onNativeCapabilities={
          selectedInstanceId
            ? (computer) => {
                setCapabilityComputer(null);
                setNativeCapabilityComputer(computer);
                setAddMode("capabilities");
              }
            : undefined
        }
        onAdd={() => {
          setCapabilityComputer(null);
          setNativeCapabilityComputer(null);
          setAddMode("choose");
        }}
        onCapabilities={
          selectedInstanceId
            ? (computer) => {
                setNativeCapabilityComputer(
                  activeMembership?.computers.find((entry) => entry.id === computer.id) ?? null,
                );
                setCapabilityComputer(computer);
                setAddMode("capabilities");
              }
            : undefined
        }
        onUnassignNative={
          selectedInstanceId
            ? (computerId) => {
                void membershipStore.unassign(
                  selectedInstanceId,
                  computerId,
                  window.desktopBridge?.ctox,
                );
              }
            : undefined
        }
        renderConnection={connections.renderConnection}
        connectedEnvironmentIds={environments
          .filter((entry) => entry.connection.phase === "connected")
          .map((entry) => entry.environmentId)}
        connectingEnvironmentIds={environments
          .filter(
            (entry) =>
              entry.connection.phase === "connecting" || entry.connection.phase === "reconnecting",
          )
          .map((entry) => entry.environmentId)}
        pendingConnectionEnvironmentId={pendingComputerId}
        onRemove={(computer) => {
          void (async () => {
            const result = await removeComputerConnection({
              configuration,
              computer,
              selectedInstanceId,
              membership: activeMembership ?? null,
              savedEnvironmentIds: connections.savedEnvironments.map(
                (entry) => entry.environmentId,
              ),
              removeConnection: (environmentId) => connections.removeConnection(environmentId),
            });
            if (result.status === "assigned") {
              toastManager.add({
                type: "error",
                title: "Computer still assigned",
                description:
                  "Remove this computer from the selected Business OS before removing its connection.",
              });
              return;
            }
            if (result.status === "removed") updateSettings({ workjet: result.configuration });
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
