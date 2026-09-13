import type {
  WorkjetCapabilityBinding,
  WorkjetCapabilityId,
  WorkjetConnectionSummary,
  WorkjetThreadRole,
  WorkjetThreadConfig,
} from "@workjet/contracts";
import { normalizeWorkjetThreadConfig } from "@workjet/contracts";
import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@workjet/client-runtime/state/runtime";
import { resolveCapabilityCatalogForHost } from "@metric-space-ai/workjet-capabilities";
import { ChevronRightIcon, WrenchIcon } from "lucide-react";
import { useRef, useState } from "react";

import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { ExpandableSettingsPopup } from "../ui/expandable-settings-popup";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  type WorkjetSelectableRole,
  WORKJET_ROLE_NEXT_SESSION_HINT,
  WORKJET_WORKER_ROLE_REASON,
} from "./WorkjetRoleControl";

const GREPPY_CAPABILITY_ID = "greppy" satisfies WorkjetCapabilityId;

/**
 * The composer's Tools menu renders THE CATALOG, not a second description of
 * it. Every label, description, and membership decision below is resolved from
 * `@metric-space-ai/workjet-capabilities` through the same function Business OS
 * uses for its instance-policy view, so a capability renamed in the manifest is
 * renamed here without touching this file.
 *
 * Only the activation copy is UI-owned, because per-thread activation is a
 * Code-host policy rather than a property of the capability.
 */
export const WORKJET_CODE_HOST_ADAPTER = "workjet-mcp" as const;

export const workjetComposerCapabilities = (
  enabledCapabilityIds: ReadonlyArray<string>,
): ReturnType<typeof resolveCapabilityCatalogForHost> =>
  resolveCapabilityCatalogForHost({
    adapter: WORKJET_CODE_HOST_ADAPTER,
    enabledCapabilityIds,
  });

const greppyCapability = workjetComposerCapabilities([]).find(
  ({ manifest }) => manifest.id === GREPPY_CAPABILITY_ID,
)?.manifest;

if (!greppyCapability) {
  throw new Error(`The catalog exposes no ${WORKJET_CODE_HOST_ADAPTER} adapter for Greppy.`);
}

export const WORKJET_GREPPY_DISPLAY_NAME = greppyCapability.metadata.displayName;
export const WORKJET_GREPPY_DESCRIPTION = greppyCapability.metadata.description;

/**
 * Code-host activation policy. Not capability metadata: it says where an
 * activation applies, which the catalog deliberately does not describe.
 */
export const WORKJET_GREPPY_ACTIVATION_NOTE = `${WORKJET_GREPPY_DISPLAY_NAME} is activated only for this thread. Its runtime and store are shared by all threads on this server.`;

export const WORKJET_GREPPY_FAILURE_TOAST = {
  type: "error",
  title: `Could not update ${WORKJET_GREPPY_DISPLAY_NAME}`,
  description: `${WORKJET_GREPPY_DISPLAY_NAME} was left unchanged for this thread.`,
  data: { hideCopyButton: true },
} as const;

export function setWorkjetCapabilityEnabled(
  config: WorkjetThreadConfig,
  capabilityId: WorkjetCapabilityId,
  enabled: boolean,
): WorkjetThreadConfig {
  let found = false;
  const enabledCapabilityIds = config.enabledCapabilityIds.flatMap((existingCapabilityId) => {
    if (existingCapabilityId !== capabilityId) {
      return [existingCapabilityId];
    }
    if (!enabled || found) {
      return [];
    }
    found = true;
    return [existingCapabilityId];
  });

  if (enabled && !found) {
    enabledCapabilityIds.push(capabilityId);
  }

  if (
    enabledCapabilityIds.length === config.enabledCapabilityIds.length &&
    enabledCapabilityIds.every(
      (existingCapabilityId, index) => existingCapabilityId === config.enabledCapabilityIds[index],
    )
  ) {
    return config;
  }

  return {
    ...config,
    enabledCapabilityIds,
  };
}

/**
 * Set the thread's capability list — and/or its managed instructions — to
 * EXACTLY the given values, one dispatch.
 *
 * Built for applying a worker's bundle when a draft becomes a thread: a
 * worker DEFINES its extras and its task text, so applying means
 * set-these-drop-others, not enable-on-top. It must be one config change
 * because the caller's in-flight guard silently drops concurrent changes —
 * per-field dispatches would land only the first field and lose the rest
 * without a trace. The composer's custom-system-prompt affordance reuses the
 * same runner with only `managedInstructions` set, so the whole next config
 * always travels through one path.
 */
export async function executeWorkjetCapabilitySet<E>(input: {
  readonly currentConfig: WorkjetThreadConfig;
  /** Omitted leaves the thread's capability list untouched. */
  readonly capabilityIds?: ReadonlyArray<WorkjetCapabilityId> | undefined;
  /** Omitted leaves the thread's managed instructions untouched. */
  readonly managedInstructions?: string | undefined;
  readonly capabilityBindings?: ReadonlyArray<WorkjetCapabilityBinding> | undefined;
  readonly dispatch: (nextConfig: WorkjetThreadConfig) => Promise<AtomCommandResult<unknown, E>>;
  readonly setVisibleConfig: (config: WorkjetThreadConfig) => void;
  readonly notifyFailure: () => void;
}): Promise<WorkjetThreadConfig> {
  let nextConfig: WorkjetThreadConfig = input.currentConfig;
  if (input.capabilityIds !== undefined) {
    const wanted = [...new Set(input.capabilityIds)];
    const current = [...nextConfig.enabledCapabilityIds].sort().join(",");
    if (wanted.slice().sort().join(",") !== current) {
      nextConfig = { ...nextConfig, enabledCapabilityIds: wanted };
    }
  }
  if (
    input.managedInstructions !== undefined &&
    input.managedInstructions !== nextConfig.managedInstructions
  ) {
    nextConfig = { ...nextConfig, managedInstructions: input.managedInstructions };
  }
  if (input.capabilityBindings !== undefined) {
    nextConfig = normalizeWorkjetThreadConfig(nextConfig);
    const wanted = input.capabilityBindings;
    if (JSON.stringify(wanted) !== JSON.stringify(nextConfig.capabilityBindings)) {
      nextConfig = {
        ...nextConfig,
        schemaVersion: 2,
        capabilityBindings: [...wanted],
      };
    }
  }
  if (nextConfig === input.currentConfig) {
    return input.currentConfig;
  }
  input.setVisibleConfig(nextConfig);
  const result = await input.dispatch(nextConfig);
  if (result._tag === "Failure") {
    input.setVisibleConfig(input.currentConfig);
    if (!isAtomCommandInterrupted(result)) {
      input.notifyFailure();
    }
    return input.currentConfig;
  }
  return nextConfig;
}

export async function executeWorkjetCapabilityToggle<E>(input: {
  readonly currentConfig: WorkjetThreadConfig;
  readonly capabilityId: WorkjetCapabilityId;
  readonly enabled: boolean;
  readonly dispatch: (nextConfig: WorkjetThreadConfig) => Promise<AtomCommandResult<unknown, E>>;
  readonly setVisibleConfig: (config: WorkjetThreadConfig) => void;
  readonly notifyFailure: () => void;
}): Promise<WorkjetThreadConfig> {
  const nextConfig = setWorkjetCapabilityEnabled(
    input.currentConfig,
    input.capabilityId,
    input.enabled,
  );
  if (nextConfig === input.currentConfig) {
    return nextConfig;
  }

  input.setVisibleConfig(nextConfig);
  const result = await input.dispatch(nextConfig);
  if (result._tag === "Failure") {
    input.setVisibleConfig(input.currentConfig);
    if (!isAtomCommandInterrupted(result)) {
      input.notifyFailure();
    }
    return input.currentConfig;
  }

  return nextConfig;
}

/**
 * Every capability the composer's host can actually activate.
 *
 * Resolved from the catalog, not listed here: `web-search` and
 * `web-stack-browser` declare `supportedAdapters: ALL_ADAPTERS`, which
 * includes this host, so they were available all along and the menu simply
 * never offered them. A hard-coded Greppy row hid two capabilities the thread
 * config could already store — `enabledCapabilityIds` has always been a list.
 */
export const workjetComposerCapabilityList = (): ReadonlyArray<{
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
}> =>
  workjetComposerCapabilities([]).map(({ manifest }) => ({
    id: manifest.id,
    displayName: manifest.metadata.displayName,
    description: manifest.metadata.description,
  }));

export interface WorkjetCapabilityMenuProps {
  readonly compact?: boolean;
  /** Ids currently active on this thread. */
  readonly enabledCapabilityIds?: ReadonlyArray<string> | undefined;
  readonly greppyEnabled: boolean;
  readonly busy: boolean;
  readonly disabled?: boolean;
  readonly onGreppyEnabledChange: (enabled: boolean) => void;
  /** Present when the caller can toggle any capability, not just Greppy. */
  readonly onCapabilityEnabledChange?:
    | ((capabilityId: string, enabled: boolean) => void)
    | undefined;
  readonly decisionHubConnections?: ReadonlyArray<WorkjetConnectionSummary> | undefined;
  readonly decisionHubConnectionId?: string | null | undefined;
  readonly onDecisionHubConnectionChange?: ((connectionId: string) => void) | undefined;
  readonly ctoxBusinessOsConnections?: ReadonlyArray<WorkjetConnectionSummary> | undefined;
  readonly ctoxBusinessOsConnectionId?: string | null | undefined;
  readonly ctoxBusinessOsConnectionLocked?: boolean | undefined;
  readonly onCtoxBusinessOsConnectionChange?: ((connectionId: string) => void) | undefined;
  /** Thread role belongs in this settings menu, never in the main composer bar. */
  readonly workjetRole?: WorkjetThreadRole | null | undefined;
  readonly onWorkjetRoleChange?: ((role: WorkjetSelectableRole) => void) | undefined;
}

export function WorkjetCapabilityMenuContent(
  props: WorkjetCapabilityMenuProps & {
    readonly selectedSettingId?: string | null;
    readonly onOpenSetting?: (id: string, trigger: HTMLButtonElement) => void;
  },
) {
  const disabled = props.disabled === true || props.busy;
  const capabilities = props.onCapabilityEnabledChange
    ? workjetComposerCapabilityList()
    : [
        {
          id: GREPPY_CAPABILITY_ID,
          displayName: WORKJET_GREPPY_DISPLAY_NAME,
          description: WORKJET_GREPPY_DESCRIPTION,
        },
      ];
  const enabled = new Set(props.enabledCapabilityIds ?? []);
  const showRole = props.workjetRole != null && props.onWorkjetRoleChange !== undefined;

  const row = (setting: {
    id: string;
    label: string;
    checked: boolean;
    locked?: boolean;
    summary?: string | undefined;
    onChange: (checked: boolean) => void;
  }) => (
    <div
      key={setting.id}
      data-workjet-setting={setting.id}
      data-workjet-role-setting={setting.id === "orchestrator" ? "true" : undefined}
      className="flex min-w-0 items-center gap-2 rounded-lg px-2 py-2 hover:bg-accent/40"
    >
      <Switch
        checked={setting.checked}
        disabled={disabled || setting.locked}
        aria-label={`${setting.label} for this thread`}
        aria-busy={props.busy || undefined}
        onCheckedChange={setting.onChange}
      />
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={`${setting.label} settings`}
        aria-expanded={props.selectedSettingId === setting.id}
        disabled={props.onOpenSetting === undefined}
        onClick={(event) => props.onOpenSetting?.(setting.id, event.currentTarget)}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{setting.label}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {setting.summary ?? (setting.checked ? "On" : "Off")}
          </span>
        </span>
        <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </button>
    </div>
  );

  return (
    <div aria-label="Thread settings" aria-busy={props.busy || undefined}>
      <p className="px-2 pb-2 text-xs text-muted-foreground">
        Tools for this chat. Open a row for details.
      </p>
      {showRole
        ? row({
            id: "orchestrator",
            label: "Orchestrator",
            checked: props.workjetRole === "orchestrator",
            locked: props.workjetRole === "worker",
            summary: props.workjetRole === "worker" ? "Managed by parent" : undefined,
            onChange: (checked) =>
              props.onWorkjetRoleChange?.(checked ? "orchestrator" : "standard"),
          })
        : null}
      {capabilities.map((capability) =>
        row({
          id: capability.id,
          label: capability.displayName,
          checked: props.onCapabilityEnabledChange
            ? enabled.has(capability.id)
            : props.greppyEnabled,
          onChange: (checked) =>
            props.onCapabilityEnabledChange
              ? props.onCapabilityEnabledChange(capability.id, checked)
              : props.onGreppyEnabledChange(checked),
        }),
      )}
      {props.busy ? (
        <p role="status" className="px-2 pt-2 text-xs text-muted-foreground">
          Updating…
        </p>
      ) : null}
    </div>
  );
}

export function WorkjetCapabilityDetail(
  props: WorkjetCapabilityMenuProps & { readonly settingId: string },
) {
  if (props.settingId === "orchestrator") {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3 @min-[36rem]/settings:hidden">
          <span className="text-sm">Orchestrator</span>
          <Switch
            checked={props.workjetRole === "orchestrator"}
            disabled={
              props.disabled === true ||
              props.busy ||
              props.workjetRole === "worker" ||
              !props.onWorkjetRoleChange
            }
            aria-label="Orchestrator for this thread"
            onCheckedChange={(checked) =>
              props.onWorkjetRoleChange?.(checked ? "orchestrator" : "standard")
            }
          />
        </div>
        <p className="text-sm leading-6 text-muted-foreground">
          {props.workjetRole === "worker"
            ? WORKJET_WORKER_ROLE_REASON
            : `Allow this chat to delegate to workers. ${WORKJET_ROLE_NEXT_SESSION_HINT}`}
        </p>
      </div>
    );
  }
  const capability = workjetComposerCapabilityList().find(({ id }) => id === props.settingId);
  if (!capability) return null;
  const enabled = props.onCapabilityEnabledChange
    ? (props.enabledCapabilityIds ?? []).includes(props.settingId)
    : props.settingId === GREPPY_CAPABILITY_ID && props.greppyEnabled;
  const connections = props.decisionHubConnections ?? [];
  const selectedConnection = connections.find(
    ({ connectionId }) => connectionId === props.decisionHubConnectionId,
  );
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 @min-[36rem]/settings:hidden">
        <span className="text-sm">Enabled for this chat</span>
        <Switch
          checked={enabled}
          disabled={
            props.disabled === true ||
            props.busy ||
            (!props.onCapabilityEnabledChange && props.settingId !== GREPPY_CAPABILITY_ID)
          }
          aria-label={`${capability.displayName} for this thread`}
          onCheckedChange={(checked) =>
            props.onCapabilityEnabledChange
              ? props.onCapabilityEnabledChange(props.settingId, checked)
              : props.onGreppyEnabledChange(checked)
          }
        />
      </div>
      <p className="text-sm leading-6 text-muted-foreground">{capability.description}</p>
      {props.settingId === GREPPY_CAPABILITY_ID ? (
        <p className="text-xs leading-5 text-muted-foreground">{WORKJET_GREPPY_ACTIVATION_NOTE}</p>
      ) : null}
      {props.settingId === "decision-hub" ? (
        !enabled ? (
          <p className="text-sm text-muted-foreground">
            Enable Decision Hub to choose a CTOX instance.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm font-medium">CTOX instance</p>
            <Select
              value={props.decisionHubConnectionId ?? ""}
              disabled={
                props.disabled === true ||
                props.busy ||
                props.onDecisionHubConnectionChange === undefined ||
                connections.length === 0
              }
              onValueChange={(value) => {
                if (value !== null) props.onDecisionHubConnectionChange?.(value);
              }}
            >
              <SelectTrigger aria-label="Decision Hub CTOX connection">
                <SelectValue placeholder="Choose CTOX instance" />
              </SelectTrigger>
              <SelectPopup>
                {connections.map((connection) => (
                  <SelectItem key={connection.connectionId} value={connection.connectionId}>
                    {connection.displayName} · {connection.status}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {connections.length === 0 ? (
              <p role="status" className="text-xs text-amber-500">
                No MCP-capable CTOX connection is available on this computer.
              </p>
            ) : props.decisionHubConnectionId && !selectedConnection ? (
              <p role="status" className="text-xs text-amber-500">
                The selected CTOX connection is no longer available. Choose another instance.
              </p>
            ) : selectedConnection ? (
              <p role="status" className="text-xs text-muted-foreground">
                {selectedConnection.displayName} · {selectedConnection.status}
                {selectedConnection.reason ? `: ${selectedConnection.reason}` : ""}
              </p>
            ) : null}
            {capability.id === "ctox-business-os" && enabled ? (
              <div className="px-2 pb-2">
                <Select
                  value={props.ctoxBusinessOsConnectionId ?? ""}
                  disabled={
                    props.disabled === true || props.busy || props.ctoxBusinessOsConnectionLocked
                  }
                  onValueChange={(value) => {
                    if (value !== null) props.onCtoxBusinessOsConnectionChange?.(value);
                  }}
                >
                  <SelectTrigger aria-label="CTOX Business OS connection">
                    <SelectValue placeholder="Connect selected instance" />
                  </SelectTrigger>
                  <SelectPopup>
                    {(props.ctoxBusinessOsConnections ?? []).map((connection) => (
                      <SelectItem
                        key={connection.connectionId}
                        value={connection.connectionId}
                        disabled={connection.status !== "ready"}
                      >
                        {connection.displayName} · {connection.status}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
                {props.ctoxBusinessOsConnectionLocked ? (
                  <p className="pt-1 text-xs text-muted-foreground">
                    This thread keeps its original instance.
                  </p>
                ) : null}
                {(props.ctoxBusinessOsConnections ?? []).length === 0 ? (
                  <p role="alert" className="pt-1 text-xs text-amber-500">
                    No MCP connection for the selected instance is available on this computer.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      ) : null}
    </div>
  );
}

export function WorkjetCapabilityMenu(props: WorkjetCapabilityMenuProps) {
  const [open, setOpen] = useState(false);
  const [selectedSettingId, setSelectedSettingId] = useState<string | null>(null);
  const lastDetailTrigger = useRef<HTMLButtonElement | null>(null);
  const detailTitle =
    selectedSettingId === "orchestrator"
      ? "Orchestrator"
      : workjetComposerCapabilityList().find(({ id }) => id === selectedSettingId)?.displayName;
  return (
    <ExpandableSettingsPopup
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSelectedSettingId(null);
      }}
      title="Tools for this chat"
      backLabel="Back to tools"
      detailDescription="Changes apply to this chat. Worker profile defaults are edited in the Worker menu."
      trigger={
        <ComposerControl
          type="button"
          className="shrink-0 whitespace-nowrap"
          aria-label="Thread tools"
          disabled={props.disabled || props.busy}
          aria-busy={props.busy || undefined}
        >
          <ComposerControlIcon icon={WrenchIcon} />
          <span>Tools</span>
        </ComposerControl>
      }
      list={
        <WorkjetCapabilityMenuContent
          {...props}
          selectedSettingId={selectedSettingId}
          onOpenSetting={(id, trigger) => {
            lastDetailTrigger.current = trigger;
            setSelectedSettingId(id);
          }}
        />
      }
      detailTitle={detailTitle ?? "Tool settings"}
      detail={
        selectedSettingId && detailTitle ? (
          <WorkjetCapabilityDetail {...props} settingId={selectedSettingId} />
        ) : null
      }
      onBack={() => {
        setSelectedSettingId(null);
        requestAnimationFrame(() => lastDetailTrigger.current?.focus());
      }}
    />
  );
}

export { GREPPY_CAPABILITY_ID };
