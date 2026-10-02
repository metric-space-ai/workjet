import type {
  EnvironmentId,
  WorkjetGatewayUsage,
  WorkjetGatewayUsageCounters,
} from "@workjet/contracts";
import { useState } from "react";
import { RefreshCwIcon } from "lucide-react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";

const number = (value: number) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value);
const modelName = (value: string | null) => value ?? "Modell unbekannt";
const color = (model: string | null) => {
  let hash = 0;
  for (const character of model ?? "unknown")
    hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 55% 65%)`;
};

export function usageDays(usage: WorkjetGatewayUsage) {
  const groups = new Map<string, Map<string | null, number>>();
  for (const record of usage.daily) {
    const day = groups.get(record.date) ?? new Map<string | null, number>();
    day.set(record.model, (day.get(record.model) ?? 0) + record.requests);
    groups.set(record.date, day);
  }
  return Array.from({ length: usage.days }, (_, index) => {
    const date = new Date(Date.parse(`${usage.startDate}T00:00:00Z`) + index * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const models = groups.get(date) ?? new Map<string | null, number>();
    return { date, models, requests: [...models.values()].reduce((sum, value) => sum + value, 0) };
  });
}

function Tokens({
  counters,
  token,
  measured,
}: {
  readonly counters: WorkjetGatewayUsageCounters;
  readonly token: "inputTokens" | "outputTokens" | "cacheReadTokens";
  readonly measured:
    | "inputMeasuredRequests"
    | "outputMeasuredRequests"
    | "cacheReadMeasuredRequests";
}) {
  const value = counters[token];
  const count = counters[measured];
  return (
    <span
      title={
        value === null
          ? "Vom Anbieter nicht gemeldet"
          : `Gemessen bei ${number(count)} von ${number(counters.requests)} Aufrufen`
      }
    >
      {value === null ? "—" : `${count < counters.requests ? "≥ " : ""}${number(value)}`}
    </span>
  );
}

export function WorkjetModelsUsageView({
  usage,
  days,
  pending,
  error,
  onDaysChange,
  onRefresh,
}: {
  readonly usage: WorkjetGatewayUsage | null;
  readonly days: 7 | 30;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onDaysChange: (days: 7 | 30) => void;
  readonly onRefresh: () => void;
}) {
  const rows = [...(usage?.modelTotals ?? [])].sort(
    (a, b) => b.requests - a.requests || modelName(a.model).localeCompare(modelName(b.model)),
  );
  const daily = usage ? usageDays(usage) : [];
  const max = Math.max(1, ...daily.map((day) => day.requests));
  const chartModels = rows.slice(0, 6).map((row) => row.model);
  const hasOther = rows.length > chartModels.length;
  const dateLabel = (date: string) =>
    new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  return (
    <section
      className="mt-8 space-y-4 border-t border-border/60 pt-5"
      aria-label="Modellnutzung"
      data-testid="models-usage"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Modellnutzung</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Alle Anbieter und Workjet-Worker ·{" "}
            {usage ? `${number(usage.totals.requests)} Aufrufe` : "Nutzung wird geladen"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md bg-muted/50 p-0.5" aria-label="Zeitraum">
            {([7, 30] as const).map((range) => (
              <button
                key={range}
                type="button"
                aria-pressed={days === range}
                onClick={() => onDaysChange(range)}
                className={`rounded-sm px-3 py-1 text-xs ${days === range ? "bg-background text-foreground shadow-sm" : "text-muted-foreground"}`}
              >
                {range} Tage
              </button>
            ))}
          </div>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Nutzungsstatistik aktualisieren"
            disabled={pending}
            onClick={onRefresh}
          >
            <RefreshCwIcon className="size-4" />
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="flex items-center gap-3 text-sm text-destructive">
          Nutzungsdaten konnten nicht geladen werden.
          <button className="underline underline-offset-2" onClick={onRefresh}>
            Erneut versuchen
          </button>
        </p>
      ) : usage === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          Nutzungsdaten werden geladen …
        </p>
      ) : usage.totals.requests === 0 ? (
        <p className="py-5 text-sm text-muted-foreground">
          {usage.availability === "not-collected-yet"
            ? "Noch keine Nutzungsdaten. Neue Anfragen über den Hub werden nach dem ersten Aufruf hier sichtbar."
            : "In diesem Zeitraum wurden keine Aufrufe erfasst."}
        </p>
      ) : (
        <>
          <div className="rounded-lg border border-border/60 bg-muted/10 p-4">
            <div className="mb-3 flex justify-between text-xs text-muted-foreground">
              <span>
                {dateLabel(usage.startDate)} – {dateLabel(usage.endDate)}
              </span>
              <span>Aufrufe pro Tag</span>
            </div>
            <svg
              viewBox="0 0 760 190"
              role="img"
              aria-label={`Tägliche Modellaufrufe über ${days} Tage`}
              className="w-full overflow-visible"
            >
              {[0, 0.5, 1].map((fraction) => (
                <g key={fraction}>
                  <line
                    x1="34"
                    x2="756"
                    y1={150 - 132 * fraction}
                    y2={150 - 132 * fraction}
                    stroke="currentColor"
                    opacity="0.12"
                  />
                  <text
                    x="28"
                    y={154 - 132 * fraction}
                    textAnchor="end"
                    fontSize="10"
                    fill="currentColor"
                    opacity="0.6"
                  >
                    {number(Math.round(max * fraction))}
                  </text>
                </g>
              ))}
              {daily.map((day, index) => {
                const step = 718 / days;
                const width = Math.min(48, step * 0.7);
                const x = 38 + index * step + (step - width) / 2;
                let y = 150;
                const segments = chartModels.map((model) => ({
                  model,
                  count: day.models.get(model) ?? 0,
                  fill: color(model),
                }));
                if (hasOther)
                  segments.push({
                    model: "Weitere Modelle",
                    count: [...day.models]
                      .filter(([model]) => !chartModels.includes(model))
                      .reduce((sum, [, count]) => sum + count, 0),
                    fill: "#8b929d",
                  });
                return (
                  <g key={day.date}>
                    {segments.map((segment) => {
                      const height = (segment.count / max) * 132;
                      y -= height;
                      return (
                        <rect
                          key={segment.model ?? "unknown"}
                          x={x}
                          y={y}
                          width={width}
                          height={height}
                          fill={segment.fill}
                        >
                          <title>{`${dateLabel(day.date)} · ${modelName(segment.model)} · ${number(segment.count)} Aufrufe`}</title>
                        </rect>
                      );
                    })}
                    {(days === 7 || index === 0 || index === days - 1 || index % 7 === 0) && (
                      <text
                        x={x + width / 2}
                        y="174"
                        fontSize="10"
                        fill="currentColor"
                        opacity="0.65"
                        textAnchor="middle"
                      >
                        {dateLabel(day.date)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {chartModels.map((model) => (
                <span key={model ?? "unknown"} className="inline-flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full" style={{ background: color(model) }} />
                  {modelName(model)}
                </span>
              ))}
              {hasOther && <span className="text-muted-foreground">Weitere Modelle</span>}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs tabular-nums">
              <caption className="sr-only">
                Modellnutzung über alle Anbieter, nach Anzahl der Aufrufe sortiert
              </caption>
              <thead className="text-muted-foreground">
                <tr>
                  {[
                    "Modell",
                    "Aufrufe",
                    "Anteil",
                    "Fehler",
                    "Input-Token",
                    "Output-Token",
                    "Cache-Read",
                  ].map((label, index) => (
                    <th
                      key={label}
                      className={`pb-2 font-normal ${index === 0 ? "pr-4" : "px-2 text-right"}`}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.model ?? "unknown"} className="border-t border-border/40">
                    <th className="py-2 pr-4 font-normal">
                      <span className="flex items-center gap-2">
                        <span
                          className="size-1.5 shrink-0 rounded-full"
                          style={{ background: color(row.model) }}
                        />
                        <span className="break-all">{modelName(row.model)}</span>
                      </span>
                    </th>
                    <td className="px-2 text-right">{number(row.requests)}</td>
                    <td className="px-2 text-right">
                      {((row.requests / usage.totals.requests) * 100).toLocaleString(undefined, {
                        maximumFractionDigits: 1,
                      })}{" "}
                      %
                    </td>
                    <td className="px-2 text-right">{number(row.errors)}</td>
                    <td className="px-2 text-right">
                      <Tokens counters={row} token="inputTokens" measured="inputMeasuredRequests" />
                    </td>
                    <td className="px-2 text-right">
                      <Tokens
                        counters={row}
                        token="outputTokens"
                        measured="outputMeasuredRequests"
                      />
                    </td>
                    <td className="px-2 text-right">
                      <Tokens
                        counters={row}
                        token="cacheReadTokens"
                        measured="cacheReadMeasuredRequests"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Tokenwerte stammen aus gemeldeten Antworten. ≥ kennzeichnet teilweise gemessene Werte; —
            bedeutet nicht verfügbar. Aufrufe vor Beginn der Erfassung sind nicht enthalten.
            {usage.totals.responseModelRequests < usage.totals.requests &&
              " Wo die Antwort keine verlässliche Modell-ID liefert, wird die angeforderte Modell-ID gezählt."}
          </p>
        </>
      )}
    </section>
  );
}

export function WorkjetModelsUsage({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const [days, setDays] = useState<7 | 30>(7);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const query = useEnvironmentQuery(
    serverEnvironment.workjetGatewayUsage({ environmentId, input: { days, timeZone } }),
  );
  return (
    <WorkjetModelsUsageView
      usage={query.data}
      days={days}
      pending={query.isPending}
      error={query.error}
      onDaysChange={setDays}
      onRefresh={query.refresh}
    />
  );
}
