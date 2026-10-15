import { CheckIcon, XIcon, CircleDashedIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { Switch } from "../ui/switch";
import { Checkbox } from "../ui/checkbox";
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
        aria-label={`Modelle für ${provider}`}
        className="h-7 text-xs"
        value={draft}
        disabled={busy}
        list={listId}
        placeholder="Modelle wählen …"
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
    ? "Prüfung nicht verfügbar"
    : probe
      ? (probe.status === "ok"
          ? "Prüfung bestanden"
          : (probe.failure?.replaceAll("_", " ") ?? "Prüfung nicht verfügbar")) +
        " · " +
        probe.elapsedMs +
        " ms · " +
        new Date(probe.checkedAtMs).toLocaleString("de-DE") +
        (probe.httpStatus === null ? "" : " · HTTP " + probe.httpStatus) +
        (probe.retryAtMs === null
          ? ""
          : " · Neuversuch ab " + new Date(probe.retryAtMs).toLocaleString("de-DE"))
      : "Nicht geprüft";
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      aria-label={`${model} prüfen`}
      onClick={check}
      className="inline-flex shrink-0 items-center p-0.5 disabled:opacity-50"
    >
      {probe?.status === "ok" ? (
        <CheckIcon aria-label="Prüfung bestanden" className="size-3 text-emerald-500" />
      ) : probe?.status === "failed" ? (
        <XIcon
          aria-label={`Prüfung fehlgeschlagen: ${probe.failure}`}
          className="size-3 text-destructive"
        />
      ) : (
        <CircleDashedIcon
          aria-label={probe ? `Prüfung nicht verfügbar: ${probe.failure}` : "Nicht geprüft"}
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
  ordinal,
}: {
  readonly account: WorkjetNativeProviderAccount;
  readonly registry: WorkjetNativeProviderRegistry;
  readonly label: string;
  readonly busy: boolean;
  readonly run: ReturnType<typeof useInstanceProviders>["run"];
  readonly check: ReturnType<typeof useInstanceProviders>["check"];
  readonly error: string | undefined;
  /** 1-based position in the provider group; shown instead of the raw account id. */
  readonly ordinal: number;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const accountName = `Konto ${ordinal}`;
  useEffect(() => setConfirmRemove(false), [account.revision]);
  const selected =
    registry.providers.find((entry) => entry.provider === account.provider)?.selection ?? [];
  const attempt = account.modelCatalog.lastAttempt;
  const canEnable = account.controls?.canEnable === true;
  const canRemove = account.controls?.canRemove === true;
  return (
    <>
      <div role="row" className={columns + " min-h-12 py-1.5"}>
        <div role="cell" className="order-1 min-w-0 text-xs">
          <span>{accountName}</span>
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
                <Checkbox
                  aria-label={`${model} für ${accountName}`}
                  checked={!account.excludedModels.includes(model)}
                  disabled={busy || !account.modelCatalog.models.includes(model)}
                  onCheckedChange={(checked) => {
                    void run({
                      action: "instance.providers.models.exclude",
                      accountId: account.id,
                      expectedAccountRevision: account.revision,
                      expectedRevision: registry.revision,
                      models: checked
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
          {selected.length === 0 && <span className="text-xs text-muted-foreground">—</span>}
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
                  ? " · Konto neu verbinden"
                  : probe.failure === "model_not_found"
                    ? " · Modellliste neu laden"
                    : probe.failure === "gateway_cooldown" && probe.retryAtMs !== null
                      ? " · Neuversuch ab " + new Date(probe.retryAtMs).toLocaleString("de-DE")
                      : probe.source === "gateway"
                        ? " · Verbindung prüfen"
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
              Modellliste: {attempt.failure ?? "nicht verfügbar"}
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
            <Switch
              aria-label={`${accountName} aktiv`}
              data-workjet-action={`models.instance.account.${account.id}.enabled`}
              checked={account.enabled}
              disabled={busy || confirmRemove}
              onCheckedChange={(checked) => {
                void run({
                  action: "instance.providers.account.enable",
                  accountId: account.id,
                  expectedAccountRevision: account.revision,
                  expectedRevision: registry.revision,
                  enabled: checked,
                });
              }}
            />
          ) : (
            <span
              className="text-[11px]"
              title={account.controls ? "Nicht änderbar" : "CTOX aktualisieren"}
            >
              {account.enabled ? "An" : "Aus"}
            </span>
          )}
        </div>
        <div role="cell" className="order-3 flex items-center gap-1 sm:order-5">
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={busy || !account.enabled}
            aria-label={`Modelle von ${accountName} neu laden`}
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
            aria-label={`${accountName} entfernen`}
            title={
              canRemove
                ? "Konto entfernen"
                : account.controls
                  ? "Entfernen nicht möglich"
                  : "CTOX aktualisieren"
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
            {accountName} endgültig entfernen?
          </span>
          <div role="cell" className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmRemove(false)}
            >
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              aria-label={`Entfernen von ${accountName} bestätigen`}
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
              Entfernen
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
    <div role="rowgroup" aria-label={`Konten auf ${label}`}>
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
    : provider || "CTOX-Konten";
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
      aria-label={`${providerLabel}-Konten auf ${label}`}
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
          <span>{registry ? `${accounts.length} Konten` : "Konten nicht geladen"}</span>
          <Button
            size="xs"
            variant="outline"
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
            {checkingAll ? "Prüft …" : "Alle prüfen"}
          </Button>
        </div>
        <div role="cell" className="hidden sm:block" />
        <div role="cell" className="hidden sm:block" />
        <div role="cell" className="col-start-3 row-start-1 sm:col-start-auto sm:row-start-auto">
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={state.busy}
            aria-label={`Konten auf ${label} neu laden`}
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
            Gemeinsame Modelle
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
        accounts.map((account, index) => (
          <NativeAccountRow
            key={account.id}
            ordinal={index + 1}
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
