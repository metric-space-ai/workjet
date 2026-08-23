import type {
  ProviderInteractionMode,
  RuntimeMode,
  WorkjetThreadRole,
  WorkjetWorkerProfile,
} from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import {
  BotIcon,
  LockIcon,
  LockOpenIcon,
  PencilRulerIcon,
  PenLineIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { ComposerControl, ComposerControlIcon, ComposerSelectControl } from "./ComposerControl";
import { ComposerWorkerControl } from "./ComposerWorkerControl";
import { WorkjetCapabilityMenu } from "./WorkjetCapabilityMenu";
import { WorkjetRoleControl, type WorkjetSelectableRole } from "./WorkjetRoleControl";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Separator } from "../ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: SparklesIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];

/**
 * Access (runtime mode) plus the PROVIDER-SPECIFIC Plan/Build toggle. The
 * toggle is shown only for providers that have an interaction mode, which is
 * why it is a separate control from the Workjet role: one says how the provider
 * works inside this thread, the other what the thread is to Workjet.
 */
export const ComposerFooterModeControls = memo(function ComposerFooterModeControls(props: {
  showInteractionModeToggle: boolean;
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const runtimeModeOption = runtimeModeConfig[props.runtimeMode];
  const RuntimeModeIcon = runtimeModeOption.icon;
  const interactionModeTooltip =
    props.interactionMode === "plan"
      ? "Plan mode — click to return to normal build mode"
      : "Default mode — click to enter plan mode";

  const interactionModeToggle = props.showInteractionModeToggle ? (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              className={cn(
                "shrink-0 whitespace-nowrap",
                props.interactionMode === "plan"
                  ? "bg-accent text-accent-foreground hover:bg-accent/80"
                  : "text-secondary-label hover:text-foreground",
              )}
              type="button"
              onClick={props.onToggleInteractionMode}
              aria-label={interactionModeTooltip}
            />
          }
        >
          {props.interactionMode === "plan" ? (
            <ComposerControlIcon icon={PencilRulerIcon} className="text-current opacity-100" />
          ) : (
            <ComposerControlIcon icon={BotIcon} opticalSize="large" />
          )}
          <span className="sr-only sm:not-sr-only">
            {props.interactionMode === "plan" ? "Plan" : "Build"}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{interactionModeTooltip}</TooltipPopup>
      </Tooltip>
    </>
  ) : null;

  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

      <Tooltip>
        <Select
          value={props.runtimeMode}
          onValueChange={(value) => props.onRuntimeModeChange(value!)}
        >
          <TooltipTrigger
            render={<ComposerSelectControl className="font-medium" aria-label="Runtime mode" />}
          >
            <ComposerControlIcon icon={RuntimeModeIcon} />
            <SelectValue>{runtimeModeOption.label}</SelectValue>
          </TooltipTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {runtimeModeOptions.map((mode) => {
              const option = runtimeModeConfig[mode];
              const OptionIcon = option.icon;
              return (
                <SelectItem key={mode} value={mode} hideIndicator className="min-w-64 py-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid min-w-0 flex-1 gap-0.5">
                      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                        <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                        {option.label}
                      </span>
                      <span className="text-muted-foreground text-xs leading-4">
                        {option.description}
                      </span>
                    </div>
                  </div>
                </SelectItem>
              );
            })}
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">{runtimeModeOption.description}</TooltipPopup>
      </Tooltip>

      {interactionModeToggle}
    </>
  );
});

export interface ComposerFooterControlsProps {
  /**
   * Saved Workjet workers, leftmost in the bar. A worker bundles harness,
   * access, model, reasoning, computer and skills, so choosing one settles
   * what the controls to its right would otherwise ask separately. Omit to
   * leave the control out entirely.
   */
  readonly workjetWorkers?: ReadonlyArray<WorkjetWorkerProfile> | undefined;
  /** `null` is manual — the individual controls apply, as they always have. */
  readonly selectedWorkjetWorkerId?: string | null | undefined;
  readonly onSelectWorkjetWorker?: ((workerId: string | null) => void) | undefined;
  /** Provider traits picker, already resolved by the caller; null when the provider has none. */
  readonly traitsPicker: ReactNode;
  readonly showInteractionModeToggle: boolean;
  readonly interactionMode: ProviderInteractionMode;
  readonly runtimeMode: RuntimeMode;
  /** `null` on a draft thread, where there is no server thread to configure. */
  readonly workjetRole: WorkjetThreadRole | null;
  readonly workjetGreppyEnabled: boolean | null;
  readonly workjetBusy: boolean;
  readonly workjetDisabled: boolean;
  /** "Send to worker", supplied only for an orchestrator thread. */
  readonly sendToWorkerControl: ReactNode;
  readonly onToggleInteractionMode: () => void;
  readonly onRuntimeModeChange: (mode: RuntimeMode) => void;
  readonly onWorkjetRoleChange: (role: WorkjetSelectableRole) => void;
  readonly onWorkjetGreppyEnabledChange: (enabled: boolean) => void;
  readonly onWorkjetCapabilityEnabledChange?:
    | ((capabilityId: string, enabled: boolean) => void)
    | undefined;
  readonly workjetEnabledCapabilityIds?: ReadonlyArray<string> | undefined;
  readonly onOpenWorkjetSettings: () => void;
}

/**
 * The full (non-compact) composer footer's left control cluster, everything
 * after the provider/model picker.
 *
 * It exists as one component so the plan's constraint is testable in one place:
 * the Workjet `Code | Orchestrator` control is ADDED BESIDE the provider's
 * Plan/Build toggle, never in place of it.
 */
export const ComposerFooterControls = memo(function ComposerFooterControls(
  props: ComposerFooterControlsProps,
) {
  return (
    <>
      {props.workjetWorkers === undefined || props.onSelectWorkjetWorker === undefined ? null : (
        <>
          <ComposerWorkerControl
            workers={props.workjetWorkers}
            selectedWorkerId={props.selectedWorkjetWorkerId ?? null}
            disabled={props.workjetDisabled}
            onSelectWorker={props.onSelectWorkjetWorker}
            onOpenWorkjetSettings={props.onOpenWorkjetSettings}
          />
          <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
        </>
      )}
      {props.traitsPicker ? (
        <>
          <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
          {props.traitsPicker}
        </>
      ) : null}
      <ComposerFooterModeControls
        showInteractionModeToggle={props.showInteractionModeToggle}
        interactionMode={props.interactionMode}
        runtimeMode={props.runtimeMode}
        onToggleInteractionMode={props.onToggleInteractionMode}
        onRuntimeModeChange={props.onRuntimeModeChange}
      />
      {props.workjetRole === null ? null : (
        <>
          <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
          <WorkjetRoleControl
            role={props.workjetRole}
            busy={props.workjetBusy}
            disabled={props.workjetDisabled}
            onRoleChange={props.onWorkjetRoleChange}
            onOpenSettings={props.onOpenWorkjetSettings}
          />
        </>
      )}
      {props.workjetGreppyEnabled === null ? null : (
        <>
          <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
          <WorkjetCapabilityMenu
            greppyEnabled={props.workjetGreppyEnabled}
            busy={props.workjetBusy}
            disabled={props.workjetDisabled}
            onGreppyEnabledChange={props.onWorkjetGreppyEnabledChange}
            onCapabilityEnabledChange={props.onWorkjetCapabilityEnabledChange}
            enabledCapabilityIds={props.workjetEnabledCapabilityIds}
          />
        </>
      )}
      {props.sendToWorkerControl}
    </>
  );
});
