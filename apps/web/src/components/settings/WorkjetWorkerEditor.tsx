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
import { useMemo, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
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

export function WorkjetWorkerEditor({
  worker = null,
  computers,
  routes,
  onSave,
  onCancel,
}: {
  readonly worker?: WorkjetWorkerProfile | null;
  readonly computers: ReadonlyArray<WorkjetComputer>;
  readonly routes: ReadonlyArray<WorkjetLlmRoute>;
  readonly onSave: (worker: WorkjetWorkerProfile) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => createWorkjetWorkerDraft({ worker, computers, routes }));
  const [error, setError] = useState<string | null>(null);
  const warning = useMemo(
    () => workjetHarnessAvailabilityWarning(draft, computers),
    [computers, draft],
  );
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
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="workjet-worker-name" label="Name / role">
          <Input
            id="workjet-worker-name"
            nativeInput
            value={draft.name}
            onChange={(event) => patchDraft({ name: event.target.value })}
            placeholder="Completion engine"
          />
        </Field>
        <Field id="workjet-worker-computer" label="Computer">
          <Select
            value={draft.computerId || null}
            onValueChange={(value) => patchDraft({ computerId: value ?? "" })}
          >
            <SelectTrigger id="workjet-worker-computer" aria-label="Worker computer">
              <SelectValue>
                {computers.find((computer) => computer.id === draft.computerId)?.label ??
                  "Choose computer"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {computers.map((computer) => (
                <SelectItem key={computer.id} value={computer.id}>
                  {computer.label} · {computer.presentationKind}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
        <Field id="workjet-worker-harness" label="Harness">
          <Select
            value={draft.harness}
            onValueChange={(value) => patchDraft({ harness: value as WorkjetHarness })}
          >
            <SelectTrigger id="workjet-worker-harness" aria-label="Worker harness">
              <SelectValue>
                {WORKJET_HARNESS_OPTIONS.find((option) => option.id === draft.harness)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {WORKJET_HARNESS_OPTIONS.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
        <Field id="workjet-worker-route" label="LLM route">
          <Select
            value={draft.llmRouteId || null}
            onValueChange={(value) => patchDraft({ llmRouteId: value ?? "" })}
          >
            <SelectTrigger id="workjet-worker-route" aria-label="Worker LLM route">
              <SelectValue>
                {routes.find((route) => route.id === draft.llmRouteId)?.label ?? "Choose route"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {routes.map((route) => (
                <SelectItem key={route.id} value={route.id}>
                  {route.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
        <Field id="workjet-worker-model" label="Model ID">
          <Input
            id="workjet-worker-model"
            nativeInput
            value={draft.modelId}
            onChange={(event) => patchDraft({ modelId: event.target.value })}
            placeholder="gpt-5.6-sol"
          />
        </Field>
        <Field id="workjet-worker-reasoning" label="Reasoning">
          <Select
            value={draft.reasoning}
            onValueChange={(value) => patchDraft({ reasoning: value as WorkjetReasoningSelection })}
          >
            <SelectTrigger id="workjet-worker-reasoning" aria-label="Worker reasoning">
              <SelectValue>
                {REASONING_OPTIONS.find((option) => option.id === draft.reasoning)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {REASONING_OPTIONS.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </Field>
      </div>

      <Field id="workjet-worker-instructions" label="Task / system instructions">
        <Textarea
          id="workjet-worker-instructions"
          value={draft.instructions}
          onChange={(event) => patchDraft({ instructions: event.target.value })}
          placeholder="Describe this worker's reusable role and operating instructions."
          rows={4}
        />
      </Field>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Capabilities</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {CAPABILITY_OPTIONS.map((capability) => {
            const checked = draft.capabilityIds.includes(capability.id);
            return (
              <Label
                key={capability.id}
                className="items-start rounded-lg border border-border/50 p-2.5"
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={(nextChecked) =>
                    patchDraft({
                      capabilityIds: nextChecked
                        ? [...draft.capabilityIds, capability.id]
                        : draft.capabilityIds.filter((id) => id !== capability.id),
                    })
                  }
                  aria-label={`Enable ${capability.label}`}
                />
                <span className="space-y-0.5">
                  <span className="block text-sm">{capability.label}</span>
                  <span className="block text-xs font-normal text-muted-foreground">
                    {capability.description}
                  </span>
                </span>
              </Label>
            );
          })}
        </div>
      </fieldset>

      {warning ? (
        <p role="alert" className="text-xs text-warning-foreground">
          {warning}
        </p>
      ) : null}
      {routes.length === 0 ? (
        <p role="status" className="text-xs text-muted-foreground">
          Add an LLM route in Workjet Settings before saving this worker.
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
