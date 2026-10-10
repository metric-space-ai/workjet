import { CircleDashedIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkjetNativeProviderRegistry } from "@workjet/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useInstanceProviders } from "./useInstanceProviders";
const columns =
  "grid grid-cols-[minmax(9rem,1.15fr)_minmax(0,2fr)_minmax(6rem,.7fr)_2rem_1.75rem] items-center gap-x-3";

function ProviderModels({
  provider,
  registry,
  busy,
  select,
}: {
  readonly provider: string;
  readonly registry: WorkjetNativeProviderRegistry;
  readonly busy: boolean;
  readonly select: (models: readonly string[]) => void;
}) {
  const selected = registry.providers.find((entry) => entry.provider === provider)?.selection ?? [];
  const saved = selected.join(", ");
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const live = [
    ...new Set(
      registry.accounts
        .filter(
          (account) =>
            account.provider === provider &&
            account.enabled &&
            account.credentialReady &&
            account.modelCatalog.fresh,
        )
        .flatMap((account) => account.modelCatalog.models),
    ),
  ];
  const listId = "ctox-provider-models-" + provider;
  return (
    <div className="min-w-0" role="cell">
      <Input
        nativeInput
        aria-label={`Models for ${provider} on CTOX`}
        className="h-7 text-xs"
        value={draft}
        disabled={busy}
        list={listId}
        placeholder="Choose from the live account list"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== saved) select([...new Set(draft.split(/[\s,;]+/).filter(Boolean))]);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      <datalist id={listId}>
        {live.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>
    </div>
  );
}
/** Public instance metadata. Catalog circles deliberately do not attest inference. */
export function NativeProviderRows({
  instanceId,
  label,
}: {
  readonly instanceId: string;
  readonly label: string;
}) {
  const state = useInstanceProviders(instanceId);
  const registry = state.registry;
  const accounts = registry?.accounts.filter((account) => account.provider === "claude") ?? [];
  const refresh = async () => {
    const current = await state.refresh();
    for (const account of current?.accounts ?? []) {
      if (account.provider === "claude" && account.enabled && account.credentialReady)
        await state.run({
          action: "instance.providers.observe",
          accountId: account.id,
          expectedAccountRevision: account.revision,
        });
    }
  };
  return (
    <div
      role="rowgroup"
      aria-label={`CTOX provider accounts on ${label}`}
      className="border-b border-border/50"
    >
      <div role="row" className={columns + " min-h-9 py-1.5"}>
        <div role="cell" className="text-xs font-medium">
          Claude · {label}
        </div>
        <div role="cell" className="text-xs text-muted-foreground">
          {accounts.length} instance accounts
        </div>
        <div role="cell" />
        <div role="cell" />
        <div role="cell">
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={state.busy}
            aria-label={`Refresh CTOX accounts on ${label}`}
            onClick={() => {
              void refresh();
            }}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
        </div>
      </div>
      {state.error && (
        <p role="alert" className="py-1 text-xs text-destructive">
          {state.error}
        </p>
      )}
      {registry && accounts.length > 0 && (
        <div role="row" className={columns + " py-1"}>
          <div role="cell" className="text-xs text-muted-foreground">
            Shared models
          </div>
          <ProviderModels
            provider="claude"
            registry={registry}
            busy={state.busy}
            select={(models) => {
              void state.run({
                action: "instance.providers.models.select",
                provider: "claude",
                models,
                expectedRevision: registry.revision,
              });
            }}
          />
          <div role="cell" />
          <div role="cell" />
          <div role="cell" />
        </div>
      )}
      {accounts.map((account) => {
        const selected =
          registry?.providers.find((entry) => entry.provider === account.provider)?.selection ?? [];
        const attempt = account.modelCatalog.lastAttempt;
        return (
          <div key={account.id} role="row" className={columns + " min-h-12 py-1.5"}>
            <div role="cell" className="min-w-0 text-xs" title={account.id}>
              <span>Account {account.id.slice(0, 8)}</span>
              <p className="text-[11px] text-muted-foreground">OAuth · {label}</p>
            </div>
            <div role="cell" className="flex min-w-0 flex-wrap gap-1">
              {selected.map((model) => (
                <label
                  key={model}
                  className="inline-flex max-w-full items-center gap-1 rounded border border-border/60 px-1.5 py-1 text-xs"
                  title="Live catalog metadata; inference has not been checked on this instance."
                >
                  <input
                    type="checkbox"
                    aria-label={`Use ${model} for instance account ${account.id}`}
                    checked={!account.excludedModels.includes(model)}
                    disabled={state.busy || !account.modelCatalog.models.includes(model)}
                    onChange={(event) => {
                      void state.run({
                        action: "instance.providers.models.exclude",
                        accountId: account.id,
                        expectedAccountRevision: account.revision,
                        expectedRevision: registry!.revision,
                        models: event.target.checked
                          ? account.excludedModels.filter((id) => id !== model)
                          : [...account.excludedModels, model],
                      });
                    }}
                  />
                  <span className="break-all whitespace-normal">{model}</span>
                  <CircleDashedIcon
                    aria-label="Inference not checked"
                    className="size-3 shrink-0 text-muted-foreground"
                  />
                </label>
              ))}
              {selected.length === 0 && (
                <span className="text-xs text-muted-foreground">Choose shared models above</span>
              )}
              {attempt?.success === false && (
                <span className="w-full text-[11px] text-destructive">
                  Live catalog: {attempt.failure ?? "unavailable"}
                  {attempt.httpStatus ? ` · HTTP ${attempt.httpStatus}` : ""}
                </span>
              )}
            </div>
            <div
              role="cell"
              title="This instance account has not reported limits."
              className="text-xs text-muted-foreground"
            >
              —
            </div>
            <div
              role="cell"
              className="text-[11px]"
              title={account.enabled ? "Enabled on CTOX" : "Disabled on CTOX"}
            >
              {account.enabled ? "On" : "Off"}
            </div>
            <div role="cell">
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={state.busy || !account.enabled}
                aria-label={`Refresh live models for instance account ${account.id}`}
                onClick={() => {
                  void state.run({
                    action: "instance.providers.observe",
                    accountId: account.id,
                    expectedAccountRevision: account.revision,
                  });
                }}
              >
                <RefreshCwIcon className="size-3.5" />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
