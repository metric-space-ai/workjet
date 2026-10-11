import type { ReactNode } from "react";
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
import { PlugIcon, WrenchIcon } from "lucide-react";

import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from "./ComposerControl";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import type { WorkjetSelectableRole } from "./WorkjetRoleControl";

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
export const WORKJET_GREPPY_ACTIVATION_NOTE = `${WORKJET_GREPPY_DISPLAY_NAME}: nur dieser Chat`;

/** Toast mit einer Zeile (UI-Vertrag §1). */
export const WORKJET_GREPPY_FAILURE_TOAST = {
  type: "error",
  title: `${WORKJET_GREPPY_DISPLAY_NAME} nicht geändert`,
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
  readonly onCtoxBusinessOsConnect?: (() => void) | undefined;
  readonly ctoxBusinessOsConnecting?: boolean | undefined;
  readonly ctoxBusinessOsConnectError?: string | null | undefined;
  readonly onCtoxBusinessOsConnectionChange?: ((connectionId: string) => void) | undefined;
  /** Thread role belongs in this settings menu, never in the main composer bar. */
  readonly workjetRole?: WorkjetThreadRole | null | undefined;
  readonly onWorkjetRoleChange?: ((role: WorkjetSelectableRole) => void) | undefined;
}

/** Kurzer Status rechts im Menüeintrag. */
function ItemMeta({ children }: { readonly children: ReactNode }) {
  return (
    <span className="ms-auto shrink-0 truncate ps-3 text-muted-foreground text-xs">{children}</span>
  );
}

function StatusLine({
  children,
  tone = "neutral",
}: {
  readonly children: ReactNode;
  readonly tone?: "neutral" | "warning";
}) {
  return (
    <p
      role={tone === "warning" ? "alert" : "status"}
      className={
        tone === "warning"
          ? "max-w-72 px-2 py-1.5 text-warning text-xs"
          : "max-w-72 px-2 py-1.5 text-muted-foreground text-xs"
      }
    >
      {children}
    </p>
  );
}

function connectionStatusLabel(status: string): string {
  switch (status) {
    case "ready":
      return "bereit";
    case "connecting":
      return "verbindet";
    case "unavailable":
      return "nicht verfügbar";
    default:
      return status;
  }
}

/**
 * Die Einträge des Werkzeug-Dropdowns: ein Schalter je Werkzeug (Name, kein
 * Erklärsatz; die Katalogbeschreibung steht im Tooltip), bei aktivem Decision
 * Hub bzw. CTOX Business OS die Instanz als Auswahl. Hook-frei, damit Tests
 * den Baum direkt prüfen können.
 */
export function WorkjetCapabilityMenuItems(props: WorkjetCapabilityMenuProps) {
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
  const isEnabled = (id: string) =>
    props.onCapabilityEnabledChange
      ? enabled.has(id)
      : id === GREPPY_CAPABILITY_ID && props.greppyEnabled;
  const showRole = props.workjetRole != null && props.onWorkjetRoleChange !== undefined;
  const decisionHubConnections = props.decisionHubConnections ?? [];
  const ctoxConnections = props.ctoxBusinessOsConnections ?? [];

  return (
    <div aria-busy={props.busy || undefined} data-workjet-tools-menu="true">
      {showRole ? (
        <MenuCheckboxItem
          variant="switch"
          data-workjet-setting="orchestrator"
          data-workjet-role-setting="true"
          aria-label="Orchestrator für diesen Chat"
          aria-busy={props.busy || undefined}
          checked={props.workjetRole === "orchestrator"}
          disabled={disabled || props.workjetRole === "worker"}
          onCheckedChange={(checked) =>
            props.onWorkjetRoleChange?.(checked ? "orchestrator" : "standard")
          }
        >
          <span className="flex min-w-0 items-baseline">
            <span className="min-w-0 truncate">Orchestrator</span>
            {props.workjetRole === "worker" ? <ItemMeta>vom Eltern-Chat</ItemMeta> : null}
          </span>
        </MenuCheckboxItem>
      ) : null}
      {capabilities.map((capability) => (
        <MenuCheckboxItem
          key={capability.id}
          variant="switch"
          data-workjet-setting={capability.id}
          aria-label={`${capability.displayName} für diesen Chat`}
          aria-busy={props.busy || undefined}
          title={capability.description}
          checked={isEnabled(capability.id)}
          disabled={disabled}
          onCheckedChange={(checked) =>
            props.onCapabilityEnabledChange
              ? props.onCapabilityEnabledChange(capability.id, checked)
              : props.onGreppyEnabledChange(checked)
          }
        >
          {capability.displayName}
        </MenuCheckboxItem>
      ))}
      {isEnabled("decision-hub") ? (
        <MenuGroup>
          <MenuSeparator />
          <MenuGroupLabel>Decision Hub</MenuGroupLabel>
          {decisionHubConnections.length === 0 ? (
            <StatusLine tone="warning">Keine CTOX-Verbindung</StatusLine>
          ) : (
            <MenuRadioGroup
              aria-label="Decision Hub Instanz"
              value={props.decisionHubConnectionId ?? ""}
              onValueChange={(value) => {
                if (typeof value === "string" && value.length > 0) {
                  props.onDecisionHubConnectionChange?.(value);
                }
              }}
            >
              {decisionHubConnections.map((connection) => (
                <MenuRadioItem
                  key={connection.connectionId}
                  value={connection.connectionId}
                  title={connection.reason ?? undefined}
                  disabled={disabled || props.onDecisionHubConnectionChange === undefined}
                >
                  <span className="flex min-w-0 items-baseline">
                    <span className="min-w-0 truncate">{connection.displayName}</span>
                    <ItemMeta>{connectionStatusLabel(connection.status)}</ItemMeta>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          )}
          {props.decisionHubConnectionId &&
          decisionHubConnections.length > 0 &&
          !decisionHubConnections.some(
            ({ connectionId }) => connectionId === props.decisionHubConnectionId,
          ) ? (
            <StatusLine tone="warning">Gewählte Instanz fehlt</StatusLine>
          ) : null}
        </MenuGroup>
      ) : null}
      {isEnabled("ctox-business-os") ? (
        <MenuGroup>
          <MenuSeparator />
          <MenuGroupLabel>CTOX Business OS</MenuGroupLabel>
          {ctoxConnections.length === 0 ? (
            <StatusLine tone="warning">Keine CTOX-Verbindung</StatusLine>
          ) : (
            <MenuRadioGroup
              aria-label="CTOX Business OS Instanz"
              value={props.ctoxBusinessOsConnectionId ?? ""}
              onValueChange={(value) => {
                if (typeof value === "string" && value.length > 0) {
                  props.onCtoxBusinessOsConnectionChange?.(value);
                }
              }}
            >
              {ctoxConnections.map((connection) => (
                <MenuRadioItem
                  key={connection.connectionId}
                  value={connection.connectionId}
                  title={connection.reason ?? undefined}
                  disabled={
                    disabled ||
                    props.ctoxBusinessOsConnectionLocked === true ||
                    props.onCtoxBusinessOsConnectionChange === undefined ||
                    connection.status !== "ready"
                  }
                >
                  <span className="flex min-w-0 items-baseline">
                    <span className="min-w-0 truncate">{connection.displayName}</span>
                    <ItemMeta>{connectionStatusLabel(connection.status)}</ItemMeta>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          )}
          {props.ctoxBusinessOsConnectionLocked ? <StatusLine>Instanz fest</StatusLine> : null}
          {props.onCtoxBusinessOsConnect && !props.ctoxBusinessOsConnectionLocked ? (
            <MenuItem
              aria-label="Business OS verbinden"
              disabled={disabled || props.ctoxBusinessOsConnecting === true}
              closeOnClick={false}
              onClick={props.onCtoxBusinessOsConnect}
            >
              <PlugIcon aria-hidden="true" />
              {props.ctoxBusinessOsConnecting ? "Verbindet…" : "Verbinden"}
            </MenuItem>
          ) : null}
          {props.ctoxBusinessOsConnectError ? (
            <StatusLine tone="warning">{props.ctoxBusinessOsConnectError}</StatusLine>
          ) : null}
        </MenuGroup>
      ) : null}
      {props.busy ? <StatusLine>Aktualisiert…</StatusLine> : null}
    </div>
  );
}

/** Wie viele Werkzeuge aktiv sind, als kurzer Status am Auslöser. */
function activeToolCount(props: WorkjetCapabilityMenuProps): number {
  if (props.onCapabilityEnabledChange) return (props.enabledCapabilityIds ?? []).length;
  return props.greppyEnabled ? 1 : 0;
}

/**
 * „Werkzeuge“: in der Leiste ein eigenes Dropdown, im Optionen-Menü
 * (`compact`) ein Untermenü. Kein Popover, keine Detailansicht.
 */
export function WorkjetCapabilityMenu(props: WorkjetCapabilityMenuProps) {
  const count = activeToolCount(props);
  if (props.compact) {
    return (
      <MenuSub>
        <MenuSubTrigger
          aria-label="Werkzeuge"
          aria-busy={props.busy || undefined}
          disabled={props.disabled}
        >
          <WrenchIcon aria-hidden="true" />
          Werkzeuge
          <ItemMeta>{count > 0 ? `${count} an` : "aus"}</ItemMeta>
        </MenuSubTrigger>
        <MenuSubPopup className="min-w-56 max-w-80">
          <WorkjetCapabilityMenuItems {...props} />
        </MenuSubPopup>
      </MenuSub>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        disabled={props.disabled || props.busy}
        render={
          <ComposerControl
            type="button"
            className="shrink-0 whitespace-nowrap"
            aria-label="Werkzeuge"
            aria-busy={props.busy || undefined}
          />
        }
      >
        <ComposerControlIcon icon={WrenchIcon} />
        <span>Werkzeuge</span>
        <ComposerControlChevron />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="min-w-56 max-w-80">
        <WorkjetCapabilityMenuItems {...props} />
      </MenuPopup>
    </Menu>
  );
}

export { GREPPY_CAPABILITY_ID };
