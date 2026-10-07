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

export function modelCheckDescription(check: ModelsModelCheck | undefined, checking: boolean): string {
  if (!check) return checking ? "Checking this model" : "Not checked";
  const result = check.status === "ok" ? `Responded · ${check.latencyMs} ms` : (FAILURE_LABELS[check.errorClass ?? ""] ?? "Model check failed");
  return `${result}${check.httpStatus === null ? "" : ` · HTTP ${check.httpStatus}`} · ${new Date(check.checkedAtMs).toLocaleString()}${checking ? " · checking again" : ""}`;
}

function ModelField({ account, model, check, state, onDone }: {
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
  useEffect(() => { if (!focused.current) setDraft(model ?? ""); }, [model]);
  const save = async () => {
    if (savingRef.current || state.mutationBusy || (model !== null && draft.trim() === model)) return;
    const parsed = parseModels(draft);
    if (parsed === null) { setError("Use model IDs separated by commas; spaces are not allowed within an ID."); return; }
    if (model === null && parsed.length === 0) { onDone?.(); return; }
    const next = [...new Set(account.modelIds.flatMap((current) => current === model ? parsed : [current]).concat(model === null ? parsed : []))];
    savingRef.current = true;
    setSaving(true);
    try {
      if (await state.onEditModels([account], next)) { setError(null); onDone?.(); }
      else setError("Model was not saved. Press Enter to retry.");
    } finally { savingRef.current = false; setSaving(false); }
  };
  const description = modelCheckDescription(check, state.checksBusy ?? false);
  const StatusIcon = check?.status === "ok" ? CheckIcon : check?.status === "error" ? XIcon : CircleDashedIcon;
  return (
    <span className="max-w-full">
      <span className={cn("inline-flex max-w-full items-center rounded border border-border/60 bg-muted/20 pr-1.5 transition-colors focus-within:border-ring focus-within:bg-background", error && "border-destructive")}>
        <input
          aria-label={model === null ? `Add model for ${account.label}` : `Model ${model} for ${account.label}`}
          data-workjet-action={`models.account.${account.id}.model.${model ?? "add"}`}
          autoFocus={model === null}
          placeholder="Model ID"
          value={draft}
          maxLength={16512}
          disabled={state.mutationBusy || saving}
          style={{ width: `${Math.max(8, Math.min(24, draft.length || 12))}ch` }}
          className="min-w-0 max-w-full rounded bg-transparent px-1.5 py-1 font-mono text-[11px] leading-4 outline-none disabled:opacity-60"
          title="Edit directly. Enter saves; Escape cancels. Comma-separated IDs are supported."
          onChange={(event) => { setDraft(event.target.value); setError(null); }}
          onFocus={() => { focused.current = true; }}
          onBlur={() => {
            focused.current = false;
            if (cancelled.current) { cancelled.current = false; return; }
            void save();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); void save(); }
            if (event.key === "Escape") {
              event.preventDefault(); event.stopPropagation(); cancelled.current = true;
              setDraft(model ?? ""); setError(null); event.currentTarget.blur(); onDone?.();
            }
          }}
        />
        {model !== null && <span title={description} aria-label={`${model}: ${description}`} data-model-check={check?.status ?? "unchecked"} className={cn("shrink-0", check?.status === "ok" ? "text-emerald-500" : check?.status === "error" ? "text-destructive" : "text-muted-foreground")}><StatusIcon className="size-3.5" /></span>}
      </span>
      {error && <span role="alert" className="block text-[11px] text-destructive">{error}</span>}
    </span>
  );
}

export function WorkjetModelsCell({ account, state }: { readonly account: WorkjetGatewayAccountSummary; readonly state: ModelsManagementState }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {account.modelIds.map((model) => <ModelField key={model} account={account} model={model} check={state.modelChecks?.find((check) => check.accountId === account.id && check.modelId === model)} state={state} />)}
      {adding ? <ModelField account={account} model={null} check={undefined} state={state} onDone={() => setAdding(false)} /> :
        <Button size="icon-xs" variant="ghost" aria-label={`Add model for ${account.label}`} data-workjet-action={`models.account.${account.id}.add-model`} disabled={state.mutationBusy} onClick={() => setAdding(true)}><PlusIcon className="size-3" /></Button>}
    </div>
  );
}
