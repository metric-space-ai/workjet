import type {
  ProviderInteractionMode,
  WorkjetThreadRole,
  WorkjetConnectionSummary,
  WorkjetWorkerProfile,
} from "@t3tools/contracts";
import { memo, type CSSProperties, type ReactNode } from "react";
import { BotIcon, PencilRulerIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { ComposerWorkerControl } from "./ComposerWorkerControl";
import { WorkjetCapabilityMenu } from "./WorkjetCapabilityMenu";
import type { WorkjetSelectableRole } from "./WorkjetRoleControl";
import { Separator } from "../ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export type ComposerFooterRowCount = 1 | 2 | 3;

/**
 * Measured left-flow breakpoints. The primary send action occupies its own
 * fixed-width sibling, so the caller must measure the actual control flow
 * rather than the outer form or viewport. A sidebar or inspector can narrow
 * the same window without changing the responsive contract. Full Workjet
 * manual mode uses one, two, then three ordered rows at these tiers; the phone
 * overflow menu remains a single row.
 */
export const COMPOSER_FOOTER_ROW_BREAKPOINTS = Object.freeze({
  threeRowMaxWidth: 639,
  twoRowMaxWidth: 959,
});

export function composerFooterRowCountForWidth(width: number | null): ComposerFooterRowCount {
  if (width === null || width > COMPOSER_FOOTER_ROW_BREAKPOINTS.twoRowMaxWidth) return 1;
  if (width > COMPOSER_FOOTER_ROW_BREAKPOINTS.threeRowMaxWidth) return 2;
  return 3;
}

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
    <span className="inline-flex shrink-0 items-center gap-1" data-composer-mode-cluster="true">
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
    </span>
  );
});

export interface ComposerFooterControlsProps {
  /**
   * Worker mode ("a saved worker is selected") shows ONLY Worker · Computer ·
   * Context · Tools · Upload. A worker bundles harness, model, effort,
   * computer and its own
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
   * mode and after Worker/Manual in the manual row. The manual sequence then
   * continues Harness · Model · Effort/Context · System Prompt · Tools.
   */
  readonly computerControl?: ReactNode;
  /** Legacy provider/model picker, ordered after Worker and Computer. */
  readonly providerTargetControl?: ReactNode;
  /** Manual mode's Harness · Model selects, rendered after the computer. */
  readonly manualTargetControls?: ReactNode;
  /** Context usage status, ordered after effort and before prompt/tools. */
  readonly contextWindowControl?: ReactNode;
  /** Custom-system-prompt affordance; manual mode only. */
  readonly systemPromptControl?: ReactNode;
  /** The visible + menu, ordered after Tools and before the primary send. */
  readonly attachmentControl?: ReactNode;
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
  readonly decisionHubConnections?: ReadonlyArray<WorkjetConnectionSummary> | undefined;
  readonly decisionHubConnectionId?: string | null | undefined;
  readonly onDecisionHubConnectionChange?: ((connectionId: string) => void) | undefined;
  readonly onOpenWorkjetSettings: () => void;
  /** Full manual-mode row contract: 1, 2, or 3 ordered rows. */
  readonly rowCount?: ComposerFooterRowCount;
}

/**
 * The full (non-compact) composer footer's left control cluster, everything
 * after the provider/model controls.
 *
 * It exists as one component so the bar contract is testable in one place:
 *
 *   Worker mode:  Worker · Computer · Context · Tools · Upload — nothing else.
 *   Manual mode:  Worker/Manual · Computer · Harness · Model · Effort/Context
 *                 · System Prompt · Tools · Upload · Send to worker.
 */
export const ComposerFooterControls = memo(function ComposerFooterControls(
  props: ComposerFooterControlsProps,
) {
  const rowCount = props.rowCount ?? 1;
  const separator = (
    <Separator
      orientation="vertical"
      className={cn("mx-0.5 h-4", rowCount === 1 ? "hidden sm:block" : "hidden")}
    />
  );
  const contextWindowControl = props.contextWindowControl ? (
    <span className="inline-flex shrink-0 items-center gap-1" data-composer-context-window="true">
      {separator}
      {props.contextWindowControl}
    </span>
  ) : null;
  const rowBreak = (after: "computer" | "context") => (
    <span
      aria-hidden="true"
      className="h-0 w-0 basis-full p-0"
      data-composer-row-break-after={after}
    />
  );
  const controlDensityStyle: CSSProperties | undefined =
    rowCount === 1
      ? undefined
      : ({
          "--composer-control-height": "1.625rem",
          "--composer-control-font-size": rowCount === 2 ? "12px" : "11.5px",
          "--composer-control-gap": "0.125rem",
          "--composer-control-padding": rowCount === 2 ? "0.3125rem" : "0.25rem",
        } as CSSProperties);
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
      <span className="inline-flex shrink-0 items-center gap-1" data-composer-tools-cluster="true">
        {separator}
        <WorkjetCapabilityMenu
          greppyEnabled={props.workjetGreppyEnabled}
          busy={props.workjetBusy}
          disabled={props.workjetDisabled}
          onGreppyEnabledChange={props.onWorkjetGreppyEnabledChange}
          onCapabilityEnabledChange={props.onWorkjetCapabilityEnabledChange}
          enabledCapabilityIds={props.workjetEnabledCapabilityIds}
          decisionHubConnections={props.decisionHubConnections}
          decisionHubConnectionId={props.decisionHubConnectionId}
          onDecisionHubConnectionChange={props.onDecisionHubConnectionChange}
          workjetRole={props.workjetRole}
          onWorkjetRoleChange={props.onWorkjetRoleChange}
        />
      </span>
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
        {contextWindowControl}
        {capabilityMenu}
        {props.attachmentControl ?? null}
      </>
    );
  }

  // Manual mode is one strictly ordered responsive flow. It remains one line
  // while space is available, then wraps whole controls to two or (only at
  // the narrowest non-compact width) three rows. A grid is deliberately not
  // used here: auto-placement turned the controls into unrelated vertical
  // columns and created the broken checkerboard layout seen in the app.
  return (
    <div
      className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-1.5"
      data-composer-control-density={rowCount === 1 ? "comfortable" : "compact"}
      data-composer-manual-responsive-flow="true"
      style={controlDensityStyle}
    >
      {workerControl === null ? null : (
        <span className="inline-flex shrink-0 items-center gap-1">
          {workerControl}
          {separator}
        </span>
      )}
      {props.computerControl ? (
        <span className="inline-flex shrink-0 items-center gap-1">
          {props.computerControl}
          {separator}
        </span>
      ) : null}
      {rowCount === 3 ? rowBreak("computer") : null}
      {props.providerTargetControl ? (
        <span className="inline-flex shrink-0 items-center gap-1">
          {props.providerTargetControl}
          {separator}
        </span>
      ) : null}
      {props.manualTargetControls ?? null}
      {props.traitsPicker ??
        (props.workerMode ? null : (
          <Tooltip>
            <TooltipTrigger render={<ComposerControl aria-label="Effort" disabled type="button" />}>
              Effort —
            </TooltipTrigger>
            <TooltipPopup side="top">
              This model does not expose an effort setting on this harness
            </TooltipPopup>
          </Tooltip>
        ))}
      {contextWindowControl}
      {rowCount >= 2 ? rowBreak("context") : null}
      {props.systemPromptControl ||
      props.showInteractionModeToggle ||
      capabilityMenu ||
      props.attachmentControl ||
      props.sendToWorkerControl ? (
        <span
          className="inline-flex shrink-0 items-center gap-0.5"
          data-composer-secondary-cluster="true"
        >
          {props.systemPromptControl ?? null}
          <ComposerFooterModeControls
            showInteractionModeToggle={props.showInteractionModeToggle}
            interactionMode={props.interactionMode}
            onToggleInteractionMode={props.onToggleInteractionMode}
          />
          {capabilityMenu}
          {props.attachmentControl ?? null}
          {props.sendToWorkerControl}
        </span>
      ) : null}
    </div>
  );
});
