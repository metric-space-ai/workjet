import {
  EnvironmentId,
  WorkjetComputerId,
  type WorkjetComputer,
  type WorkjetComputerPresentationKind,
  type WorkjetHarness,
  type WorkjetHarnessAvailabilitySnapshot,
  type WorkjetHarnessConfiguration,
} from "@workjet/contracts";
import { useEffect, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { WORKJET_HARNESS_OPTIONS } from "./WorkjetWorkerEditor";
import { cn } from "../../lib/utils";
import {
  resolveHarnessAvailabilityView,
  type HarnessAvailabilityView,
} from "./workjetHarnessAvailabilityView";

export interface WorkjetEnvironmentTargetOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly presentationKind: WorkjetComputerPresentationKind;
  readonly detail: string;
}

export interface WorkjetComputerDraft {
  readonly id: string;
  readonly label: string;
  readonly environmentId: string;
  /** The picked environment's own label — the boundary between "default
      name" and "operator-typed name" for the custom-label guard (K-AH3). */
  readonly environmentDefaultLabel: string;
  readonly presentationKind: WorkjetComputerPresentationKind;
  readonly harnesses: ReadonlyArray<{
    readonly harness: WorkjetHarness;
    readonly available: boolean;
    readonly executableOverride: string;
  }>;
}

export function createWorkjetComputerDraft(input: {
  readonly computer?: WorkjetComputer | null;
  readonly environments: ReadonlyArray<WorkjetEnvironmentTargetOption>;
  readonly id?: string;
}): WorkjetComputerDraft {
  const environment = input.environments[0];
  return {
    id: input.computer?.id ?? input.id ?? randomUUID(),
    label: input.computer?.label ?? environment?.label ?? "",
    environmentId: input.computer?.environmentId ?? environment?.environmentId ?? "",
    environmentDefaultLabel: environment?.label ?? "",
    presentationKind: input.computer?.presentationKind ?? environment?.presentationKind ?? "remote",
    harnesses: WORKJET_HARNESS_OPTIONS.map(({ id }) => {
      const configured = input.computer?.harnesses.find((entry) => entry.harness === id);
      return {
        harness: id,
        available: configured?.available ?? false,
        executableOverride: configured?.executableOverride ?? "",
      };
    }),
  };
}

export function selectWorkjetComputerEnvironment(
  draft: WorkjetComputerDraft,
  environment: WorkjetEnvironmentTargetOption,
): WorkjetComputerDraft {
  // The environment's label is only a DEFAULT: a name the operator typed
  // themselves must survive re-picking an environment (Befund K-AH3). Only
  // an empty label or one that still equals the previous environment's
  // default gets replaced.
  const labelWasCustom =
    draft.label.trim() !== "" &&
    draft.label !== environment.label &&
    draft.environmentId !== environment.environmentId &&
    draft.label !== draft.environmentDefaultLabel;
  return {
    ...draft,
    environmentId: environment.environmentId,
    label: labelWasCustom ? draft.label : environment.label,
    environmentDefaultLabel: environment.label,
    presentationKind: environment.presentationKind,
  };
}

export function updateWorkjetComputerHarness(
  draft: WorkjetComputerDraft,
  harness: WorkjetHarness,
  patch: Partial<WorkjetComputerDraft["harnesses"][number]>,
): WorkjetComputerDraft {
  return {
    ...draft,
    harnesses: draft.harnesses.map((entry) =>
      entry.harness === harness ? { ...entry, ...patch, harness } : entry,
    ),
  };
}

export function saveWorkjetComputerDraft(draft: WorkjetComputerDraft): WorkjetComputer {
  const label = draft.label.trim();
  if (!label) throw new Error("Enter a computer label.");
  if (!draft.environmentId) throw new Error("Choose a computer connection.");
  const harnesses: WorkjetHarnessConfiguration[] = draft.harnesses.map((entry) => {
    const executableOverride = entry.executableOverride.trim();
    return {
      harness: entry.harness,
      available: entry.available,
      ...(executableOverride ? { executableOverride } : {}),
    };
  });
  return {
    id: WorkjetComputerId.make(draft.id),
    label,
    environmentId: EnvironmentId.make(draft.environmentId),
    presentationKind: draft.presentationKind,
    harnesses,
  };
}

/** Preserve saved connection identity, then await the settings acknowledgement. */
export async function persistWorkjetComputerDraft(
  draft: WorkjetComputerDraft,
  environments: ReadonlyArray<WorkjetEnvironmentTargetOption>,
  onSave: (computer: WorkjetComputer) => void | Promise<void>,
  computer?: WorkjetComputer | null,
): Promise<void> {
  const environment = environments.find((item) => item.environmentId === draft.environmentId);
  if (!environment && !computer) throw new Error("Choose a connected computer.");
  await onSave(
    saveWorkjetComputerDraft({
      ...draft,
      id: computer?.id ?? draft.id,
      environmentId: computer?.environmentId ?? draft.environmentId,
      presentationKind: computer?.presentationKind ?? environment!.presentationKind,
    }),
  );
}

const PRESENTATION_OPTIONS: ReadonlyArray<{
  readonly id: WorkjetComputerPresentationKind;
  readonly label: string;
}> = [
  { id: "local", label: "Local" },
  { id: "workjet-connect", label: "Relay connection" },
  { id: "ssh", label: "SSH" },
  { id: "tailscale", label: "Tailscale" },
  { id: "remote", label: "Remote" },
];

/**
 * Shows the DISAGREEMENT between the switch and the probe, and only that.
 *
 * Agreement and "not probed" render nothing: the switch already says what the
 * operator decided, and repeating it back adds a line per harness to a list
 * that is mostly uneventful. The whole value here is the mismatch.
 */
function HarnessAvailabilityNote({
  view,
  compact,
}: {
  readonly view: HarnessAvailabilityView;
  readonly compact: boolean;
}) {
  if (view.kind === "agrees" || view.kind === "unknown") return null;
  const isProblem = view.kind === "declared-but-missing";
  return (
    <p
      className={cn(
        "text-xs",
        !compact && "sm:col-span-3",
        isProblem ? "text-destructive" : "text-muted-foreground",
      )}
      data-workjet-harness-availability={view.kind}
      role={isProblem ? "alert" : undefined}
    >
      {isProblem
        ? `Switched on, but this host cannot run it. ${view.reason}`
        : `Installed on this host${view.version === undefined ? "" : ` (${view.version})`}, but switched off here.`}
    </p>
  );
}

export function WorkjetComputerEditor({
  computer = null,
  environments,
  onSave,
  onCancel,
  availability = null,
  initialDraft,
  onDraftChange,
  compact = false,
}: {
  readonly computer?: WorkjetComputer | null;
  readonly environments: ReadonlyArray<WorkjetEnvironmentTargetOption>;
  readonly onSave: (computer: WorkjetComputer) => void | Promise<void>;
  readonly onCancel: () => void;
  readonly initialDraft?: WorkjetComputerDraft | undefined;
  readonly onDraftChange?: ((draft: WorkjetComputerDraft) => void) | undefined;
  readonly compact?: boolean;
  /**
   * What the host actually found, from `workjet.harness.inspect`. Optional and
   * defaulting to null so every existing caller and test keeps working and the
   * editor stays usable before a probe has ever run — an absent probe shows
   * nothing rather than implying agreement.
   */
  readonly availability?: WorkjetHarnessAvailabilitySnapshot | null;
}) {
  const [draft, setDraft] = useState(
    () => initialDraft ?? createWorkjetComputerDraft({ computer, environments }),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  useEffect(() => onDraftChange?.(draft), [draft, onDraftChange]);
  const selectedEnvironment = environments.find(
    (environment) => environment.environmentId === draft.environmentId,
  );

  return (
    <form
      data-settings-inline-editor=""
      className={cn(
        "space-y-4",
        !compact && "rounded-xl border border-border/60 bg-muted/15 p-3 sm:p-4",
      )}
      aria-label={computer ? `Edit computer ${computer.label}` : "Add computer"}
      aria-busy={saving}
      onSubmit={async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (saveInFlight.current) return;
        saveInFlight.current = true;
        setSaving(true);
        setError(null);
        try {
          await persistWorkjetComputerDraft(draft, environments, onSave, computer);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "The computer could not be saved.");
        } finally {
          saveInFlight.current = false;
          setSaving(false);
        }
      }}
    >
      <fieldset disabled={saving} className="min-w-0 space-y-4">
        <div className={cn("grid gap-3", !compact && "sm:grid-cols-2")}>
          {!computer ? (
            <div className="space-y-1.5">
              <Label htmlFor="workjet-computer-environment">Connection</Label>
              <Select
                value={draft.environmentId || null}
                onValueChange={(value) => {
                  const environment = environments.find(
                    (candidate) => candidate.environmentId === value,
                  );
                  if (environment)
                    setDraft((current) => selectWorkjetComputerEnvironment(current, environment));
                  setError(null);
                }}
              >
                <SelectTrigger id="workjet-computer-environment" aria-label="Computer connection">
                  <SelectValue>{selectedEnvironment?.label ?? "Choose computer"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {environments.map((environment) => (
                    <SelectItem key={environment.environmentId} value={environment.environmentId}>
                      {environment.label} · {environment.detail}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="workjet-computer-label">Name</Label>
            <Input
              id="workjet-computer-label"
              nativeInput
              value={draft.label}
              onChange={(event) => {
                setDraft((current) => ({ ...current, label: event.target.value }));
                setError(null);
              }}
            />
          </div>
          <div className={cn("space-y-1.5", !compact && "sm:col-span-2")}>
            <Label htmlFor="workjet-computer-kind">Connection type</Label>
            <p id="workjet-computer-kind" className="text-sm text-muted-foreground">
              {PRESENTATION_OPTIONS.find(
                (option) =>
                  option.id ===
                  (computer?.presentationKind ?? selectedEnvironment?.presentationKind),
              )?.label ?? "Unavailable connection"}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <div>
            <h3 className="text-sm font-medium">Coding tools</h3>
            <p className="text-xs text-muted-foreground">
              Choose which installed tools Workjet may use on this computer.
            </p>
          </div>
          {draft.harnesses.map((configuration) => {
            const label = WORKJET_HARNESS_OPTIONS.find(
              (option) => option.id === configuration.harness,
            )?.label;
            const inputId = `workjet-computer-${configuration.harness}-executable`;
            return (
              <div
                key={configuration.harness}
                className={cn(
                  "grid gap-2 rounded-lg border border-border/50 p-2.5",
                  !compact &&
                    "sm:grid-cols-[minmax(8rem,1fr)_minmax(12rem,1.5fr)_auto] sm:items-center",
                )}
              >
                <Label htmlFor={inputId}>{label}</Label>
                {/* The override is an expert escape hatch, and six always-open
                  text inputs made the form read like a deployment script (the
                  Swift editor shows availability first). Folded away unless a
                  value exists — an existing override stays visible, because a
                  hidden ACTIVE override would be worse than the clutter. */}
                {configuration.executableOverride ? (
                  <Input
                    id={inputId}
                    nativeInput
                    value={configuration.executableOverride}
                    onChange={(event) =>
                      setDraft((current) =>
                        updateWorkjetComputerHarness(current, configuration.harness, {
                          executableOverride: event.target.value,
                        }),
                      )
                    }
                    placeholder="Optional executable override"
                    aria-label={`${label} executable override`}
                  />
                ) : (
                  <details>
                    <summary className="cursor-pointer list-none text-xs text-muted-foreground hover:text-foreground">
                      Executable override…
                    </summary>
                    <Input
                      id={inputId}
                      nativeInput
                      value={configuration.executableOverride}
                      onChange={(event) =>
                        setDraft((current) =>
                          updateWorkjetComputerHarness(current, configuration.harness, {
                            executableOverride: event.target.value,
                          }),
                        )
                      }
                      placeholder="Optional executable override"
                      aria-label={`${label} executable override`}
                    />
                  </details>
                )}
                <Switch
                  checked={configuration.available}
                  onCheckedChange={(available) =>
                    setDraft((current) =>
                      updateWorkjetComputerHarness(current, configuration.harness, {
                        available: Boolean(available),
                      }),
                    )
                  }
                  aria-label={`${label} available`}
                />
                <HarnessAvailabilityNote
                  compact={compact}
                  view={resolveHarnessAvailabilityView({
                    declaredAvailable: configuration.available,
                    harness: configuration.harness,
                    snapshot: availability,
                  })}
                />
              </div>
            );
          })}
        </div>

        {environments.length === 0 ? (
          <p role="status" className="text-xs text-muted-foreground">
            Waiting for the environment catalog. Pair new remote environments in the section below.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm">
            {saving ? "Saving…" : "Save computer"}
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
