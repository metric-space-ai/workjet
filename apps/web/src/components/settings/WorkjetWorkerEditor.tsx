import {
  WorkjetComputerId,
  WorkjetLlmRouteId,
  WorkjetWorkerProfileId,
  type WorkjetCapabilityId,
  type WorkjetComputer,
  type WorkjetHarness,
  type WorkjetLlmRoute,
  type WorkjetReasoningSelection,
  type WorkjetWorkerProfile,
} from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { cn } from "../../lib/utils";
import { Textarea } from "../ui/textarea";

export const WORKJET_HARNESS_OPTIONS: ReadonlyArray<{
  readonly id: WorkjetHarness;
  readonly label: string;
}> = [
  { id: "claude-code", label: "Claude Code" },
  { id: "codex-cli", label: "Codex CLI" },
  { id: "opencode", label: "OpenCode" },
  { id: "grok-cli", label: "Grok CLI" },
  { id: "cursor-agent", label: "Cursor Agent" },
  { id: "pi-code", label: "Pi Code" },
];

const REASONING_OPTIONS: ReadonlyArray<{
  readonly id: WorkjetReasoningSelection;
  readonly label: string;
}> = [
  { id: "automatic", label: "Automatic" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra high" },
  { id: "max", label: "Max" },
  { id: "ultra", label: "Ultra" },
  { id: "ultracode", label: "Ultracode" },
  { id: "ultrathink", label: "Ultrathink" },
];

const CAPABILITY_OPTIONS: ReadonlyArray<{
  readonly id: WorkjetCapabilityId;
  readonly label: string;
  readonly description: string;
}> = [
  {
    id: "greppy",
    label: "Greppy",
    description: "Repository search and indexing when the target runtime supports it.",
  },
  {
    id: "web-search",
    label: "Web Research",
    description: "Current-source web research through the configured runtime.",
  },
  {
    id: "web-stack-browser",
    label: "Web Stack Browser",
    description: "Browser-backed inspection for web applications.",
  },
];

export interface WorkjetWorkerDraft {
  readonly id: string;
  readonly name: string;
  readonly instructions: string;
  readonly computerId: string;
  readonly harness: WorkjetHarness;
  readonly llmRouteId: string;
  readonly modelId: string;
  readonly reasoning: WorkjetReasoningSelection;
  readonly capabilityIds: ReadonlyArray<WorkjetCapabilityId>;
}

export function createWorkjetWorkerDraft(input: {
  readonly worker?: WorkjetWorkerProfile | null;
  readonly computers: ReadonlyArray<WorkjetComputer>;
  readonly routes: ReadonlyArray<WorkjetLlmRoute>;
  readonly id?: string;
}): WorkjetWorkerDraft {
  if (input.worker) {
    return {
      ...input.worker,
      instructions: input.worker.instructions ?? "",
    };
  }
  return {
    id: input.id ?? randomUUID(),
    name: "",
    instructions: "",
    computerId: input.computers[0]?.id ?? "",
    harness: "claude-code",
    llmRouteId: input.routes[0]?.id ?? "",
    modelId: "",
    reasoning: "automatic",
    capabilityIds: [],
  };
}

export function updateWorkjetWorkerDraft(
  draft: WorkjetWorkerDraft,
  patch: Partial<WorkjetWorkerDraft>,
): WorkjetWorkerDraft {
  return { ...draft, ...patch };
}

export function workjetHarnessAvailabilityWarning(
  draft: Pick<WorkjetWorkerDraft, "computerId" | "harness">,
  computers: ReadonlyArray<WorkjetComputer>,
): string | null {
  if (computers.length === 0) {
    return "Add a computer in Workjet Settings before saving this worker.";
  }
  const computer = computers.find((candidate) => candidate.id === draft.computerId);
  if (!computer) {
    return "The selected computer is no longer in the Workjet catalog. Choose or restore a computer target.";
  }
  const harness = computer.harnesses.find((candidate) => candidate.harness === draft.harness);
  if (harness?.available) return null;
  const label = WORKJET_HARNESS_OPTIONS.find((candidate) => candidate.id === draft.harness)?.label;
  return `${label ?? draft.harness} is not marked available on ${computer.label}. Enable it in Computers or keep this worker saved for later.`;
}

export function saveWorkjetWorkerDraft(draft: WorkjetWorkerDraft): WorkjetWorkerProfile {
  const name = draft.name.trim();
  const modelId = draft.modelId.trim();
  if (!name) throw new Error("Enter a worker name or role.");
  if (!draft.computerId) throw new Error("Choose a computer target.");
  if (!draft.llmRouteId) throw new Error("Choose an LLM route.");
  if (!modelId) throw new Error("Enter a model ID.");
  const instructions = draft.instructions.trim();
  return {
    id: WorkjetWorkerProfileId.make(draft.id),
    name,
    ...(instructions ? { instructions } : {}),
    computerId: WorkjetComputerId.make(draft.computerId),
    harness: draft.harness,
    llmRouteId: WorkjetLlmRouteId.make(draft.llmRouteId),
    modelId,
    reasoning: draft.reasoning,
    capabilityIds: [...draft.capabilityIds],
  };
}

function Field({
  id,
  label,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

/**
 * The segmented control the Swift Workjet worker panel uses for harness,
 * reasoning and target computer. A dropdown hides the option set behind a
 * click; with three to six choices the whole set fits on one line, and seeing
 * every option at once is the difference between picking and guessing.
 */
function ChoiceButton({
  title,
  selected,
  disabled,
  onClick,
}: {
  readonly title: string;
  readonly selected: boolean;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "rounded-md border px-2.5 py-1 text-xs whitespace-nowrap transition-colors",
        selected
          ? "border-primary bg-primary/20 text-foreground"
          : "border-border/60 bg-muted/20 text-muted-foreground hover:text-foreground",
        disabled ? "cursor-not-allowed opacity-40" : "",
      )}
    >
      {title}
    </button>
  );
}

function SectionHeader({ title, action }: { readonly title: string; readonly action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <h4 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h4>
      {action}
    </div>
  );
}

export function WorkjetWorkerEditor({
  worker = null,
  computers,
  routes,
  onSave,
  onCancel,
  onAddRoute,
}: {
  readonly worker?: WorkjetWorkerProfile | null;
  readonly computers: ReadonlyArray<WorkjetComputer>;
  readonly routes: ReadonlyArray<WorkjetLlmRoute>;
  readonly onSave: (worker: WorkjetWorkerProfile) => void;
  readonly onCancel: () => void;
  /** Opens the place where an access is created. Optional so existing callers keep working. */
  readonly onAddRoute?: (() => void) | undefined;
}) {
  const [draft, setDraft] = useState(() => createWorkjetWorkerDraft({ worker, computers, routes }));
  const [error, setError] = useState<string | null>(null);
  const warning = useMemo(
    () => workjetHarnessAvailabilityWarning(draft, computers),
    [computers, draft],
  );
  const harnessLabel =
    WORKJET_HARNESS_OPTIONS.find((option) => option.id === draft.harness)?.label ?? draft.harness;
  const chosenComputer = computers.find((computer) => computer.id === draft.computerId) ?? null;
  const harnessStatusLine =
    chosenComputer === null
      ? "No target computer chosen."
      : (warning ?? `${harnessLabel}: reported available on ${chosenComputer.label}.`);
  const patchDraft = (patch: Partial<WorkjetWorkerDraft>) => {
    setDraft((current) => updateWorkjetWorkerDraft(current, patch));
    setError(null);
  };

  return (
    <form
      className="space-y-4 rounded-xl border border-border/60 bg-muted/15 p-3 sm:p-4"
      aria-label={worker ? `Edit worker ${worker.name}` : "Add worker"}
      onSubmit={(event) => {
        event.preventDefault();
        try {
          onSave(saveWorkjetWorkerDraft(draft));
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "The worker could not be saved.");
        }
      }}
    >
      {/* Order, controls and wording follow the Swift Workjet worker panel:
          name → harness → provider → model → reasoning → task → skills →
          target computer → technical details. One column, because each choice
          narrows the next; a two-column grid put harness beside computer and
          broke that chain. */}
      <div className="space-y-1.5">
        <SectionHeader title="Name / role" />
        <Input
          id="workjet-worker-name"
          nativeInput
          value={draft.name}
          onChange={(event) => patchDraft({ name: event.target.value })}
          placeholder="e.g. Completion engine"
        />
      </div>

      <div className="space-y-1.5">
        <SectionHeader title="Harness" />
        <div className="flex flex-wrap gap-2">
          {WORKJET_HARNESS_OPTIONS.map((option) => (
            <ChoiceButton
              key={option.id}
              title={option.label}
              selected={draft.harness === option.id}
              onClick={() => patchDraft({ harness: option.id })}
            />
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <SectionHeader title="Provider" />
        <div className="flex flex-wrap items-center gap-2">
          {routes.map((route) => (
            <ChoiceButton
              key={route.id}
              title={route.label}
              selected={draft.llmRouteId === route.id}
              onClick={() => patchDraft({ llmRouteId: route.id })}
            />
          ))}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => onAddRoute?.()}
          >
            <PlusIcon className="size-3.5" />
            Set up access
          </Button>
        </div>
        {draft.llmRouteId ? (
          <p className="text-[11px] text-muted-foreground">
            Access: {routes.find((route) => route.id === draft.llmRouteId)?.label}
          </p>
        ) : (
          // Amber, not grey, and it names the consequence: a worker without an
          // access cannot run at all.
          <p className="text-[11px] text-amber-500">
            No access chosen yet. Pick a provider to make this worker usable.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <SectionHeader title="Model" />
        <Input
          id="workjet-worker-model"
          nativeInput
          value={draft.modelId}
          onChange={(event) => patchDraft({ modelId: event.target.value })}
          placeholder="Model ID"
        />
      </div>

      <div className="space-y-1.5">
        <SectionHeader title="Reasoning" />
        <div className="flex flex-wrap gap-2">
          {REASONING_OPTIONS.map((option) => (
            <ChoiceButton
              key={option.id}
              title={option.label}
              selected={draft.reasoning === option.id}
              onClick={() => patchDraft({ reasoning: option.id })}
            />
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <SectionHeader title="This worker’s task" />
        <Textarea
          id="workjet-worker-instructions"
          value={draft.instructions}
          onChange={(event) => patchDraft({ instructions: event.target.value })}
          placeholder="What should this worker take on?"
          rows={4}
        />
        <p className="text-[11px] text-muted-foreground">
          For this worker only; it goes into the system prompt as the worker’s task.
        </p>
      </div>

      <div className="space-y-1.5">
        <SectionHeader title="Skills" />
        <div className="space-y-2">
          {CAPABILITY_OPTIONS.map((capability) => {
            const checked = draft.capabilityIds.includes(capability.id);
            return (
              <div
                key={capability.id}
                className="flex items-start justify-between gap-3 rounded-lg bg-muted/25 p-2.5"
              >
                <div className="min-w-0 space-y-0.5">
                  <p className="text-xs font-medium">{capability.label}</p>
                  <p className="text-[11px] text-muted-foreground">{capability.description}</p>
                </div>
                <Switch
                  checked={checked}
                  onCheckedChange={(next) =>
                    patchDraft({
                      capabilityIds: next
                        ? [...draft.capabilityIds, capability.id]
                        : draft.capabilityIds.filter((id) => id !== capability.id),
                    })
                  }
                  aria-label={`Skill ${capability.label}`}
                />
              </div>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <SectionHeader title="Target computer" />
        <div className="flex flex-wrap gap-2">
          {computers.map((computer) => (
            <ChoiceButton
              key={computer.id}
              title={computer.label}
              selected={draft.computerId === computer.id}
              onClick={() => patchDraft({ computerId: computer.id })}
            />
          ))}
        </div>
        {/* The harness status for the CHOSEN computer, on the same screen as
            the choice. Swift puts it here because the answer to "can this
            worker actually run" belongs beside the machine, not on another
            page. */}
        <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span
            aria-hidden
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              warning === null ? "bg-emerald-500" : "bg-amber-500",
            )}
          />
          {harnessStatusLine}
        </p>
      </div>

      {/* Native <details>: the direct analogue of Swift's DisclosureGroup,
          keyboard- and screen-reader-correct without a library. */}
      <details className="group">
        <summary className="cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground">
          <span aria-hidden className="mr-1 inline-block group-open:rotate-90">
            &#9656;
          </span>
          Technical details
        </summary>
        <div>
          <dl className="mt-2 space-y-1 rounded-lg bg-muted/20 p-2.5 text-[11px] text-muted-foreground">
            <div className="flex gap-2">
              <dt className="w-28 shrink-0">Harness</dt>
              <dd className="font-mono">{draft.harness}</dd>
            </div>
            {/* Labels, not raw catalog ids: the operator recognises "gpu3",
                not a UUID. The id stays reachable as the hover title. */}
            <div className="flex gap-2">
              <dt className="w-28 shrink-0">Computer</dt>
              <dd title={draft.computerId || undefined}>
                {chosenComputer?.label ?? (draft.computerId ? "Missing computer" : "—")}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-28 shrink-0">Access</dt>
              <dd title={draft.llmRouteId || undefined}>
                {routes.find((route) => route.id === draft.llmRouteId)?.label ??
                  (draft.llmRouteId ? "Missing route" : "—")}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-28 shrink-0">Model</dt>
              <dd className="font-mono">{draft.modelId || "—"}</dd>
            </div>
          </dl>
        </div>
      </details>

      {warning ? (
        <p role="alert" className="text-xs text-warning-foreground">
          {warning}
        </p>
      ) : null}
      {routes.length === 0 ? (
        <p role="status" className="text-xs text-muted-foreground">
          Add an LLM route in Settings → Models before saving this worker.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Computer targets and connection secrets are managed in Connections. This profile stores the
        selected target and declared harness availability.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={computers.length === 0 || routes.length === 0}>
          Save worker
        </Button>
      </div>
    </form>
  );
}
