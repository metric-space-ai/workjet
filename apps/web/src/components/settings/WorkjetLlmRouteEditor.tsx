import {
  WorkjetGatewayAccountId,
  WorkjetLlmRouteId,
  type WorkjetGatewayAccountSummary,
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
  readonly gatewayAccountId: string;
}

export function createWorkjetLlmRouteDraft(input: {
  readonly route?: WorkjetLlmRoute | null;
  readonly accounts: ReadonlyArray<WorkjetGatewayAccountSummary>;
  readonly id?: string;
}): WorkjetLlmRouteDraft {
  return {
    id: input.route?.id ?? input.id ?? randomUUID(),
    label: input.route?.label ?? "",
    gatewayAccountId: input.route?.gatewayAccountId ?? input.accounts[0]?.id ?? "",
  };
}

export function saveWorkjetLlmRouteDraft(draft: WorkjetLlmRouteDraft): WorkjetLlmRoute {
  const label = draft.label.trim();
  if (!label) throw new Error("Enter an LLM route label.");
  if (!draft.gatewayAccountId) throw new Error("Choose a provider-gateway account.");
  return {
    id: WorkjetLlmRouteId.make(draft.id),
    label,
    gatewayAccountId: WorkjetGatewayAccountId.make(draft.gatewayAccountId),
  };
}

export function WorkjetLlmRouteEditor({
  route = null,
  accounts,
  onSave,
  onCancel,
}: {
  readonly route?: WorkjetLlmRoute | null;
  readonly accounts: ReadonlyArray<WorkjetGatewayAccountSummary>;
  readonly onSave: (route: WorkjetLlmRoute) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(() => createWorkjetLlmRouteDraft({ route, accounts }));
  const [error, setError] = useState<string | null>(null);
  const entries = useMemo(
    () => [...accounts].sort((left, right) => left.label.localeCompare(right.label)),
    [accounts],
  );
  const selected = entries.find((account) => account.id === draft.gatewayAccountId);

  return (
    <form
      data-settings-inline-editor=""
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
          <Label htmlFor="workjet-route-provider">Provider-gateway account</Label>
          <Select
            value={draft.gatewayAccountId || null}
            onValueChange={(value) => {
              setDraft((current) => ({ ...current, gatewayAccountId: value ?? "" }));
              setError(null);
            }}
          >
            <SelectTrigger
              id="workjet-route-provider"
              aria-label="LLM route provider-gateway account"
            >
              <SelectValue>
                {/* Never the raw account id: when the referenced account left
                    the catalog, say so instead of printing an opaque hash. */}
                {selected?.label ??
                  (draft.gatewayAccountId
                    ? "Account missing from catalog"
                    : "Choose provider-gateway account")}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {entries.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.label} · {account.provider}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Routes store only a reference to an existing provider-gateway account. Models stay on
        workers, and provider credentials stay protected by the provider-gateway account authority.
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
