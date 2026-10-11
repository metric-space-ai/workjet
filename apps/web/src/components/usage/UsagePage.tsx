import type { UsageProviderKind } from "@workjet/contracts";
import { CheckIcon, RefreshCwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import type { DailyTotals, HourlyTotals } from "@workjet/shared/usageMerge";

import { cn } from "../../lib/utils";
import { useUsage, type EnvironmentUsageStatus } from "../../state/usage";
import {
  enumerateDays,
  enumerateHourStarts,
  formatPercent,
  formatTokens,
  formatUsd,
  formatUsageCost,
  makeWindow,
} from "@workjet/shared/usageFormat";
import { SettingsPageContainer } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { UsageChartLegend, UsageProviderChart, type UsageChartMetric } from "./UsageProviderChart";
import { PROVIDER_COLOR, PROVIDER_LABEL, PROVIDER_MARK, PROVIDER_ORDER } from "./usageProviders";

const WINDOW_OPTIONS = [
  { days: 1, label: "24 h" },
  { days: 7, label: "7 Tage" },
  { days: 30, label: "30 Tage" },
  { days: 90, label: "90 Tage" },
] as const;

const METRIC_OPTIONS: ReadonlyArray<{ readonly value: UsageChartMetric; readonly label: string }> =
  [
    { value: "cost", label: "Kosten" },
    { value: "tokens", label: "Tokens" },
  ];

type Breakdown = "model" | "time";

/** `2026-08-07` → `7. Aug.` */
export function formatUsageDay(day: string): string {
  const [year, month, dayOfMonth] = day.split("-").map((part) => Number(part));
  if (!year || !month || !dayOfMonth) return day;
  return new Intl.DateTimeFormat("de-DE", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, dayOfMonth)));
}

/** Stundenbeginn → `14 Uhr` in der Zeitzone des Fensters. */
export function formatUsageHour(hourStart: string, timeZone?: string): string {
  const instant = new Date(hourStart);
  if (Number.isNaN(instant.getTime())) return hourStart;
  const hour = new Intl.DateTimeFormat("de-DE", {
    ...(timeZone === undefined ? {} : { timeZone }),
    hour: "2-digit",
    hourCycle: "h23",
  }).format(instant);
  return `${hour} Uhr`;
}

/** Zeitpunkt → `11. Okt., 14 Uhr`. */
function formatUsageDateTime(instant: string, timeZone?: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  const day = new Intl.DateTimeFormat("de-DE", {
    ...(timeZone === undefined ? {} : { timeZone }),
    day: "numeric",
    month: "short",
  }).format(date);
  return `${day}, ${formatUsageHour(instant, timeZone)}`;
}

/** Einstellungen › Verbrauch: Kosten und Tokens je Harness und Modell. */
export function UsagePage() {
  const [windowSelection, setWindowSelection] = useState(() => ({
    days: 30,
    window: makeWindow(30),
  }));
  const [metric, setMetric] = useState<UsageChartMetric>("cost");
  const [breakdown, setBreakdown] = useState<Breakdown>("model");
  const { days: windowDays, window } = windowSelection;
  const isPast24Hours = windowDays === 1;
  const { merged, environments, isPending, isPartial, refresh } = useUsage(window);

  // Hold the content until every environment is terminal. Rendering merged
  // totals while devices are still answering makes every number on the page
  // jump as each one lands.
  const settling = isPending || isPartial;

  const days = useMemo(
    () => enumerateDays(window.sinceDay, window.untilDay),
    [window.sinceDay, window.untilDay],
  );
  const hours = useMemo(
    () =>
      window.sinceTime === undefined || window.untilTime === undefined
        ? []
        : enumerateHourStarts(window.sinceTime, window.untilTime),
    [window.sinceTime, window.untilTime],
  );
  const recentPeriods = useMemo<readonly (DailyTotals | HourlyTotals)[]>(
    () => (isPast24Hours ? merged.hourly : merged.daily).toReversed().slice(0, 8),
    [isPast24Hours, merged.daily, merged.hourly],
  );

  // Ranked by whatever the toggle is showing, so the bars always descend.
  const orderedProviders = useMemo(
    () =>
      merged.providers.toSorted((a, b) =>
        metric === "cost" ? b.costUsd - a.costUsd : b.totalTokens - a.totalTokens,
      ),
    [merged.providers, metric],
  );

  const activePeriods = (isPast24Hours ? merged.hourly : merged.daily).filter(
    (period) => period.totalTokens > 0,
  ).length;
  const periodAverage = activePeriods === 0 ? 0 : merged.totalTokens / activePeriods;
  const observedInput = merged.uncachedInputTokens + merged.cachedInputTokens;
  const cachedShare = observedInput === 0 ? 0 : merged.cachedInputTokens / observedInput;
  const selectWindow = (days: number) => {
    setWindowSelection({
      days,
      window: makeWindow(days, undefined, days === 1 ? "hour" : "day"),
    });
  };
  const refreshWindow = () => {
    const nextWindow = makeWindow(windowDays, undefined, isPast24Hours ? "hour" : "day");
    if (
      nextWindow.sinceDay === window.sinceDay &&
      nextWindow.untilDay === window.untilDay &&
      nextWindow.sinceTime === window.sinceTime &&
      nextWindow.untilTime === window.untilTime
    ) {
      refresh();
    } else {
      setWindowSelection({ days: windowDays, window: nextWindow });
    }
  };
  const periodLabel = isPast24Hours ? "Stunde" : "Tag";
  const rangeLabel =
    isPast24Hours && window.sinceTime !== undefined && window.untilTime !== undefined
      ? `${formatUsageDateTime(window.sinceTime, window.timeZone)} – ${formatUsageDateTime(window.untilTime, window.timeZone)}`
      : `${formatUsageDay(window.sinceDay)} – ${formatUsageDay(window.untilDay)}`;

  return (
    <SettingsPageContainer wide className="gap-5">
      <div className="flex flex-wrap items-center gap-2" data-usage-toolbar="">
        <ToggleGroup
          aria-label="Zeitraum"
          className="shrink-0"
          size="sm"
          value={[String(windowDays)]}
          variant="outline"
          onValueChange={(value) => {
            const next = Number(value[0]);
            if (WINDOW_OPTIONS.some((option) => option.days === next)) selectWindow(next);
          }}
        >
          {WINDOW_OPTIONS.map((option) => (
            <Toggle key={option.days} value={String(option.days)}>
              {option.label}
            </Toggle>
          ))}
        </ToggleGroup>
        <span className="text-xs text-muted-foreground tabular-nums">{rangeLabel}</span>
        <Button
          aria-label="Aktualisieren"
          className="ms-auto"
          size="icon-sm"
          variant="outline"
          onClick={refreshWindow}
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>

      {settling ? (
        <>
          {environments.length > 1 ? <UsageDeviceStrip environments={environments} /> : null}
          <UsageSkeleton />
        </>
      ) : (
        <>
          <UsageCoverageNotice
            environments={environments}
            duplicateSources={merged.duplicateSources}
            staleEnvironments={merged.staleEnvironments}
          />

          <section className="grid gap-5 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
            {/* The summary follows the chart toggle, so the headline and the
                series are always reading the same units. */}
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs text-muted-foreground">
                  {metric === "cost" ? "Kosten zum API-Preis" : "Tokens gesamt"}
                </span>
                <span className="text-[22px] font-semibold text-foreground tabular-nums">
                  {metric === "cost"
                    ? formatUsageCost(merged.costUsd, merged.costQuality.unpricedShare)
                    : formatTokens(merged.totalTokens)}
                </span>
              </div>

              {orderedProviders.map((provider) => {
                const share = metric === "cost" ? provider.costShare : provider.tokenShare;
                const unpriced = merged.models.some(
                  (model) => model.provider === provider.provider && model.unpricedRecords > 0,
                )
                  ? 1
                  : 0;
                return (
                  <div key={provider.provider} className="flex flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-2 text-[13.5px]">
                      <span className="flex min-w-0 items-center gap-2 text-foreground">
                        <ProviderMark provider={provider.provider} className="size-4" />
                        <span className="truncate">{PROVIDER_LABEL[provider.provider]}</span>
                      </span>
                      <span className="text-foreground tabular-nums">
                        {metric === "cost"
                          ? formatUsageCost(provider.costUsd, unpriced)
                          : formatTokens(provider.totalTokens)}
                      </span>
                    </div>
                    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full"
                        style={{
                          width: `${(share * 100).toFixed(1)}%`,
                          backgroundColor: PROVIDER_COLOR[provider.provider],
                        }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {metric === "cost"
                        ? `${formatPercent(share)} · ${formatTokens(provider.totalTokens)} Tokens`
                        : `${formatPercent(share)} · ${formatUsageCost(provider.costUsd, unpriced)}`}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <ToggleGroup
                  aria-label="Größe"
                  size="sm"
                  value={[metric]}
                  variant="outline"
                  onValueChange={(value) => {
                    const next = value[0];
                    if (next === "cost" || next === "tokens") setMetric(next);
                  }}
                >
                  {METRIC_OPTIONS.map((option) => (
                    <Toggle key={option.value} value={option.value}>
                      {option.label}
                    </Toggle>
                  ))}
                </ToggleGroup>
                <UsageChartLegend />
              </div>
              <UsageProviderChart
                days={days}
                daily={merged.daily}
                hours={hours}
                hourly={merged.hourly}
                metric={metric}
                referenceTime={window.untilTime}
                resolution={isPast24Hours ? "hour" : "day"}
                timeZone={window.timeZone}
              />
            </div>
          </section>

          <section className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-5">
            <Metric
              label="Tokens"
              value={formatTokens(merged.totalTokens)}
              detail={`Ø ${formatTokens(periodAverage)} je ${periodLabel}`}
            />
            <Metric
              label="Cache-Lesen"
              value={formatTokens(merged.cachedInputTokens)}
              detail={`${formatPercent(cachedShare)} der Eingabe`}
            />
            <Metric
              label="Ohne Cache"
              value={formatTokens(merged.uncachedInputTokens)}
              detail={`${formatTokens(merged.cacheCreationTokens)} Cache-Schreiben`}
            />
            <Metric
              label="Ausgabe"
              value={formatTokens(merged.outputTokens)}
              detail={`${formatTokens(merged.reasoningTokens)} Reasoning`}
            />
            <Metric
              label="Cache-Ersparnis"
              value={formatUsd(merged.costQuality.cacheSavingsUsd)}
              detail={
                merged.costUsd > 0
                  ? `${(merged.costQuality.cacheSavingsUsd / merged.costUsd).toFixed(1)}× Kosten`
                  : "—"
              }
            />
          </section>

          <section className="flex flex-col gap-2">
            <ToggleGroup
              aria-label="Aufschlüsselung"
              size="sm"
              value={[breakdown]}
              variant="outline"
              onValueChange={(value) => {
                const next = value[0];
                if (next === "model" || next === "time") setBreakdown(next);
              }}
            >
              <Toggle value="model">Modell</Toggle>
              <Toggle value="time">{periodLabel}</Toggle>
            </ToggleGroup>

            {breakdown === "model" ? (
              <table className="w-full text-[13.5px]">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-1.5 font-normal">Modell</th>
                    <th className="py-1.5 text-right font-normal">Kosten</th>
                    <th className="py-1.5 text-right font-normal">Anteil</th>
                    <th className="py-1.5 text-right font-normal">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {merged.models.length === 0 ? (
                    <EmptyTableRow colSpan={4} />
                  ) : (
                    merged.models.map((model) => (
                      <tr
                        key={`${model.provider}:${model.model}`}
                        className="border-b border-border/50"
                      >
                        <td className="max-w-0 py-1.5 text-foreground">
                          <span className="flex min-w-0 items-center gap-2">
                            <ProviderMark provider={model.provider} className="size-3.5" />
                            <span className="truncate">{model.model}</span>
                          </span>
                        </td>
                        <td className="py-1.5 text-right text-foreground tabular-nums">
                          {formatUsageCost(model.costUsd, model.unpricedRecords)}
                        </td>
                        <td className="py-1.5 text-right text-muted-foreground tabular-nums">
                          {formatPercent(model.costShare)}
                        </td>
                        <td className="py-1.5 text-right text-muted-foreground tabular-nums">
                          {formatTokens(model.totalTokens)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            ) : (
              <table className="w-full text-[13.5px]">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="py-1.5 font-normal">{periodLabel}</th>
                    {PROVIDER_ORDER.map((provider) => (
                      <th
                        key={provider}
                        className="hidden py-1.5 text-right font-normal sm:table-cell"
                      >
                        {PROVIDER_LABEL[provider]}
                      </th>
                    ))}
                    <th className="py-1.5 text-right font-normal">Gesamt</th>
                    <th className="py-1.5 text-right font-normal">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {recentPeriods.length === 0 ? (
                    <EmptyTableRow colSpan={PROVIDER_ORDER.length + 3} />
                  ) : (
                    recentPeriods.map((period) => (
                      <tr
                        key={"hourStart" in period ? period.hourStart : period.day}
                        className="border-b border-border/50"
                      >
                        <td className="py-1.5 text-foreground">
                          {"hourStart" in period
                            ? formatUsageHour(period.hourStart, window.timeZone)
                            : formatUsageDay(period.day)}
                        </td>
                        {PROVIDER_ORDER.map((provider) => (
                          <td
                            key={provider}
                            className="hidden py-1.5 text-right text-muted-foreground tabular-nums sm:table-cell"
                          >
                            {formatUsd(period.byProvider.get(provider)?.costUsd ?? 0)}
                          </td>
                        ))}
                        <td className="py-1.5 text-right text-foreground tabular-nums">
                          {formatUsd(period.costUsd)}
                        </td>
                        <td className="py-1.5 text-right text-muted-foreground tabular-nums">
                          {formatTokens(period.totalTokens)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </SettingsPageContainer>
  );
}

function EmptyTableRow({ colSpan }: { readonly colSpan: number }) {
  return (
    <tr>
      <td colSpan={colSpan} className="py-4 text-center text-muted-foreground">
        Keine Aktivität
      </td>
    </tr>
  );
}

/** Brand mark for the harness a row belongs to. */
function ProviderMark({
  provider,
  className,
}: {
  readonly provider: UsageProviderKind;
  readonly className: string;
}) {
  const Mark = PROVIDER_MARK[provider];
  return <Mark className={cn("shrink-0", className)} aria-hidden />;
}

function Metric({
  label,
  value,
  detail,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 bg-background px-3 py-2">
      <span className="truncate text-xs text-muted-foreground">{label}</span>
      <span className="text-[13.5px] font-medium text-foreground tabular-nums">{value}</span>
      <span className="truncate text-xs text-muted-foreground">{detail}</span>
    </div>
  );
}

/**
 * Eine Zeile je Lücke in den Summen: Gerät ohne Antwort, Gerät mit älterer
 * Serverversion, gemeinsam genutztes Transkriptverzeichnis. Geräte, die noch
 * antworten, erreichen diesen Hinweis nie; bis dahin steht das Skelett.
 */
function UsageCoverageNotice({
  environments,
  duplicateSources,
  staleEnvironments,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
  readonly duplicateSources: readonly string[];
  readonly staleEnvironments: readonly string[];
}) {
  const failed = environments.filter((environment) => environment.error !== null);
  const stale = environments.filter((environment) =>
    staleEnvironments.includes(environment.environmentId),
  );
  if (failed.length === 0 && stale.length === 0 && duplicateSources.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
      {failed.map((environment) => (
        <span key={`failed:${environment.environmentId}`} className="flex items-center gap-2">
          <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0 text-destructive" />
          {`${environment.label}: keine Antwort`}
        </span>
      ))}
      {stale.map((environment) => (
        <span key={`stale:${environment.environmentId}`} className="flex items-center gap-2">
          <TriangleAlertIcon aria-hidden className="size-3.5 shrink-0" />
          {`${environment.label}: alte Version, nicht gezählt`}
        </span>
      ))}
      {duplicateSources.length > 0 ? (
        <span className="truncate">{`Einmal gezählt: ${duplicateSources.join(", ")}`}</span>
      ) : null}
    </div>
  );
}

/**
 * Per-device progress while the page waits for every environment to answer.
 * Only rendered with two or more devices; a lone device has nothing to
 * enumerate.
 */
function UsageDeviceStrip({
  environments,
}: {
  readonly environments: readonly EnvironmentUsageStatus[];
}) {
  const scanning = environments.filter(
    (environment) => environment.summary === null && environment.error === null,
  );
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-lg border border-border px-3 py-2 text-xs">
      {environments.map((environment) => {
        if (environment.summary !== null) {
          return (
            <span
              key={environment.environmentId}
              className="flex items-center gap-1 text-foreground"
            >
              <CheckIcon className="size-3 text-emerald-600 dark:text-emerald-300/90" aria-hidden />
              {environment.label}
            </span>
          );
        }
        if (environment.error !== null) {
          return (
            <span
              key={environment.environmentId}
              className="flex items-center gap-1 text-destructive"
            >
              <XIcon className="size-3" aria-hidden />
              {environment.label}
            </span>
          );
        }
        return (
          <span
            key={environment.environmentId}
            className="animate-status-pulse text-muted-foreground"
          >
            {environment.label}…
          </span>
        );
      })}
      <span className="ms-auto text-muted-foreground">{`noch ${scanning.length} prüfen`}</span>
    </div>
  );
}

/** Deterministic bar heights (each unique: they double as keys). */
const SKELETON_BAR_HEIGHTS = [34, 58, 41, 72, 22, 12, 49, 63, 80, 38, 55, 26, 44, 67];
const SKELETON_METRIC_LABELS = [
  "Tokens",
  "Cache-Lesen",
  "Ohne Cache",
  "Ausgabe",
  "Cache-Ersparnis",
];

/**
 * Static stand-in with the loaded page's shape: headline, provider split,
 * chart and metrics strip. No shimmer; blocks fill in exactly once when the
 * last device answers.
 */
function UsageSkeleton() {
  return (
    <>
      <section
        aria-busy="true"
        aria-label="Verbrauch lädt"
        className="grid gap-5 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]"
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-muted-foreground">Kosten zum API-Preis</span>
            <div className="my-1 h-6 w-32 rounded-sm bg-muted" />
          </div>

          {PROVIDER_ORDER.map((provider) => (
            <div key={provider} className="flex flex-col gap-1">
              <div className="flex items-center justify-between text-[13.5px]">
                <span className="flex items-center gap-2 text-foreground">
                  <ProviderMark provider={provider} className="size-4" />
                  {PROVIDER_LABEL[provider]}
                </span>
                <div className="h-3.5 w-14 rounded-sm bg-muted" />
              </div>
              <div className="h-1 w-full rounded-full bg-muted" />
              <div className="h-3 w-28 rounded-sm bg-muted" />
            </div>
          ))}
        </div>

        {/* Mirrors the chart's h-56 body and w-14 axis gutter to avoid a
            relayout when the real chart swaps in. */}
        <div className="flex flex-col gap-2">
          <div className="h-7 w-36 rounded-md bg-muted" />
          <div className="flex h-56 items-end gap-1 pl-16">
            {SKELETON_BAR_HEIGHTS.map((height) => (
              <div
                key={height}
                className="flex-1 rounded-sm bg-muted"
                style={{ height: `${height}%` }}
              />
            ))}
          </div>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-5">
        {SKELETON_METRIC_LABELS.map((label) => (
          <div key={label} className="flex flex-col gap-0.5 bg-background px-3 py-2">
            <span className="text-xs text-muted-foreground">{label}</span>
            <div className="my-1 h-4 w-16 rounded-sm bg-muted" />
            <div className="h-3 w-24 rounded-sm bg-muted" />
          </div>
        ))}
      </section>
    </>
  );
}
