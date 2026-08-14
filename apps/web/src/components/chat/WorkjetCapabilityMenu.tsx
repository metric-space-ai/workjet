import type { WorkjetCapabilityId, WorkjetThreadConfig } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { SettingsIcon } from "lucide-react";

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

export const WORKJET_GREPPY_FAILURE_TOAST = {
  type: "error",
  title: "Could not update Greppy",
  description: "Greppy was left unchanged for this thread.",
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

export interface WorkjetCapabilityMenuProps {
  readonly compact?: boolean;
  readonly greppyEnabled: boolean;
  readonly busy: boolean;
  readonly disabled?: boolean;
  readonly onGreppyEnabledChange: (enabled: boolean) => void;
}

export function WorkjetCapabilityMenuContent(props: WorkjetCapabilityMenuProps) {
  const disabled = props.disabled === true || props.busy;

  return (
    <MenuGroup>
      <MenuGroupLabel>Workjet</MenuGroupLabel>
      <MenuCheckboxItem
        variant="switch"
        checked={props.greppyEnabled}
        disabled={disabled}
        aria-label="Greppy for this thread"
        aria-busy={props.busy || undefined}
        onCheckedChange={(checked) => props.onGreppyEnabledChange(checked === true)}
      >
        <span className="inline-flex items-center gap-2">
          <span>Greppy</span>
          {props.busy ? (
            <span className="text-muted-foreground text-xs" aria-hidden="true">
              Updating…
            </span>
          ) : null}
        </span>
      </MenuCheckboxItem>
      <p className="max-w-72 px-2 pb-1.5 pt-1 text-muted-foreground text-xs leading-4">
        Greppy is activated only for this thread. Its runtime and store are shared by all threads on
        this server.
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
            aria-label="Workjet thread settings"
          />
        }
      >
        <ComposerControlIcon icon={SettingsIcon} />
        <span className="sr-only sm:not-sr-only">Workjet</span>
      </MenuTrigger>
      <MenuPopup align="start" className="w-80">
        <WorkjetCapabilityMenuContent {...props} />
      </MenuPopup>
    </Menu>
  );
}

export { GREPPY_CAPABILITY_ID };
