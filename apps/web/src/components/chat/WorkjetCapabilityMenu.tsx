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
    displayName: workjetCapabilityDisplayName(manifest.id, manifest.metadata.displayName),
    description: manifest.metadata.description,
  }));

/**
 * Sichtbare deutsche Werkzeugnamen. Der Katalog liefert englische
 * Produktnamen („Decision Hub“, „CTOX Business OS“, „Web Search“); die
 * Oberfläche reicht sie nie roh durch. Eigennamen wie Greppy bleiben.
 */
export const WORKJET_CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  greppy: "Greppy",
  "web-search": "Websuche",
  "web-stack-browser": "Browser",
  "decision-hub": "Entscheidungszentrale",
  "ctox-business-os": "Instanz-Werkzeug",
};

export function workjetCapabilityDisplayName(id: string, fallback: string): string {
  return WORKJET_CAPABILITY_LABELS[id] ?? fallback;
}

/** Sichtbarer Name der Orchestrator-Rolle im Werkzeug-Menü. */
export const WORKJET_ORCHESTRATOR_TOGGLE_LABEL = "Lumas steuern";

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
  readonly onCtoxBusinessOsConnectionChange?: ((connectionId: string) => void) | undefined;
  /** Thread role belongs in this settings menu, never in the main composer bar. */
  readonly workjetRole?: WorkjetThreadRole | null | undefined;
  readonly onWorkjetRoleChange?: ((role: WorkjetSelectableRole) => void) | undefined;
}

/** Verbindungsstatus einer Instanz, deutsch und kurz. */
export function workjetConnectionStatusLabel(status: string): string {
  switch (status) {
    case "ready":
      return "bereit";
    case "connecting":
      return "verbindet";
    case "unavailable":
      return "nicht verfügbar";
    default:
      return "unbekannt";
  }
}

/** Ein leerer Zustand als einfacher, gesperrter Eintrag (kein Statussatz). */
function EmptyItem({ children }: { readonly children: ReactNode }) {
  return <MenuItem disabled>{children}</MenuItem>;
}

/**
 * Die Einträge des Werkzeug-Dropdowns, nur einfache Einträge: ein Haken je
 * Werkzeug (Name, kein Erklärsatz; die Katalogbeschreibung steht im Tooltip),
 * bei aktiver Entscheidungszentrale bzw. aktivem Instanz-Werkzeug die Instanz
 * als Auswahl. Keine Schalter, Statuszeilen oder Meter im Menü. Hook-frei,
 * damit Tests den Baum direkt prüfen können.
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
          data-workjet-setting="orchestrator"
          data-workjet-role-setting="true"
          aria-label={WORKJET_ORCHESTRATOR_TOGGLE_LABEL}
          aria-busy={props.busy || undefined}
          title={props.workjetRole === "worker" ? "Vom Eltern-Chat festgelegt" : undefined}
          checked={props.workjetRole === "orchestrator"}
          disabled={disabled || props.workjetRole === "worker"}
          onCheckedChange={(checked) =>
            props.onWorkjetRoleChange?.(checked ? "orchestrator" : "standard")
          }
        >
          {WORKJET_ORCHESTRATOR_TOGGLE_LABEL}
        </MenuCheckboxItem>
      ) : null}
      {capabilities.map((capability) => (
        <MenuCheckboxItem
          key={capability.id}
          data-workjet-setting={capability.id}
          aria-label={capability.displayName}
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
          <MenuGroupLabel>{workjetCapabilityDisplayName("decision-hub", "")}</MenuGroupLabel>
          {decisionHubConnections.length === 0 ? (
            <EmptyItem>Keine Instanz</EmptyItem>
          ) : (
            <MenuRadioGroup
              aria-label="Instanz der Entscheidungszentrale"
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
                  title={workjetConnectionStatusLabel(connection.status)}
                  disabled={disabled || props.onDecisionHubConnectionChange === undefined}
                >
                  {connection.displayName}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          )}
        </MenuGroup>
      ) : null}
      {isEnabled("ctox-business-os") ? (
        <MenuGroup>
          <MenuSeparator />
          <MenuGroupLabel>{workjetCapabilityDisplayName("ctox-business-os", "")}</MenuGroupLabel>
          {ctoxConnections.length === 0 ? (
            <EmptyItem>Keine Instanz</EmptyItem>
          ) : (
            <MenuRadioGroup
              aria-label="Instanz des Instanz-Werkzeugs"
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
                  title={
                    props.ctoxBusinessOsConnectionLocked === true
                      ? "Instanz fest"
                      : workjetConnectionStatusLabel(connection.status)
                  }
                  disabled={
                    disabled ||
                    props.ctoxBusinessOsConnectionLocked === true ||
                    props.onCtoxBusinessOsConnectionChange === undefined ||
                    connection.status !== "ready"
                  }
                >
                  {connection.displayName}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          )}
          {props.onCtoxBusinessOsConnect && !props.ctoxBusinessOsConnectionLocked ? (
            <MenuItem
              aria-label="Instanz verbinden"
              disabled={disabled || props.ctoxBusinessOsConnecting === true}
              closeOnClick={false}
              onClick={props.onCtoxBusinessOsConnect}
            >
              <PlugIcon aria-hidden="true" />
              {props.ctoxBusinessOsConnecting ? "Verbindet…" : "Verbinden"}
            </MenuItem>
          ) : null}
        </MenuGroup>
      ) : null}
    </div>
  );
}

/**
 * „Werkzeuge“: in der Leiste ein eigenes Dropdown, im Optionen-Menü
 * (`compact`) ein Untermenü. Kein Popover, keine Detailansicht.
 */
export function WorkjetCapabilityMenu(props: WorkjetCapabilityMenuProps) {
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
