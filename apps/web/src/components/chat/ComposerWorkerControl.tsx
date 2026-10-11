import type { EnvironmentId, WorkjetHarness, WorkjetWorkerProfile } from "@workjet/contracts";
import { memo } from "react";
import { SettingsIcon, UserRoundIcon } from "lucide-react";

import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from "./ComposerControl";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { workjetHarnessDisplayLabel } from "../settings/WorkjetWorkerEditor";

export const MANUAL_WORKER_VALUE = "__manual__";

/** Sichtbarer Name der manuellen Wahl (Harness, Modell und Rechner in der Leiste). */
export const MANUAL_WORKER_LABEL = "Manuell";

/** A worker's harness maps to the actual provider instance, never just its label. */
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
    case "greppy":
      return "greppy";
    case "minimax-code":
      return "minimax";
    case "pi-code":
      return "pi";
    default:
      return null;
  }
}

export interface ComposerWorkerControlProps {
  readonly workers: ReadonlyArray<WorkjetWorkerProfile>;
  readonly selectedWorkerId: string | null;
  /** Kept for callers; the dropdown no longer edits profiles in place. */
  readonly environmentId?: EnvironmentId | undefined;
  readonly disabled?: boolean;
  readonly onSelectWorker: (workerId: string | null) => void;
  readonly onOpenWorkjetSettings: () => void;
}

/** Kurze Meta eines Lumas: nur der Harness-Name, nie eine Roh-Modell-ID. */
export function workerChoiceMeta(worker: WorkjetWorkerProfile): string {
  return workjetHarnessDisplayLabel(worker.harness);
}

/**
 * Die Einträge des Luma-Dropdowns: „Manuell“, jeder gespeicherte Luma mit
 * seinem Harness, darunter „Lumas verwalten“ (Einstellungen → Lumas).
 * Hook-frei, damit Tests den Baum direkt prüfen können.
 */
export function ComposerWorkerMenuItems(
  props: Pick<
    ComposerWorkerControlProps,
    "workers" | "selectedWorkerId" | "disabled" | "onSelectWorker" | "onOpenWorkjetSettings"
  >,
) {
  return (
    <>
      <MenuRadioGroup
        value={props.selectedWorkerId ?? MANUAL_WORKER_VALUE}
        onValueChange={(value) => {
          if (typeof value !== "string") return;
          props.onSelectWorker(value === MANUAL_WORKER_VALUE ? null : value);
        }}
      >
        <MenuRadioItem value={MANUAL_WORKER_VALUE} disabled={props.disabled} closeOnClick>
          {MANUAL_WORKER_LABEL}
        </MenuRadioItem>
        {props.workers.map((worker) => (
          <MenuRadioItem key={worker.id} value={worker.id} disabled={props.disabled} closeOnClick>
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate">{worker.name}</span>
              <span className="ms-auto shrink-0 truncate text-muted-foreground text-xs">
                {workerChoiceMeta(worker)}
              </span>
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      <MenuSeparator />
      <MenuItem onClick={props.onOpenWorkjetSettings}>
        <SettingsIcon aria-hidden="true" />
        Lumas verwalten
      </MenuItem>
    </>
  );
}

export function ComposerWorkerControlView(props: ComposerWorkerControlProps) {
  const selected = props.workers.find((worker) => worker.id === props.selectedWorkerId) ?? null;
  return (
    <Menu>
      <MenuTrigger
        disabled={props.disabled}
        render={
          <ComposerControl
            type="button"
            className="min-w-0 max-w-52 font-medium"
            aria-label="Luma"
            title={selected ? workerChoiceMeta(selected) : undefined}
          />
        }
      >
        <ComposerControlIcon icon={UserRoundIcon} />
        <span className="min-w-0 truncate">{selected?.name ?? MANUAL_WORKER_LABEL}</span>
        <ComposerControlChevron />
      </MenuTrigger>
      <MenuPopup align="start" side="top" className="max-h-80 min-w-56 max-w-80 overflow-y-auto">
        <ComposerWorkerMenuItems {...props} />
      </MenuPopup>
    </Menu>
  );
}

export const ComposerWorkerControl = memo(ComposerWorkerControlView);
