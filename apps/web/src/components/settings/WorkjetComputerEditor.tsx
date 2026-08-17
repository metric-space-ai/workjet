import {
  EnvironmentId,
  WorkjetComputerId,
  type WorkjetComputer,
  type WorkjetComputerPresentationKind,
  type WorkjetHarness,
  type WorkjetHarnessConfiguration,
} from "@t3tools/contracts";
import { useState } from "react";

import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { WORKJET_HARNESS_OPTIONS } from "./WorkjetWorkerEditor";

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
  return {
    ...draft,
    environmentId: environment.environmentId,
    label: environment.label,
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
  if (!draft.environmentId) throw new Error("Choose an existing environment.");
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

const PRESENTATION_OPTIONS: ReadonlyArray<{
  readonly id: WorkjetComputerPresentationKind;
  readonly label: string;
}> = [
  { id: "local", label: "Local" },
  { id: "t3-connect", label: "Relay connection" },
  { id: "ssh", label: "SSH" },
  { id: "tailscale", label: "Tailscale" },
  { id: "remote", label: "Remote" },
];

export function WorkjetComputerEditor({
  computer = null,
  environments,
  onSave,
  onCancel,
}: {
  readonly computer?: WorkjetComputer | null;
  readonly environments: ReadonlyArray<WorkjetEnvironmentTargetOption>;
  readonly onSave: (computer: WorkjetComputer) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => createWorkjetComputerDraft({ computer, environments }));
  const [error, setError] = useState<string | null>(null);
  const selectedEnvironment = environments.find(
    (environment) => environment.environmentId === draft.environmentId,
  );

  return (
    <form
      className="space-y-4 rounded-xl border border-border/60 bg-muted/15 p-3 sm:p-4"
      aria-label={computer ? `Edit computer ${computer.label}` : "Add computer"}
      onSubmit={(event) => {
        event.preventDefault();
        try {
          onSave(saveWorkjetComputerDraft(draft));
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "The computer could not be saved.");
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="workjet-computer-environment">Environment</Label>
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
            <SelectTrigger id="workjet-computer-environment" aria-label="Computer environment">
              <SelectValue>{selectedEnvironment?.label ?? "Choose environment"}</SelectValue>
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
        <div className="space-y-1.5">
          <Label htmlFor="workjet-computer-label">Label</Label>
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
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="workjet-computer-kind">Presentation</Label>
          <Select
            value={draft.presentationKind}
            onValueChange={(value) =>
              setDraft((current) => ({
                ...current,
                presentationKind: value as WorkjetComputerPresentationKind,
              }))
            }
          >
            <SelectTrigger id="workjet-computer-kind" aria-label="Computer presentation">
              <SelectValue>
                {PRESENTATION_OPTIONS.find((option) => option.id === draft.presentationKind)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {PRESENTATION_OPTIONS.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>

      <div className="space-y-2">
        <div>
          <h3 className="text-sm font-medium">Harness availability</h3>
          <p className="text-xs text-muted-foreground">
            Declare what is available on this existing environment. Workjet does not store SSH
            credentials or create a second connection profile.
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
              className="grid gap-2 rounded-lg border border-border/50 p-2.5 sm:grid-cols-[minmax(8rem,1fr)_minmax(12rem,1.5fr)_auto] sm:items-center"
            >
              <Label htmlFor={inputId}>{label}</Label>
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
            </div>
          );
        })}
      </div>

      {environments.length === 0 ? (
        <p role="status" className="text-xs text-muted-foreground">
          Waiting for the environment catalog. Add connections in Connections settings.
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
          Save computer
        </Button>
      </div>
    </form>
  );
}
