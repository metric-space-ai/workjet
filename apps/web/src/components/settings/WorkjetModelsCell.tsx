import { CheckIcon, CircleDashedIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { WorkjetGatewayAccountSummary } from "@workjet/contracts";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import type { ModelsManagementState, ModelsModelCheck } from "./WorkjetModelsProviders";
import { parseModels } from "./WorkjetModelsFields";

const FAILURE_LABELS: Readonly<Record<string, string>> = {
  auth: "Authentication failed · sign in again or replace the API key",
  "quota-rate-limit": "Quota or rate limit · wait for reset or check the subscription",
  "unknown-model": "Unknown model · edit this model ID",
  "network-provider": "Provider connection failed · re-check",
  "account-selection-unavailable": "Gateway update required to check this exact account",
};

const UNAVAILABLE_LABELS: Readonly<Record<string, string>> = {
  "gateway-not-ready": "Not checked · the gateway is not ready",
  "exact-account-unavailable": "Not checked · the gateway could not select this exact account",
  "account-unavailable": "Not checked · this account is disabled or unavailable",
  transport: "Not checked · the gateway request could not finish",
  timeout: "Check timed out · retry this model",
  "unverified-response": "Not checked · the gateway did not confirm an upstream result",
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
  if (!check) return checking ? "Checking this model" : "Not checked";
  const status = modelCheckState(check);
  const result =
    status === "unavailable"
      ? (UNAVAILABLE_LABELS[check.unavailableReason ?? ""] ?? "Not checked · re-check this model")
      : status === "ok"
        ? `Responded · ${check.latencyMs} ms`
        : check.errorClass === "auth" && check.httpStatus === 403
          ? "Access denied · check this account's permissions and subscription"
          : (FAILURE_LABELS[check.errorClass ?? ""] ?? "Model check failed");
  return `${result}${check.httpStatus === null ? "" : ` · ${status === "unavailable" ? "Gateway " : ""}HTTP ${check.httpStatus}`} · ${new Date(check.checkedAtMs).toLocaleString()}${checking ? " · checking again" : ""}`;
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
      setError("Use model IDs separated by commas; spaces are not allowed within an ID.");
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
      } else setError("Model was not saved. Press Enter to retry.");
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
      ? `${modelCheckDescription(check, false)} · queued`
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
              ? `Add model for ${account.label}`
              : `Model ${model} for ${account.label}`
          }
          data-workjet-action={`models.account.${account.id}.model.${model ?? "add"}`}
          autoFocus={model === null}
          placeholder="Model ID"
          value={draft}
          maxLength={16512}
          disabled={state.mutationBusy || saving}
          style={{ width: `${Math.max(8, draft.length || 12)}ch` }}
          className="box-content min-w-0 max-w-full rounded bg-transparent px-1.5 py-1 font-mono text-[11px] leading-4 outline-none disabled:opacity-60"
          title="Edit directly. Enter saves; Escape cancels. Comma-separated IDs are supported."
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
          <span role="alert" className="block text-[11px] text-muted-foreground">
            {check?.unavailableReason === "timeout" ? "Check timed out" : "Check could not finish"}{" "}
            ·{" "}
            <button
              type="button"
              className="underline"
              onClick={() => state.onCheckModels?.(account.id)}
            >
              Retry
            </button>
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
  readonly models?: ReadonlyArray<string>;
}) {
  const [adding, setAdding] = useState(false);
  if (models !== undefined && state.onExcludeModel) return <div className="flex min-w-0 flex-wrap gap-1" aria-label={"Models for " + account.label}>
    {models.map(model => {
      const excluded = account.excludedModelIds?.includes(model) ?? false;
      const unavailable = account.availableModelIds !== undefined && !account.availableModelIds.includes(model);
      const check = state.modelChecks?.find(item => item.accountId === account.id && item.modelId === model);
      const pending = state.pendingModelChecks?.find(item => item.accountId === account.id && item.modelId === model);
      const active = account.modelIds.includes(model);
      const status = active ? modelCheckState(check) : "unchecked";
      const Icon = pending || (!excluded && !active) ? CircleDashedIcon
        : status === "ok" ? CheckIcon : status === "error" ? XIcon : CircleDashedIcon;
      const description = excluded ? "Excluded for this account" : unavailable ? "Not offered by this account's live model list"
        : !active ? "Account model access has not been observed · check this account" : modelCheckDescription(check, pending?.status === "running");
      return <label key={model} title={description}
        className={cn("inline-flex max-w-full items-center gap-1 rounded border border-border/60 bg-muted/20 px-1.5 py-1 font-mono text-[11px]", (excluded || unavailable) && "text-muted-foreground opacity-60")}>
        <input type="checkbox" className="size-3 shrink-0" checked={!excluded} disabled={state.mutationBusy || unavailable}
          aria-label={"Use " + model + " for " + account.label}
          data-workjet-action={"models.account." + account.id + ".model." + model + ".enabled"}
          onChange={event => void state.onExcludeModel?.(account, model, !event.target.checked)} />
        <span className="min-w-0 break-all">{model}</span>
        {!excluded && !unavailable && <span data-model-check={pending?.status ?? status} aria-label={model + ": " + description}
          className={cn("shrink-0", !pending && status === "ok" ? "text-emerald-500" : !pending && status === "error" ? "text-destructive" : "text-muted-foreground")}><Icon className="size-3.5" /></span>}
      </label>;
    })}
  </div>;
  return (
    <div className="flex min-w-0 items-start gap-1">
      <div
        className="flex min-w-0 flex-1 flex-wrap items-center gap-1"
        aria-label={`Models for ${account.label}`}
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
      ) : (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Add model for ${account.label}`}
          data-workjet-action={`models.account.${account.id}.add-model`}
          disabled={state.mutationBusy}
          onClick={() => setAdding(true)}
        >
          <PlusIcon className="size-3" />
        </Button>
      )}
    </div>
  );
}
