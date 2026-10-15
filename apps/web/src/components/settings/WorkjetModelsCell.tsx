import { CheckIcon, CircleDashedIcon, PlusIcon, XIcon } from "lucide-react";
import { Checkbox } from "../ui/checkbox";
import { useEffect, useRef, useState } from "react";
import type { WorkjetGatewayAccountSummary } from "@workjet/contracts";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "../../lib/utils";
import type { ModelsManagementState, ModelsModelCheck } from "./WorkjetModelsProviders";
import { parseModels } from "./WorkjetModelsFields";

const FAILURE_LABELS: Readonly<Record<string, string>> = {
  auth: "Anmeldung fehlgeschlagen · neu anmelden oder API-Key ersetzen",
  "quota-rate-limit": "Kontingent oder Ratenlimit · Reset abwarten",
  "unknown-model": "Unbekanntes Modell · Modell-ID prüfen",
  "network-provider": "Verbindung zum Anbieter fehlgeschlagen",
  "account-selection-unavailable": "Gateway-Update nötig",
};

const UNAVAILABLE_LABELS: Readonly<Record<string, string>> = {
  "gateway-not-ready": "Nicht geprüft · Gateway nicht bereit",
  "exact-account-unavailable": "Nicht geprüft · Konto nicht auswählbar",
  "account-unavailable": "Nicht geprüft · Konto deaktiviert",
  transport: "Nicht geprüft · Anfrage abgebrochen",
  timeout: "Zeitüberschreitung · erneut prüfen",
  "unverified-response": "Nicht geprüft · keine Bestätigung",
};

export function modelCheckState(check: ModelsModelCheck | undefined) {
  if (!check) return "unchecked";
  if (
    check.status === "unavailable" ||
    (check.status === "error" && (check.source !== "upstream" || check.httpStatus === null))
  )
    return "unavailable";
  return check.status;
}

export function modelCheckDescription(
  check: ModelsModelCheck | undefined,
  checking: boolean,
): string {
  if (!check) return checking ? "Prüft …" : "Nicht geprüft";
  const status = modelCheckState(check);
  const result =
    status === "unavailable"
      ? (UNAVAILABLE_LABELS[check.unavailableReason ?? ""] ?? "Nicht geprüft · erneut prüfen")
      : status === "ok"
        ? `Antwort · ${check.latencyMs} ms`
        : check.errorClass === "auth" && check.httpStatus === 403
          ? "Zugriff verweigert · Konto und Abo prüfen"
          : (FAILURE_LABELS[check.errorClass ?? ""] ?? "Prüfung fehlgeschlagen");
  return `${result}${check.httpStatus === null ? "" : ` · ${status === "unavailable" ? "Gateway " : ""}HTTP ${check.httpStatus}`} · ${new Date(check.checkedAtMs).toLocaleString()}${checking ? " · prüft erneut" : ""}`;
}

function ModelField({
  account,
  model,
  check,
  state,
  onDone,
}: {
  readonly account: WorkjetGatewayAccountSummary;
  readonly model: string | null;
  readonly check: ModelsModelCheck | undefined;
  readonly state: ModelsManagementState;
  readonly onDone?: () => void;
}) {
  const [draft, setDraft] = useState(model ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const focused = useRef(false);
  const savingRef = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(model ?? "");
  }, [model]);
  const save = async () => {
    if (savingRef.current || state.mutationBusy || (model !== null && draft.trim() === model))
      return;
    const parsed = parseModels(draft);
    if (parsed === null) {
      setError("Modell-IDs mit Komma trennen, ohne Leerzeichen.");
      return;
    }
    if (model === null && parsed.length === 0) {
      onDone?.();
      return;
    }
    const next = [
      ...new Set(
        account.modelIds
          .flatMap((current) => (current === model ? parsed : [current]))
          .concat(model === null ? parsed : []),
      ),
    ];
    savingRef.current = true;
    setSaving(true);
    try {
      if (await state.onEditModels([account], next)) {
        setError(null);
        if (model !== null && next.includes(model)) setDraft(model);
        onDone?.();
      } else setError("Nicht gespeichert.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const pending = state.pendingModelChecks?.find(
    (item) => item.accountId === account.id && item.modelId === model,
  );
  const description =
    pending?.status === "queued"
      ? `${modelCheckDescription(check, false)} · wartet`
      : modelCheckDescription(check, pending?.status === "running");
  const status = modelCheckState(check);
  const StatusIcon = pending
    ? CircleDashedIcon
    : status === "ok"
      ? CheckIcon
      : status === "error"
        ? XIcon
        : CircleDashedIcon;
  return (
    <span className="max-w-full shrink-0">
      <span
        className={cn(
          "inline-flex max-w-full items-center rounded border border-border/60 bg-muted/20 pr-1.5 transition-colors focus-within:border-ring focus-within:bg-background",
          error && "border-destructive",
        )}
      >
        <input
          aria-label={
            model === null
              ? `Modell hinzufügen für ${account.label}`
              : `Modell ${model} für ${account.label}`
          }
          data-workjet-action={`models.account.${account.id}.model.${model ?? "add"}`}
          autoFocus={model === null}
          placeholder="Modell-ID"
          value={draft}
          maxLength={16512}
          disabled={state.mutationBusy || saving}
          style={{ width: `${Math.max(8, draft.length || 12)}ch` }}
          className="box-content min-w-0 max-w-full rounded bg-transparent px-1.5 py-1 font-mono text-[11px] leading-4 outline-none disabled:opacity-60"
          title="Eingabetaste speichert, Esc verwirft"
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onFocus={() => {
            focused.current = true;
          }}
          onBlur={() => {
            focused.current = false;
            if (cancelled.current) {
              cancelled.current = false;
              return;
            }
            void save();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              cancelled.current = true;
              setDraft(model ?? "");
              setError(null);
              event.currentTarget.blur();
              onDone?.();
            }
          }}
        />
        {model !== null && (
          <span
            title={description}
            aria-label={`${model}: ${description}`}
            data-model-check={pending?.status ?? status}
            className={cn(
              "shrink-0",
              pending
                ? "text-muted-foreground"
                : status === "ok"
                  ? "text-emerald-500"
                  : status === "error"
                    ? "text-destructive"
                    : "text-muted-foreground",
            )}
          >
            <StatusIcon className="size-3.5" />
          </span>
        )}
      </span>
      {error && (
        <span role="alert" className="block text-[11px] text-destructive">
          {error}
        </span>
      )}
      {!pending &&
        (check?.unavailableReason === "timeout" || check?.unavailableReason === "transport") && (
          <span
            role="alert"
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
          >
            {check?.unavailableReason === "timeout" ? "Zeitüberschreitung" : "Prüfung abgebrochen"}
            <Button size="xs" variant="outline" onClick={() => state.onCheckModels?.(account.id)}>
              Erneut prüfen
            </Button>
          </span>
        )}
    </span>
  );
}

export function WorkjetModelsCell({
  account,
  state,
  models,
}: {
  readonly account: WorkjetGatewayAccountSummary;
  readonly state: ModelsManagementState;
  readonly models?: ReadonlyArray<string> | undefined;
}) {
  const [adding, setAdding] = useState(false);
  if (models !== undefined && state.onExcludeModel)
    return (
      <div className="flex min-w-0 flex-wrap gap-1" aria-label={`Modelle für ${account.label}`}>
        {models.map((model) => {
          const excluded = account.excludedModelIds?.includes(model) ?? false;
          const unavailable =
            account.availableModelIds !== undefined && !account.availableModelIds.includes(model);
          const check = state.modelChecks?.find(
            (item) => item.accountId === account.id && item.modelId === model,
          );
          const pending = state.pendingModelChecks?.find(
            (item) => item.accountId === account.id && item.modelId === model,
          );
          const active = account.modelIds.includes(model);
          const status = active ? modelCheckState(check) : "unchecked";
          const Icon =
            pending || (!excluded && !active)
              ? CircleDashedIcon
              : status === "ok"
                ? CheckIcon
                : status === "error"
                  ? XIcon
                  : CircleDashedIcon;
          const description = excluded
            ? "Für dieses Konto ausgeschlossen"
            : unavailable
              ? "Nicht in der Live-Modellliste des Kontos"
              : !active
                ? "Zugriff noch nicht beobachtet · Konto prüfen"
                : modelCheckDescription(check, pending?.status === "running");
          return (
            <label
              key={model}
              title={description}
              className={cn(
                "inline-flex max-w-full items-center gap-1 rounded border border-border/60 bg-muted/20 px-1.5 py-1 font-mono text-[11px]",
                (excluded || unavailable) && "text-muted-foreground opacity-60",
              )}
            >
              <Checkbox
                checked={!excluded}
                disabled={state.mutationBusy || unavailable}
                aria-label={`${model} für ${account.label} verwenden`}
                data-workjet-action={
                  "models.account." + account.id + ".model." + model + ".enabled"
                }
                onCheckedChange={(checked) => void state.onExcludeModel?.(account, model, !checked)}
              />
              <span className="min-w-0 break-all">{model}</span>
              {!excluded && !unavailable && (
                <span
                  data-model-check={pending?.status ?? status}
                  aria-label={model + ": " + description}
                  className={cn(
                    "shrink-0",
                    !pending && status === "ok"
                      ? "text-emerald-500"
                      : !pending && status === "error"
                        ? "text-destructive"
                        : "text-muted-foreground",
                  )}
                >
                  {/* Only a failed check shows an icon; ok/pending stay quiet (#610). */}
                  {!pending && status === "error" ? <Icon className="size-3.5" /> : null}
                </span>
              )}
            </label>
          );
        })}
      </div>
    );
  const choices = (models ?? []).filter((model) => !account.modelIds.includes(model));
  return (
    <div className="flex min-w-0 items-start gap-1">
      <div
        className="flex min-w-0 flex-1 flex-wrap items-center gap-1"
        aria-label={`Modelle für ${account.label}`}
      >
        {account.modelIds.map((model) => (
          <ModelField
            key={model}
            account={account}
            model={model}
            check={state.modelChecks?.find(
              (check) => check.accountId === account.id && check.modelId === model,
            )}
            state={state}
          />
        ))}
      </div>
      {adding ? (
        <ModelField
          account={account}
          model={null}
          check={undefined}
          state={state}
          onDone={() => setAdding(false)}
        />
      ) : choices.length > 0 ? (
        // Bekannte Modelle als Auswahl, Tippen nur für ein eigenes (Audit C 13).
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Modell hinzufügen für ${account.label}`}
                      data-workjet-action={`models.account.${account.id}.add-model`}
                      disabled={state.mutationBusy}
                    />
                  }
                />
              }
            >
              <PlusIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup>Modell hinzufügen</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            {choices.map((choice) => (
              <MenuItem
                key={choice}
                className="font-mono"
                onClick={() => void state.onEditModels([account], [...account.modelIds, choice])}
              >
                {choice}
              </MenuItem>
            ))}
            <MenuItem onClick={() => setAdding(true)}>Eigenes Modell</MenuItem>
          </MenuPopup>
        </Menu>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Modell hinzufügen für ${account.label}`}
                data-workjet-action={`models.account.${account.id}.add-model`}
                disabled={state.mutationBusy}
                onClick={() => setAdding(true)}
              />
            }
          >
            <PlusIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup>Modell hinzufügen</TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}
