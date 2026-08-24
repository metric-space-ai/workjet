import type {
  ProviderInteractionMode,
  WorkjetThreadRole,
  WorkjetWorkerProfile,
} from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { BotIcon, PencilRulerIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { ComposerWorkerControl } from "./ComposerWorkerControl";
import { WorkjetCapabilityMenu } from "./WorkjetCapabilityMenu";
import { WorkjetRoleControl, type WorkjetSelectableRole } from "./WorkjetRoleControl";
import { Separator } from "../ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The PROVIDER-SPECIFIC Plan/Build toggle. The toggle is shown only for
 * providers that have an interaction mode, which is why it is a separate
 * control from the Workjet role: one says how the provider works inside this
 * thread, the other what the thread is to Workjet.
 *
 * There is no permission picker here. The operator's rule: permission is
 * ALWAYS full. DEFAULT_RUNTIME_MODE is "full-access" already; offering a
 * selector only made it possible to quietly run below that rule and spent bar
 * width restating it.
 */
export const ComposerFooterModeControls = memo(function ComposerFooterModeControls(props: {
  showInteractionModeToggle: boolean;
  interactionMode: ProviderInteractionMode;
  onToggleInteractionMode: () => void;
}) {
  const interactionModeTooltip =
    props.interactionMode === "plan"
      ? "Plan mode — click to return to normal build mode"
      : "Default mode — click to enter plan mode";

  if (!props.showInteractionModeToggle) return null;

  return (
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
  );
});

export interface ComposerFooterControlsProps {
  /**
   * Worker mode ("a saved worker is selected") shows ONLY Worker · Computer ·
   * Extras. A worker bundles harness, model, effort, computer and its own
   * task text, so the manual controls, the Plan/Build toggle, the
   * `Code | Orchestrator` radio (with its settings gear) and "Send to worker"
   * all disappear — two sources of truth for one decision is a farce.
   */
  readonly workerMode: boolean;
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
  /**
   * The Computer ("Rechner") select — after the Worker control in worker
   * mode, directly after the Model controls in manual mode.
   */
  readonly computerControl?: ReactNode;
  /** Custom-system-prompt affordance; manual mode only. */
  readonly systemPromptControl?: ReactNode;
  /** Provider traits picker, already resolved by the caller; null when the provider has none. */
  readonly traitsPicker: ReactNode;
  readonly showInteractionModeToggle: boolean;
  readonly interactionMode: ProviderInteractionMode;
  /** `null` on a draft thread, where there is no server thread to configure. */
  readonly workjetRole: WorkjetThreadRole | null;
  readonly workjetGreppyEnabled: boolean | null;
  readonly workjetBusy: boolean;
  readonly workjetDisabled: boolean;
  /** "Send to worker", supplied only for an orchestrator thread. */
  readonly sendToWorkerControl: ReactNode;
  readonly onToggleInteractionMode: () => void;
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
 * after the provider/model controls.
 *
 * It exists as one component so the bar contract is testable in one place:
 *
 *   Worker mode:  Worker · Computer · Extras — nothing else.
 *   Manual mode:  Computer (after the model controls to its left) · Worker ·
 *                 traits · Plan/Build · Code|Orchestrator · Extras · custom
 *                 system prompt · Send to worker.
 */
export const ComposerFooterControls = memo(function ComposerFooterControls(
  props: ComposerFooterControlsProps,
) {
  const separator = <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />;
  const workerControl =
    props.workjetWorkers === undefined || props.onSelectWorkjetWorker === undefined ? null : (
      <ComposerWorkerControl
        workers={props.workjetWorkers}
        selectedWorkerId={props.selectedWorkjetWorkerId ?? null}
        disabled={props.workjetDisabled}
        onSelectWorker={props.onSelectWorkjetWorker}
        onOpenWorkjetSettings={props.onOpenWorkjetSettings}
      />
    );
  const capabilityMenu =
    props.workjetGreppyEnabled === null ? null : (
      <>
        {separator}
        <WorkjetCapabilityMenu
          greppyEnabled={props.workjetGreppyEnabled}
          busy={props.workjetBusy}
          disabled={props.workjetDisabled}
          onGreppyEnabledChange={props.onWorkjetGreppyEnabledChange}
          onCapabilityEnabledChange={props.onWorkjetCapabilityEnabledChange}
          enabledCapabilityIds={props.workjetEnabledCapabilityIds}
        />
      </>
    );

  if (props.workerMode) {
    // Worker · Computer · Extras. Nothing else — the worker already settled
    // model, effort, plan behavior and role for this turn.
    return (
      <>
        {workerControl === null ? null : (
          <>
            {workerControl}
            {separator}
          </>
        )}
        {props.computerControl ?? null}
        {capabilityMenu}
      </>
    );
  }

  return (
    <>
      {/* Manual mode: the Computer select reads as the fourth manual choice —
          Harness · Provider · Model live directly to the left of this
          cluster, so it renders BEFORE the Worker control. */}
      {props.computerControl ? (
        <>
          {props.computerControl}
          {separator}
        </>
      ) : null}
      {workerControl === null ? null : (
        <>
          {workerControl}
          {separator}
        </>
      )}
      {props.traitsPicker ? (
        <>
          {separator}
          {props.traitsPicker}
        </>
      ) : null}
      <ComposerFooterModeControls
        showInteractionModeToggle={props.showInteractionModeToggle}
        interactionMode={props.interactionMode}
        onToggleInteractionMode={props.onToggleInteractionMode}
      />
      {props.workjetRole === null ? null : (
        <>
          {separator}
          <WorkjetRoleControl
            role={props.workjetRole}
            busy={props.workjetBusy}
            disabled={props.workjetDisabled}
            onRoleChange={props.onWorkjetRoleChange}
            onOpenSettings={props.onOpenWorkjetSettings}
          />
        </>
      )}
      {capabilityMenu}
      {props.systemPromptControl ?? null}
      {props.sendToWorkerControl}
    </>
  );
});
