import { RefreshCwIcon } from "lucide-react";
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
import { Row, RowStatusDot, type RowStatus } from "../ui/row";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsLoadingRow } from "./settingsAdd";

import {
  WORKJET_GATEWAY_PROVIDERS,
  WORKJET_GATEWAY_PROVIDER_ICONS,
  WORKJET_GATEWAY_PROVIDER_LABELS,
} from "./WorkjetGatewayAccounts";

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
    <div className="min-w-0">
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
          : probe.status === "failed"
            ? "Prüfung fehlgeschlagen"
            : "Prüfung nicht verfügbar") +
        ` · ${probe.elapsedMs} ms · ` +
        new Date(probe.checkedAtMs).toLocaleString("de-DE")
      : "Nicht geprüft";
  // Statuspunkt statt ✓/✗/◌ (Audit C 1).
  return (
    <button
      type="button"
      disabled={disabled}
      title={title}
      aria-label={`${model} prüfen`}
      onClick={check}
      className="inline-flex shrink-0 items-center p-0.5 disabled:opacity-50"
    >
      <RowStatusDot
        status={probe?.status === "ok" ? "ok" : probe?.status === "failed" ? "error" : "off"}
        label={title}
      />
    </button>
  );
}

function probeLine(probe: WorkjetNativeModelProbe): string {
  switch (probe.failure) {
    case "auth":
      return `${probe.modelId}: Anmeldung abgelehnt.`;
    case "model_not_found":
      return `${probe.modelId}: Modell nicht gefunden.`;
    case "gateway_cooldown":
      return probe.retryAtMs === null
        ? `${probe.modelId}: pausiert.`
        : `${probe.modelId}: pausiert bis ${new Date(probe.retryAtMs).toLocaleTimeString("de-DE")}.`;
    default:
      return `${probe.modelId}: Prüfung fehlgeschlagen.`;
  }
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
  const accountName = `Konto ${ordinal}`;
  const selected =
    registry.providers.find((entry) => entry.provider === account.provider)?.selection ?? [];
  const attempt = account.modelCatalog.lastAttempt;
  const canEnable = account.controls?.canEnable === true;
  const canRemove = account.controls?.canRemove === true;
  const knownProvider = WORKJET_GATEWAY_PROVIDERS.find((entry) => entry === account.provider);
  const ProviderIcon = knownProvider ? WORKJET_GATEWAY_PROVIDER_ICONS[knownProvider] : undefined;
  const failedProbes =
    account.modelChecks?.filter(
      (probe) => probe.status !== "ok" && selected.includes(probe.modelId),
    ) ?? [];
  const status: RowStatus = !account.enabled
    ? "off"
    : attempt?.success === false || failedProbes.some((probe) => probe.status === "failed")
      ? "error"
      : account.credentialReady
        ? "ok"
        : "off";
  const hasDetails = [
    selected.length,
    failedProbes.length,
    error ? 1 : 0,
    attempt?.success === false ? 1 : 0,
  ].some(Boolean);
  const observe = () => {
    void run({
      action: "instance.providers.observe",
      accountId: account.id,
      expectedAccountRevision: account.revision,
    });
  };
  return (
    <div
      data-account-id={account.id}
      className={account.enabled ? undefined : "text-muted-foreground"}
    >
      <Row
        className="py-1.5"
        status={status}
        statusLabel={status === "ok" ? "Bereit" : status === "error" ? "Fehler" : "Aus"}
        name={
          <span className="flex min-w-0 items-center gap-2">
            {ProviderIcon ? <ProviderIcon className="size-4 shrink-0" /> : null}
            <span className="truncate">{accountName}</span>
          </span>
        }
        meta={<span className={ProviderIcon ? "pl-6" : undefined}>Instanz {label}</span>}
        chips={
          account.reportedQuota?.state === "reported" ? (
            <NativeProviderLimits provider={account.provider} quota={account.reportedQuota} />
          ) : undefined
        }
        {...(canEnable
          ? {
              active: account.enabled,
              activeLabel: `${accountName} aktiv`,
              activeDisabled: busy,
              onActiveChange: (enabled: boolean) => {
                void run({
                  action: "instance.providers.account.enable",
                  accountId: account.id,
                  expectedAccountRevision: account.revision,
                  expectedRevision: registry.revision,
                  enabled,
                });
              },
            }
          : {})}
        {...(canRemove
          ? {
              onDelete: () => {
                if (busy) return;
                void run({
                  action: "instance.providers.account.remove",
                  accountId: account.id,
                  expectedAccountRevision: account.revision,
                  expectedRevision: registry.revision,
                });
              },
            }
          : {})}
        deleteLabel="Entfernen"
        deleteConfirmTitle={`${accountName} entfernen?`}
        menuActions={account.enabled ? [{ label: "Modelle neu laden", onSelect: observe }] : []}
        menuLabel={`Aktionen für ${accountName}`}
      />
      {hasDetails ? (
        <div className="flex min-w-0 flex-wrap gap-1 px-3 pb-1.5 pl-9">
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
          {failedProbes.map((probe) => (
            <span
              key={probe.modelId}
              className={
                "flex w-full flex-wrap items-center gap-2 text-xs " +
                (probe.status === "failed" ? "text-destructive" : "text-muted-foreground")
              }
            >
              {probeLine(probe)}
              {probe.failure === "model_not_found" && account.enabled ? (
                <Button size="xs" variant="outline" disabled={busy} onClick={observe}>
                  Modellliste neu laden
                </Button>
              ) : null}
            </span>
          ))}
          {error && (
            <span role="alert" className="w-full text-xs text-destructive">
              {error}
            </span>
          )}
          {attempt?.success === false && (
            <span className="flex w-full flex-wrap items-center gap-2 text-xs text-destructive">
              Modellliste nicht geladen.
              <Button size="xs" variant="outline" disabled={busy} onClick={observe}>
                Erneut versuchen
              </Button>
            </span>
          )}
        </div>
      ) : null}
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
  return <NativeProviderRowsView state={state} label={label} />;
}

export function NativeProviderRowsView({
  state,
  label,
}: {
  readonly state: ReturnType<typeof useInstanceProviders>;
  readonly label: string;
}) {
  // A failed read is retried silently; the last known accounts stay (no status line).
  const providers = [...new Set(state.registry?.accounts.map((account) => account.provider) ?? [])];
  return (
    <div role="rowgroup" aria-label={`Konten auf ${label}`}>
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
  if (state.connectionFailure && !state.registry) return null;
  if (!registry) return <SettingsLoadingRow onRetry={() => void state.refresh()} />;
  return (
    <div role="rowgroup" aria-label={`${providerLabel}-Konten auf ${label}`}>
      {accounts.length > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
          {ProviderIcon && <ProviderIcon className="size-4 shrink-0" />}
          <span className="font-medium">{providerLabel}</span>
          <span className="text-muted-foreground">Gemeinsame Modelle</span>
          <div className="min-w-40 flex-1">
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
                    registry.providers.find((entry) => entry.provider === provider)?.selection ??
                    [];
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
                      (model) =>
                        !previous.includes(model) && account.effectiveModels.includes(model),
                    )) {
                      if (!(await state.check(account.id, account.revision, model))) return;
                    }
                  }
                })();
              }}
            />
          </div>
          {checksSupported ? (
            <Button
              size="xs"
              variant="outline"
              disabled={
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
              Alle prüfen
            </Button>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={state.busy}
                  aria-label={`Konten auf ${label} neu laden`}
                  onClick={() => {
                    void refresh();
                  }}
                />
              }
            >
              <RefreshCwIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup>Neu laden</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      {accounts.map((account, index) => (
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
