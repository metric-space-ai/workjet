import type { WorkjetHarness, WorkjetWorkerProfile } from "@t3tools/contracts";
import { memo } from "react";
import { UsersRoundIcon } from "lucide-react";

import { ComposerControlIcon, ComposerSelectControl } from "./ComposerControl";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  workjetHarnessDisplayLabel,
  workjetReasoningDisplayLabel,
} from "../settings/WorkjetWorkerEditor";

/**
 * Picking a saved Workjet worker for the next turn — the bar's leftmost
 * decision, because everything to its right follows from it.
 *
 * A worker profile already bundles the whole set: harness, provider access,
 * model, reasoning, target computer, skills and its own task text. Choosing
 * "UI/UX reviewer" is therefore one decision that settles six, which is the
 * point of having workers at all. Spelling those six out in the bar one
 * dropdown at a time asks the operator to reassemble a thing that is already
 * assembled.
 *
 * MANUAL is a first-class choice, not an empty state. It is what the bar has
 * always done — pick a model, pick an effort — and it stays available for the
 * one-off turn that matches no saved worker. With no workers saved yet, Manual
 * is simply the only choice, and the menu says where workers come from rather
 * than leaving a dead control.
 */
export const MANUAL_WORKER_VALUE = "__manual__";

/**
 * Which provider instance a worker's harness runs on.
 *
 * A worker names a HARNESS ("claude-code"); the composer drives a provider
 * INSTANCE ("claudeAgent"). Without this mapping choosing a worker could set a
 * model but not the runtime it belongs to, which would silently run one
 * worker’s model on another’s harness.
 *
 * `null` for a harness this build has no instance for — the caller must then
 * leave the selection alone rather than guess, because guessing here sends the
 * turn somewhere the operator did not choose.
 */
export function providerInstanceIdForHarness(harness: WorkjetHarness): string | null {
  switch (harness) {
    case "claude-code":
      return "claudeAgent";
    case "codex-cli":
      return "codex";
    case "opencode":
      return "opencode";
    case "grok-cli":
      return "grok";
    case "cursor-agent":
      return "cursor";
    default:
      return null;
  }
}

export interface ComposerWorkerControlProps {
  readonly workers: ReadonlyArray<WorkjetWorkerProfile>;
  /** `null` means manual: the individual model and effort controls apply. */
  readonly selectedWorkerId: string | null;
  readonly disabled?: boolean;
  readonly onSelectWorker: (workerId: string | null) => void;
  readonly onOpenWorkjetSettings: () => void;
}

/** Exported unwrapped so a test can call it; `memo` returns an object. */
export function ComposerWorkerControlView(props: ComposerWorkerControlProps) {
  const selected = props.workers.find((worker) => worker.id === props.selectedWorkerId) ?? null;
  const label = selected?.name ?? "Manual";
  const tooltip =
    selected === null
      ? "Manual — choose model, effort and tools yourself"
      : `Worker: ${selected.name}`;

  return (
    <Tooltip>
      <Select
        value={props.selectedWorkerId ?? MANUAL_WORKER_VALUE}
        onValueChange={(value) => {
          if (value === null) return;
          if (value === MANUAL_WORKER_VALUE) {
            props.onSelectWorker(null);
            return;
          }
          // The menu's own escape hatch: with nothing saved yet, the control
          // would otherwise be a dropdown with one entry and no way forward.
          if (value === "__configure__") {
            // An empty stash makes the Worker page open its create editor on
            // arrival — the jump used to land on the bare list (Befund F8).
            try {
              window.sessionStorage.setItem("workjet-worker-draft:new", "{}");
            } catch {
              // Without storage the navigation still lands on the page.
            }
            props.onOpenWorkjetSettings();
            return;
          }
          props.onSelectWorker(value);
        }}
      >
        <TooltipTrigger
          render={
            <ComposerSelectControl className="min-w-0 max-w-52 font-medium" aria-label="Worker" />
          }
        >
          <ComposerControlIcon icon={UsersRoundIcon} />
          <SelectValue className="min-w-0">{label}</SelectValue>
        </TooltipTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          <SelectItem value={MANUAL_WORKER_VALUE} hideIndicator className="min-w-64 py-2">
            <div className="grid min-w-0 gap-0.5">
              <span className="font-medium text-foreground">Manual</span>
              <span className="text-xs leading-4 text-muted-foreground">
                Choose harness, model, effort and tools in the bar.
              </span>
            </div>
          </SelectItem>
          {props.workers.map((worker) => (
            <SelectItem key={worker.id} value={worker.id} hideIndicator className="min-w-64 py-2">
              <div className="grid min-w-0 gap-0.5">
                <span className="font-medium text-foreground">{worker.name}</span>
                {/* The bundle the choice settles, so picking is not blind. */}
                <span className="truncate text-xs leading-4 text-muted-foreground">
                  {[
                    workjetHarnessDisplayLabel(worker.harness),
                    worker.modelId,
                    workjetReasoningDisplayLabel(worker.reasoning),
                  ].join(" · ")}
                </span>
              </div>
            </SelectItem>
          ))}
          {/* Creating belongs one click away from choosing: the entry jumps
              to the Worker settings page (operator request). */}
          <SelectItem value="__configure__" hideIndicator className="min-w-64 py-2">
            <span className="text-xs text-muted-foreground">
              {props.workers.length === 0
                ? "No saved workers — set one up in Workjet settings"
                : "+ Add worker…"}
            </span>
          </SelectItem>
        </SelectPopup>
      </Select>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export const ComposerWorkerControl = memo(ComposerWorkerControlView);
