import type { EnvironmentId, WorkjetHarness, WorkjetWorkerProfile } from "@workjet/contracts";
import { memo, useCallback, useRef, useState } from "react";
import { CheckIcon, ChevronRightIcon, PlusIcon, UsersRoundIcon } from "lucide-react";

import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from "./ComposerControl";
import { ExpandableSettingsPopup } from "../ui/expandable-settings-popup";
import { cn } from "~/lib/utils";
import {
  workjetHarnessDisplayLabel,
  workjetReasoningDisplayLabel,
  type WorkjetWorkerDraft,
} from "../settings/WorkjetWorkerEditor";
import { WorkerProfilePopupEditor } from "./WorkerProfilePopupEditor";

export const MANUAL_WORKER_VALUE = "__manual__";

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
    default:
      return null;
  }
}

export interface ComposerWorkerControlProps {
  readonly workers: ReadonlyArray<WorkjetWorkerProfile>;
  readonly selectedWorkerId: string | null;
  readonly environmentId?: EnvironmentId | undefined;
  readonly disabled?: boolean;
  readonly onSelectWorker: (workerId: string | null) => void;
  readonly onOpenWorkjetSettings: () => void;
}

export function WorkerChoiceList({
  workers,
  selectedWorkerId,
  disabled,
  onSelectWorker,
  onEditWorker,
  editingWorkerId,
  query = "",
  onQueryChange,
}: Pick<
  ComposerWorkerControlProps,
  "workers" | "selectedWorkerId" | "disabled" | "onSelectWorker"
> & {
  readonly onEditWorker: (workerId: string | null) => void;
  readonly editingWorkerId?: string | null | undefined;
  readonly query?: string | undefined;
  readonly onQueryChange?: ((query: string) => void) | undefined;
}) {
  const terms = query.normalize("NFKC").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = workers.filter((worker) => {
    const description = [
      worker.name,
      workjetHarnessDisplayLabel(worker.harness),
      worker.modelId,
      workjetReasoningDisplayLabel(worker.reasoning),
    ]
      .join(" ")
      .normalize("NFKC")
      .toLowerCase();
    return terms.every((term) => description.includes(term));
  });
  const choiceClass =
    "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
  return (
    <div className="space-y-0.5">
      <input
        type="search"
        aria-label="Search workers"
        placeholder="Search workers…"
        value={query}
        disabled={disabled}
        onChange={(event) => onQueryChange?.(event.currentTarget.value)}
        className="mb-2 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      />
      <button
        type="button"
        className={choiceClass}
        disabled={disabled}
        aria-pressed={selectedWorkerId === null}
        onClick={() => onSelectWorker(null)}
      >
        <div className="min-w-0 flex-1">
          <p className="font-medium">Manual</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Choose harness, model, effort and tools in the bar.
          </p>
        </div>
        {selectedWorkerId === null ? (
          <CheckIcon aria-hidden="true" className="size-4 shrink-0" />
        ) : null}
      </button>
      {matches.map((worker) => (
        <div
          key={worker.id}
          className={cn(
            "flex items-center gap-0.5 rounded-md",
            editingWorkerId === worker.id && "bg-accent/50",
          )}
        >
          <button
            type="button"
            className={choiceClass}
            disabled={disabled}
            aria-pressed={selectedWorkerId === worker.id}
            onClick={() => onSelectWorker(worker.id)}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{worker.name}</p>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {[
                  workjetHarnessDisplayLabel(worker.harness),
                  worker.modelId,
                  workjetReasoningDisplayLabel(worker.reasoning),
                ].join(" · ")}
              </p>
            </div>
            {selectedWorkerId === worker.id ? (
              <CheckIcon aria-hidden="true" className="size-4 shrink-0" />
            ) : null}
          </button>
          <button
            type="button"
            disabled={disabled}
            aria-label={`Edit ${worker.name}`}
            aria-expanded={editingWorkerId === worker.id}
            className="shrink-0 rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
            onClick={() => onEditWorker(worker.id)}
          >
            <ChevronRightIcon
              aria-hidden="true"
              className={cn("size-4", editingWorkerId === worker.id && "rotate-180")}
            />
          </button>
        </div>
      ))}
      {workers.length === 0 ? (
        <p className="px-2 py-2 text-xs text-muted-foreground">No saved workers</p>
      ) : matches.length === 0 ? (
        <p role="status" className="px-2 py-2 text-xs text-muted-foreground">
          No matching workers
        </p>
      ) : null}
      <button
        type="button"
        disabled={disabled}
        className={cn(choiceClass, "mt-2 border-t border-border/60 text-muted-foreground")}
        onClick={() => onEditWorker(null)}
      >
        <PlusIcon aria-hidden="true" className="size-4" /> Add worker…
      </button>
    </div>
  );
}

export function ComposerWorkerControlView(props: ComposerWorkerControlProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<{ workerId: string | null } | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, WorkjetWorkerDraft>>>({});
  const [saving, setSaving] = useState(false);
  const lastEditButton = useRef<HTMLElement | null>(null);
  const selected = props.workers.find((worker) => worker.id === props.selectedWorkerId) ?? null;
  const draftKey = JSON.stringify([props.environmentId, editing?.workerId]);
  const rememberDraft = useCallback(
    (draft: WorkjetWorkerDraft) => {
      setDrafts((current) => ({ ...current, [draftKey]: draft }));
    },
    [draftKey],
  );
  const finishEditor = () => {
    setDrafts((current) => {
      const next = { ...current };
      delete next[draftKey];
      return next;
    });
    setEditing(null);
  };
  const goBack = () => {
    if (saving) return;
    setEditing(null);
    requestAnimationFrame(() => lastEditButton.current?.focus());
  };

  return (
    <ExpandableSettingsPopup
      open={open}
      onOpenChange={(next) => {
        if (!saving) {
          if (next) setQuery("");
          setOpen(next);
        }
      }}
      title="Workers"
      trigger={
        <ComposerControl
          type="button"
          disabled={props.disabled}
          className="min-w-0 max-w-52 font-medium"
          aria-label="Worker"
        >
          <ComposerControlIcon icon={UsersRoundIcon} />
          <span className="min-w-0 truncate">{selected?.name ?? "Manual"}</span>
          <ComposerControlChevron />
        </ComposerControl>
      }
      list={
        <WorkerChoiceList
          workers={props.workers}
          selectedWorkerId={props.selectedWorkerId}
          disabled={props.disabled || saving}
          editingWorkerId={editing?.workerId}
          query={query}
          onQueryChange={setQuery}
          onSelectWorker={(id) => {
            props.onSelectWorker(id);
            setOpen(false);
          }}
          onEditWorker={(workerId) => {
            if (props.environmentId === undefined) {
              props.onOpenWorkjetSettings();
              return;
            }
            if (workerId !== null && editing?.workerId === workerId) {
              goBack();
              return;
            }
            lastEditButton.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            setEditing({ workerId });
          }}
        />
      }
      detailTitle={
        editing?.workerId === null
          ? "New worker"
          : (props.workers.find((worker) => worker.id === editing?.workerId)?.name ?? "Worker")
      }
      onBack={goBack}
      detail={
        editing && props.environmentId ? (
          <WorkerProfilePopupEditor
            key={draftKey}
            environmentId={props.environmentId}
            workerId={editing.workerId}
            draft={drafts[draftKey]}
            onDraftChange={rememberDraft}
            onSavingChange={setSaving}
            onSaved={finishEditor}
            onCancel={finishEditor}
          />
        ) : undefined
      }
    />
  );
}

export const ComposerWorkerControl = memo(ComposerWorkerControlView);
