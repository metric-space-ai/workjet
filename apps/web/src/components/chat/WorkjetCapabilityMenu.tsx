import type { WorkjetCapabilityId, WorkjetThreadConfig } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { resolveCapabilityCatalogForHost } from "@metric-space-ai/workjet-capabilities";
import { WrenchIcon } from "lucide-react";

import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuTrigger,
} from "../ui/menu";

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
export const WORKJET_CODE_HOST_ADAPTER = "t3-mcp" as const;

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
}

export function WorkjetCapabilityMenuContent(props: WorkjetCapabilityMenuProps) {
  const disabled = props.disabled === true || props.busy;
  const onCapabilityEnabledChange = props.onCapabilityEnabledChange;

  // Whole catalog when the caller can toggle any of it; otherwise the Greppy
  // row alone, so a caller that only wired Greppy cannot render switches that
  // silently do nothing.
  if (onCapabilityEnabledChange !== undefined) {
    const enabled = new Set(props.enabledCapabilityIds ?? []);
    return (
      <MenuGroup>
        <MenuGroupLabel>Tools</MenuGroupLabel>
        {workjetComposerCapabilityList().map((capability) => (
          <div key={capability.id}>
            <MenuCheckboxItem
              variant="switch"
              checked={enabled.has(capability.id)}
              disabled={disabled}
              aria-label={`${capability.displayName} for this thread`}
              aria-busy={props.busy || undefined}
              onCheckedChange={(checked) =>
                onCapabilityEnabledChange(capability.id, checked === true)
              }
            >
              <span className="inline-flex items-center gap-2">
                <span>{capability.displayName}</span>
                {props.busy ? (
                  <span className="text-muted-foreground text-xs" aria-hidden="true">
                    Updating…
                  </span>
                ) : null}
              </span>
            </MenuCheckboxItem>
            <p className="max-w-72 px-2 pt-1 pb-1.5 text-xs leading-4 text-muted-foreground">
              {capability.description}
            </p>
          </div>
        ))}
      </MenuGroup>
    );
  }

  return (
    <MenuGroup>
      <MenuGroupLabel>Tools</MenuGroupLabel>
      <MenuCheckboxItem
        variant="switch"
        checked={props.greppyEnabled}
        disabled={disabled}
        aria-label={`${WORKJET_GREPPY_DISPLAY_NAME} for this thread`}
        aria-busy={props.busy || undefined}
        onCheckedChange={(checked) => props.onGreppyEnabledChange(checked === true)}
      >
        <span className="inline-flex items-center gap-2">
          <span>{WORKJET_GREPPY_DISPLAY_NAME}</span>
          {props.busy ? (
            <span className="text-muted-foreground text-xs" aria-hidden="true">
              Updating…
            </span>
          ) : null}
        </span>
      </MenuCheckboxItem>
      <p className="max-w-72 px-2 pb-1.5 pt-1 text-muted-foreground text-xs leading-4">
        {WORKJET_GREPPY_DESCRIPTION} {WORKJET_GREPPY_ACTIVATION_NOTE}
      </p>
    </MenuGroup>
  );
}

export function WorkjetCapabilityMenu(props: WorkjetCapabilityMenuProps) {
  if (props.compact) {
    return <WorkjetCapabilityMenuContent {...props} />;
  }

  return (
    <Menu>
      <MenuTrigger
        disabled={props.disabled || props.busy}
        aria-busy={props.busy || undefined}
        render={
          <ComposerControl
            type="button"
            className="shrink-0 whitespace-nowrap"
            aria-label="Thread tools"
          />
        }
      >
        <ComposerControlIcon icon={WrenchIcon} />
        <span className="sr-only sm:not-sr-only">Tools</span>
      </MenuTrigger>
      <MenuPopup align="start" className="w-80">
        <WorkjetCapabilityMenuContent {...props} />
      </MenuPopup>
    </Menu>
  );
}

export { GREPPY_CAPABILITY_ID };
