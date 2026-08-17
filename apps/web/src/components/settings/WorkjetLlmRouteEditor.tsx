import {
  ProviderInstanceId,
  WorkjetLlmRouteId,
  type ProviderInstanceConfig,
  type WorkjetLlmRoute,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export interface WorkjetLlmRouteDraft {
  readonly id: string;
  readonly label: string;
  readonly providerInstanceId: string;
}

export function createWorkjetLlmRouteDraft(input: {
  readonly route?: WorkjetLlmRoute | null;
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly id?: string;
}): WorkjetLlmRouteDraft {
  return {
    id: input.route?.id ?? input.id ?? randomUUID(),
    label: input.route?.label ?? "",
    providerInstanceId:
      input.route?.providerInstanceId ?? Object.keys(input.providerInstances)[0] ?? "",
  };
}

export function saveWorkjetLlmRouteDraft(draft: WorkjetLlmRouteDraft): WorkjetLlmRoute {
  const label = draft.label.trim();
  if (!label) throw new Error("Enter an LLM route label.");
  if (!draft.providerInstanceId) throw new Error("Choose a provider instance.");
  return {
    id: WorkjetLlmRouteId.make(draft.id),
    label,
    providerInstanceId: ProviderInstanceId.make(draft.providerInstanceId),
  };
}

export function WorkjetLlmRouteEditor({
  route = null,
  providerInstances,
  onSave,
  onCancel,
}: {
  readonly route?: WorkjetLlmRoute | null;
  readonly providerInstances: Readonly<Record<string, ProviderInstanceConfig>>;
  readonly onSave: (route: WorkjetLlmRoute) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() =>
    createWorkjetLlmRouteDraft({ route, providerInstances }),
  );
  const [error, setError] = useState<string | null>(null);
  const entries = useMemo(
    () =>
      Object.entries(providerInstances).sort((left, right) =>
        (left[1].displayName ?? left[0]).localeCompare(right[1].displayName ?? right[0]),
      ),
    [providerInstances],
  );
  const selected = providerInstances[draft.providerInstanceId];

  return (
    <form
      className="space-y-4 rounded-xl border border-border/60 bg-muted/15 p-3 sm:p-4"
      aria-label={route ? `Edit LLM route ${route.label}` : "Add LLM route"}
      onSubmit={(event) => {
        event.preventDefault();
        try {
          onSave(saveWorkjetLlmRouteDraft(draft));
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "The LLM route could not be saved.");
        }
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="workjet-route-label">Route label</Label>
          <Input
            id="workjet-route-label"
            nativeInput
            value={draft.label}
            onChange={(event) => {
              setDraft((current) => ({ ...current, label: event.target.value }));
              setError(null);
            }}
            placeholder="Codex work account"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="workjet-route-provider">Provider instance</Label>
          <Select
            value={draft.providerInstanceId || null}
            onValueChange={(value) => {
              setDraft((current) => ({ ...current, providerInstanceId: value ?? "" }));
              setError(null);
            }}
          >
            <SelectTrigger id="workjet-route-provider" aria-label="LLM route provider instance">
              <SelectValue>
                {selected?.displayName ?? draft.providerInstanceId ?? "Choose provider instance"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {entries.map(([id, instance]) => (
                <SelectItem key={id} value={id}>
                  {instance.displayName ?? id} · {instance.driver}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Routes store only a reference to an existing provider instance. Models stay on workers, and
        provider credentials stay protected by the provider-gateway account authority.
      </p>
      {entries.length === 0 ? (
        <p role="status" className="text-xs text-muted-foreground">
          No Workjet provider-gateway accounts are available on this server. The Code provider list
          contains harness runtimes and is intentionally not used here.
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
        <Button type="submit" size="sm" disabled={entries.length === 0}>
          Save route
        </Button>
      </div>
    </form>
  );
}
