import type { UsageTokenTotals } from "@workjet/contracts";
import { BILLION, projectTokenTotal } from "@workjet/shared/projectTokenBudget";
import { workjetUiLanguage } from "../workjetProjectControl";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";

export type ProjectTokenBudgetView = {
  readonly totals: UsageTokenTotals | null;
  readonly limitBillions: number | null;
  readonly cycle: { readonly start: string; readonly end: string };
  readonly unknown: readonly string[];
  readonly threads: readonly {
    readonly title: string;
    readonly role: string;
    readonly tokens: number;
  }[];
};

/**
 * Token use per meeting cycle as "1,8/2,3 Mrd." in the UI language (Audit A-41).
 * Without measured usage nothing shows; the tooltip carries numbers only, an
 * incomplete measurement is the "≥" prefix (Audit A-42).
 */
export function ProjectTokenBudgetSummary({ view }: { readonly view: ProjectTokenBudgetView }) {
  const tokens = view.totals === null ? null : projectTokenTotal(view.totals);
  if (tokens === null) return null;
  const en = workjetUiLanguage() === "en";
  const locale = en ? "en-GB" : "de-DE";
  const unit = en ? "bn" : "Mrd.";
  const billions = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  // Kleine Mengen nicht als „0,0 Mrd.“ (unplausibel, #798), sondern kompakt: „120.000 Tokens“, „3,4 Mio. Tokens“.
  const small = tokens < BILLION / 20;
  const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
  const used = small ? compact.format(tokens) : billions.format(tokens / BILLION);
  const percent =
    view.limitBillions === null
      ? null
      : Math.floor((tokens / (Math.round(view.limitBillions * 10) * 100_000_000)) * 100);
  const partial = view.unknown.length > 0;
  const label =
    view.limitBillions === null
      ? `${partial ? "≥" : ""}${used} ${small ? "Tokens" : unit}`
      : small
        ? `${partial ? "≥" : ""}${used} Tokens / ${billions.format(view.limitBillions)} ${unit}${percent === null ? "" : ` (${percent} %)`}`
        : `${partial ? "≥" : ""}${used}/${billions.format(view.limitBillions)} ${unit}${percent === null ? "" : ` (${percent} %)`}`;
  const count = (n: number) => new Intl.NumberFormat(locale).format(n);
  const dateTime = (iso: string) =>
    new Date(iso).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span tabIndex={0} />}
        aria-label={`${en ? "Token use" : "Token-Verbrauch"}: ${label}`}
        data-workjet-token-budget=""
        className={`inline-flex max-w-full flex-wrap items-center gap-1 rounded px-1.5 py-0.5 text-[12px] tabular-nums ${percent !== null && percent >= 80 ? "bg-warning-surface text-warning-foreground" : "text-muted-foreground"}`}
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup className="max-w-[min(24rem,calc(100vw-2rem))]">
        <div className="grid gap-1 whitespace-normal break-words py-1 tabular-nums">
          <strong>{en ? "Token budget" : "Token-Budget"}</strong>
          <span>
            {dateTime(view.cycle.start)} – {dateTime(view.cycle.end)}
          </span>
          {view.totals ? (
            <span>
              {en ? "Input" : "Eingabe"} {count(view.totals.uncachedInputTokens)} ·{" "}
              {en ? "Cache input" : "Cache-Eingabe"} {count(view.totals.cachedInputTokens)} ·{" "}
              {en ? "Cache write" : "Cache-Aufbau"} {count(view.totals.cacheCreationTokens)} ·{" "}
              {en ? "Output" : "Ausgabe"} {count(view.totals.outputTokens)}
            </span>
          ) : null}
          {view.threads.map((thread, index) => (
            <span key={index}>
              {thread.role} · {thread.title}: {count(thread.tokens)}
            </span>
          ))}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
