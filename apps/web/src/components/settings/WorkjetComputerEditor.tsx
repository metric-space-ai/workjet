import {
  EnvironmentId,
  WorkjetComputerId,
  type WorkjetComputer,
  type WorkjetComputerPresentationKind,
  type WorkjetHarness,
  type WorkjetHarnessAvailabilitySnapshot,
  type WorkjetHarnessConfiguration,
} from "@workjet/contracts";
import { InlineSaveFooter } from "../ui/inline-panel";
import { useEffect, useRef, useState } from "react";

import { randomUUID } from "../../lib/utils";
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
  /** The machine this connection reaches, when the server reports one. */
  readonly hostId?: string;
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
  if (!label) throw new Error("Bezeichnung fehlt.");
  if (!draft.environmentId) throw new Error("Verbindung fehlt.");
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
  if (!environment && !computer) throw new Error("Kein verbundener Rechner.");
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
  { id: "local", label: "Lokal" },
  { id: "workjet-connect", label: "Relay-Verbindung" },
  { id: "ssh", label: "SSH" },
  { id: "tailscale", label: "Tailscale" },
  { id: "remote", label: "Fernzugriff" },
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
    <span
      className={cn(
        "text-xs",
        !compact && "sm:col-span-3",
        isProblem ? "text-destructive" : "text-muted-foreground",
      )}
      data-workjet-harness-availability={view.kind}
      role={isProblem ? "alert" : undefined}
      {...(isProblem ? { title: view.reason } : {})}
    >
      {isProblem
        ? "Nicht lauffähig"
        : `Installiert${view.version === undefined ? "" : ` · ${view.version}`}`}
    </span>
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
      aria-label={computer ? `Rechner ${computer.label} bearbeiten` : "Rechner hinzufügen"}
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
          setError(cause instanceof Error ? cause.message : "Rechner nicht gespeichert.");
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
              <Label htmlFor="workjet-computer-environment">Rechner</Label>
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
                <SelectTrigger id="workjet-computer-environment" aria-label="Rechner">
                  <SelectValue>{selectedEnvironment?.label ?? "Rechner wählen"}</SelectValue>
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
            <Label htmlFor="workjet-computer-label">Bezeichnung</Label>
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
            <Label htmlFor="workjet-computer-kind">Verbindung</Label>
            <p id="workjet-computer-kind" className="text-sm text-muted-foreground">
              {PRESENTATION_OPTIONS.find(
                (option) =>
                  option.id ===
                  (computer?.presentationKind ?? selectedEnvironment?.presentationKind),
              )?.label ?? "—"}
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <div>
            <h3 className="text-sm font-medium">Werkzeuge</h3>
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
                {/* Den Programmpfad erkennt der Rechner selbst (Erkennen statt
                  fragen). Nur ein schon gesetzter Pfad bleibt sichtbar, damit er
                  geleert werden kann; kein „Erweitert“-Aufklapper. */}
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
                    placeholder="Programmpfad"
                    aria-label={`${label}: Programmpfad`}
                  />
                ) : (
                  <span aria-hidden="true" />
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
                  aria-label={`${label} verfügbar`}
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
            Rechnerliste wird geladen …
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <InlineSaveFooter saving={saving} onCancel={onCancel} />
      </fieldset>
    </form>
  );
}
