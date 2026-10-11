import type { UsageTokenTotals } from "@workjet/contracts";
import { BILLION, projectTokenTotal } from "@workjet/shared/projectTokenBudget";
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
export function ProjectTokenBudgetSummary({ view }: { readonly view: ProjectTokenBudgetView }) {
  const tokens = view.totals === null ? null : projectTokenTotal(view.totals);
  const used = tokens === null ? "unbekannt" : (tokens / BILLION).toFixed(1);
  const percent =
    tokens === null || view.limitBillions === null
      ? null
      : Math.floor((tokens / (Math.round(view.limitBillions * 10) * 100_000_000)) * 100);
  const partial = view.unknown.length > 0;
  const label =
    view.limitBillions === null
      ? `${used}${tokens === null ? "" : "B"}`
      : `${used}/${view.limitBillions.toFixed(1)}B${percent === null ? "" : ` (${partial ? "≥" : ""}${percent} %)`}`;
  const count = (n: number) => new Intl.NumberFormat("de-DE").format(n);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span tabIndex={0} />}
        aria-label={`Token-Verbrauch: ${label}${partial ? ", Usage teilweise unbekannt" : ""}`}
        data-workjet-token-budget=""
        title={
          partial ? `Usage unbekannt: ${view.unknown.join(", ")}` : "Token-Verbrauch je Zyklus"
        }
        className={`inline-flex max-w-full flex-wrap items-center gap-1 rounded px-1.5 py-0.5 text-xs tabular-nums ${percent !== null && percent >= 80 ? "bg-amber-500/10 text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
      >
        {label}
        {partial ? (
          <span aria-hidden="true" title="Usage teilweise unbekannt">
            {" "}
            · ?
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup className="max-w-[min(24rem,calc(100vw-2rem))]">
        <div className="grid gap-1 whitespace-normal break-words py-1">
          <strong>Token-Budget je Zyklus</strong>
          <span>
            {new Date(view.cycle.start).toLocaleString("de-DE", { timeZone: "Europe/Berlin" })} –{" "}
            {new Date(view.cycle.end).toLocaleString("de-DE", { timeZone: "Europe/Berlin" })}
          </span>
          {view.totals ? (
            <span>
              Input {count(view.totals.uncachedInputTokens)} · Cached input{" "}
              {count(view.totals.cachedInputTokens)} · Cache creation{" "}
              {count(view.totals.cacheCreationTokens)} · Output {count(view.totals.outputTokens)}
            </span>
          ) : null}
          {view.threads.map((thread, index) => (
            <span key={index}>
              {thread.role} · {thread.title}: {count(thread.tokens)}
            </span>
          ))}
          {partial ? (
            <span className="text-amber-700 dark:text-amber-300">
              Usage unbekannt: {view.unknown.join(", ")}. Angezeigt ist nur bekannter Verbrauch.
            </span>
          ) : null}
          <span>Kein automatischer Abbruch bei Überschreitung.</span>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
