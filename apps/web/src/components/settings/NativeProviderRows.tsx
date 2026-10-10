import { CircleDashedIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  WorkjetNativeProviderAccount,
  WorkjetNativeProviderRegistry,
} from "@workjet/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useInstanceProviders } from "./useInstanceProviders";
const columns =
  "grid grid-cols-[minmax(9rem,1.15fr)_minmax(0,2fr)_minmax(6rem,.7fr)_2rem_4rem] items-center gap-x-3";

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

function NativeAccountRow({
  account,
  registry,
  label,
  busy,
  run,
  error,
}: {
  readonly account: WorkjetNativeProviderAccount;
  readonly registry: WorkjetNativeProviderRegistry;
  readonly label: string;
  readonly busy: boolean;
  readonly run: ReturnType<typeof useInstanceProviders>["run"];
  readonly error: string | undefined;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => setConfirmRemove(false), [account.revision]);
  const selected =
    registry.providers.find((entry) => entry.provider === account.provider)?.selection ?? [];
  const attempt = account.modelCatalog.lastAttempt;
  const canEnable = account.controls?.canEnable === true;
  const canRemove = account.controls?.canRemove === true;
  return (
    <>
      <div role="row" className={columns + " min-h-12 py-1.5"}>
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
                disabled={busy || !account.modelCatalog.models.includes(model)}
                onChange={(event) => {
                  void run({
                    action: "instance.providers.models.exclude",
                    accountId: account.id,
                    expectedAccountRevision: account.revision,
                    expectedRevision: registry.revision,
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
          {error && (
            <span role="alert" className="w-full text-xs text-destructive">
              {error}
            </span>
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
        <div role="cell" className="flex justify-center">
          {canEnable ? (
            <label
              className="relative inline-flex cursor-pointer items-center"
              title={account.enabled ? "Disable this CTOX account" : "Enable this CTOX account"}
            >
              <input
                type="checkbox"
                role="switch"
                aria-label={`Use instance account ${account.id}`}
                data-workjet-action={`models.instance.account.${account.id}.enabled`}
                checked={account.enabled}
                disabled={busy || confirmRemove}
                onChange={(event) => {
                  void run({
                    action: "instance.providers.account.enable",
                    accountId: account.id,
                    expectedAccountRevision: account.revision,
                    expectedRevision: registry.revision,
                    enabled: event.target.checked,
                  });
                }}
                className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
              />
              <span
                aria-hidden
                className="h-4 w-7 rounded-full bg-muted transition-colors peer-checked:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring peer-disabled:opacity-50"
              >
                <span
                  className={
                    "m-0.5 block size-3 rounded-full bg-background transition-transform" +
                    (account.enabled ? " translate-x-3" : "")
                  }
                />
              </span>
            </label>
          ) : (
            <span className="text-[11px]" title="Update CTOX to manage this account here.">
              {account.enabled ? "On" : "Off"}
            </span>
          )}
        </div>
        <div role="cell" className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={busy || !account.enabled}
            aria-label={`Refresh live models for instance account ${account.id}`}
            onClick={() => {
              void run({
                action: "instance.providers.observe",
                accountId: account.id,
                expectedAccountRevision: account.revision,
              });
            }}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={busy || !canRemove}
            aria-label={`Permanently remove instance account ${account.id}`}
            title={
              canRemove
                ? "Remove this account and its credentials"
                : "Update CTOX to remove this account here."
            }
            data-workjet-action={`models.instance.account.${account.id}.remove-start`}
            onClick={() => setConfirmRemove(true)}
          >
            <Trash2Icon className="size-3.5 text-muted-foreground" />
          </Button>
        </div>
      </div>
      {confirmRemove && canRemove && (
        <div role="row" className="flex flex-wrap items-center gap-2 py-1.5 text-xs">
          <span role="cell" className="min-w-0 flex-1">
            Remove account {account.id.slice(0, 8)}, its credentials and account model settings
            permanently?
          </span>
          <div role="cell" className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmRemove(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              aria-label={`Confirm permanent removal of instance account ${account.id}`}
              data-workjet-action={`models.instance.account.${account.id}.remove-confirm`}
              onClick={async () => {
                const result = await run({
                  action: "instance.providers.account.remove",
                  accountId: account.id,
                  expectedAccountRevision: account.revision,
                  expectedRevision: registry.revision,
                });
                if (result) setConfirmRemove(false);
              }}
            >
              Remove account
            </Button>
          </div>
        </div>
      )}
    </>
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
          {registry ? `${accounts.length} instance accounts` : "Accounts not loaded"}
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
      {state.error && !state.errorAccountId && (
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
      {registry &&
        accounts.map((account) => (
          <NativeAccountRow
            key={account.id}
            account={account}
            registry={registry}
            label={label}
            busy={state.busy}
            run={state.run}
            error={state.errorAccountId === account.id ? state.error : undefined}
          />
        ))}
    </div>
  );
}
