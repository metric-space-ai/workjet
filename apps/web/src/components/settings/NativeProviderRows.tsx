import { CheckIcon, XIcon, CircleDashedIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  WorkjetNativeProviderAccount,
  WorkjetNativeModelProbe,
  WorkjetNativeProviderRegistry,
} from "@workjet/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useInstanceProviders } from "./useInstanceProviders";
import { NativeProviderLimits } from "./NativeProviderLimits";

import {
  WORKJET_GATEWAY_PROVIDERS,
  WORKJET_GATEWAY_PROVIDER_ICONS,
  WORKJET_GATEWAY_PROVIDER_LABELS,
} from "./WorkjetGatewayAccounts";
const columns =
  "grid grid-cols-[minmax(0,1fr)_2rem_4rem] items-center gap-x-3 sm:grid-cols-[minmax(9rem,1.15fr)_minmax(0,2fr)_minmax(6rem,.7fr)_2rem_4rem]";

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
    <div className="col-span-full min-w-0 sm:col-span-1" role="cell">
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

function ModelCheckStatus({
  probe,
  model,
  supported,
  disabled,
  check,
}: {
  readonly probe: WorkjetNativeModelProbe | undefined;
  readonly model: string;
  readonly supported: boolean;
  readonly disabled: boolean;
  readonly check: () => void;
}) {
  const title = !supported
    ? "Hi checks are not yet available for this provider on this CTOX instance."
    : probe
      ? (probe.status === "ok"
          ? "Hi check passed"
          : (probe.failure?.replaceAll("_", " ") ?? "Check unavailable")) +
        " · " +
        probe.elapsedMs +
        " ms · " +
        new Date(probe.checkedAtMs).toLocaleString() +
        (probe.httpStatus === null ? "" : " · HTTP " + probe.httpStatus) +
        (probe.retryAtMs === null
          ? ""
          : " · Gateway retry after " + new Date(probe.retryAtMs).toLocaleString())
      : "Inference not checked. Check this model.";
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      aria-label={`Check ${model}`}
      onClick={check}
      className="inline-flex shrink-0 items-center p-0.5 disabled:opacity-50"
    >
      {probe?.status === "ok" ? (
        <CheckIcon aria-label="Model check passed" className="size-3 text-emerald-500" />
      ) : probe?.status === "failed" ? (
        <XIcon
          aria-label={`Model check failed: ${probe.failure}`}
          className="size-3 text-destructive"
        />
      ) : (
        <CircleDashedIcon
          aria-label={probe ? `Model check unavailable: ${probe.failure}` : "Inference not checked"}
          className="size-3 text-muted-foreground"
        />
      )}
    </button>
  );
}

function NativeAccountRow({
  account,
  registry,
  label,
  busy,
  run,
  check,
  error,
}: {
  readonly account: WorkjetNativeProviderAccount;
  readonly registry: WorkjetNativeProviderRegistry;
  readonly label: string;
  readonly busy: boolean;
  readonly run: ReturnType<typeof useInstanceProviders>["run"];
  readonly check: ReturnType<typeof useInstanceProviders>["check"];
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
        <div role="cell" className="order-1 min-w-0 text-xs" title={account.id}>
          <span>Account {account.id.slice(0, 8)}</span>
          <p className="text-[11px] text-muted-foreground">CTOX · {label}</p>
        </div>
        <div
          role="cell"
          className="order-5 col-span-full flex min-w-0 flex-wrap gap-1 sm:order-2 sm:col-span-1"
        >
          {selected.map((model) => (
            <div
              key={model}
              className="inline-flex max-w-full items-center gap-1 rounded border border-border/60 px-1.5 py-1 text-xs"
            >
              <label className="inline-flex min-w-0 items-center gap-1">
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
              </label>
              <ModelCheckStatus
                model={model}
                probe={account.modelChecks?.find((probe) => probe.modelId === model)}
                supported={account.provider === "claude"}
                disabled={
                  account.provider !== "claude" ||
                  busy ||
                  !account.enabled ||
                  !account.credentialReady ||
                  !account.modelCatalog.fresh ||
                  !account.effectiveModels.includes(model)
                }
                check={() => {
                  void check(account.id, account.revision, model);
                }}
              />
            </div>
          ))}
          {selected.length === 0 && (
            <span className="text-xs text-muted-foreground">Choose shared models above</span>
          )}
          {account.modelChecks
            ?.filter((probe) => probe.status !== "ok" && selected.includes(probe.modelId))
            .map((probe) => (
              <span
                key={probe.modelId}
                className={
                  "w-full text-[11px] " +
                  (probe.status === "failed" ? "text-destructive" : "text-muted-foreground")
                }
              >
                {probe.modelId}: {probe.failure?.replaceAll("_", " ")}
                {probe.failure === "auth"
                  ? ". Reconnect this account on its CTOX instance, then check again."
                  : probe.failure === "model_not_found"
                    ? ". Refresh the live model list and choose a listed model."
                    : probe.failure === "gateway_cooldown" && probe.retryAtMs !== null
                      ? ". Gateway retry after " + new Date(probe.retryAtMs).toLocaleString()
                      : probe.source === "gateway"
                        ? ". Check the instance connection and try again."
                        : ""}
              </span>
            ))}
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
        <NativeProviderLimits
          provider={account.provider}
          quota={account.reportedQuota}
          className="order-4 col-span-full py-1 sm:order-3 sm:col-span-1 sm:py-0"
        />
        <div role="cell" className="order-2 flex justify-center sm:order-4">
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
            <span
              className="text-[11px]"
              title={
                account.controls
                  ? "Activation changes are not available for this account."
                  : "Update CTOX to manage this account here."
              }
            >
              {account.enabled ? "On" : "Off"}
            </span>
          )}
        </div>
        <div role="cell" className="order-3 flex items-center gap-1 sm:order-5">
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
                : account.controls
                  ? "Removal is not available for this account."
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
  return <NativeProviderRowsView state={state} label={label} />;
}

export function NativeProviderRowsView({
  state,
  label,
}: {
  readonly state: ReturnType<typeof useInstanceProviders>;
  readonly label: string;
}) {
  if (state.connectionFailure) return null;
  const providers = [...new Set(state.registry?.accounts.map((account) => account.provider) ?? [])];
  return (
    <div role="rowgroup" aria-label={`CTOX provider accounts on ${label}`}>
      {state.error && !state.errorAccountId && (
        <p role="alert" className="py-1 text-xs text-destructive">
          {state.error}
        </p>
      )}
      {(providers.length > 0 ? providers : [""]).map((provider) => (
        <NativeProviderGroup key={provider} provider={provider} state={state} label={label} />
      ))}
    </div>
  );
}

function NativeProviderGroup({
  state,
  label,
  provider,
}: {
  readonly state: ReturnType<typeof useInstanceProviders>;
  readonly label: string;
  readonly provider: string;
}) {
  const [checkingAll, setCheckingAll] = useState(false);
  const registry = state.registry;
  const accounts = registry?.accounts.filter((account) => account.provider === provider) ?? [];
  const knownProvider = WORKJET_GATEWAY_PROVIDERS.find((entry) => entry === provider);
  const ProviderIcon = knownProvider ? WORKJET_GATEWAY_PROVIDER_ICONS[knownProvider] : undefined;
  const providerLabel = knownProvider
    ? WORKJET_GATEWAY_PROVIDER_LABELS[knownProvider]
    : provider || "CTOX accounts";
  const checksSupported = provider === "claude";
  const checkAll = async () => {
    if (!checksSupported) return;
    setCheckingAll(true);
    try {
      for (const account of accounts) {
        if (!account.enabled || !account.credentialReady || !account.modelCatalog.fresh) continue;
        for (const model of account.effectiveModels) {
          const result = await state.check(account.id, account.revision, model);
          if (!result) return;
        }
      }
    } finally {
      setCheckingAll(false);
    }
  };
  const refresh = async () => {
    const current = await state.refresh();
    for (const account of current?.accounts ?? []) {
      if (account.provider === provider && account.enabled && account.credentialReady)
        await state.run({
          action: "instance.providers.observe",
          accountId: account.id,
          expectedAccountRevision: account.revision,
        });
    }
  };
  if (state.connectionFailure) return null;
  return (
    <div
      role="rowgroup"
      aria-label={`${providerLabel} accounts on ${label}`}
      className="border-b border-border/50"
    >
      <div role="row" className={columns + " min-h-9 py-1.5"}>
        <div
          role="cell"
          className="col-span-2 flex items-center gap-1.5 text-xs font-medium sm:col-span-1"
        >
          {ProviderIcon && <ProviderIcon className="size-4 shrink-0" />}
          {providerLabel} · {label}
        </div>
        <div
          role="cell"
          className="order-last col-span-full flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground sm:order-none sm:col-span-1"
        >
          <span>{registry ? `${accounts.length} instance accounts` : "Accounts not loaded"}</span>
          <Button
            size="xs"
            variant="ghost"
            disabled={
              !checksSupported ||
              state.busy ||
              checkingAll ||
              !accounts.some(
                (account) =>
                  account.enabled &&
                  account.credentialReady &&
                  account.modelCatalog.fresh &&
                  account.effectiveModels.length > 0,
              )
            }
            onClick={() => {
              void checkAll();
            }}
          >
            {checkingAll ? "Checking…" : "Check all"}
          </Button>
        </div>
        <div role="cell" className="hidden sm:block" />
        <div role="cell" className="hidden sm:block" />
        <div role="cell" className="col-start-3 row-start-1 sm:col-start-auto sm:row-start-auto">
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

      {registry && accounts.length > 0 && (
        <div role="row" className={columns + " py-1"}>
          <div role="cell" className="col-span-full text-xs text-muted-foreground sm:col-span-1">
            Shared models
          </div>
          <ProviderModels
            provider={provider}
            registry={registry}
            busy={state.busy}
            select={(models) => {
              void (async () => {
                const current = await state.run({
                  action: "instance.providers.models.select",
                  provider,
                  models,
                  expectedRevision: registry.revision,
                });
                const previous =
                  registry.providers.find((entry) => entry.provider === provider)?.selection ?? [];
                if (!checksSupported) return;
                for (const account of current?.accounts ?? []) {
                  if (
                    account.provider !== provider ||
                    !account.enabled ||
                    !account.credentialReady ||
                    !account.modelCatalog.fresh
                  )
                    continue;
                  for (const model of models.filter(
                    (model) => !previous.includes(model) && account.effectiveModels.includes(model),
                  )) {
                    if (!(await state.check(account.id, account.revision, model))) return;
                  }
                }
              })();
            }}
          />
          <div role="cell" className="hidden sm:block" />
          <div role="cell" className="hidden sm:block" />
          <div role="cell" className="hidden sm:block" />
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
            check={state.check}
            error={state.errorAccountId === account.id ? state.error : undefined}
          />
        ))}
    </div>
  );
}
