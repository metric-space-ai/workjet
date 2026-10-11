import { useId, useState } from "react";
import type { WorkjetExitModelAssessment, WorkjetExitModelResources } from "@workjet/contracts";
import { RotateCcwIcon } from "lucide-react";
import {
  EXIT_MODEL_STATUS_LABELS,
  exitModelPresentation,
  exitSourceUrl,
  formatExitDate,
  formatExitChange,
  formatExitEur,
  formatExitFinding,
  formatExitMissingInput,
  formatExitPercent,
} from "../projectExitModel";
import { useProjectExitModel } from "../hooks/useProjectExitModel";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

export function ProjectExitModelSummary({
  projectId,
  assessment,
  onOpen,
}: {
  readonly projectId: string;
  readonly assessment?: WorkjetExitModelAssessment | null;
  readonly onOpen: () => void;
}) {
  const view = exitModelPresentation(assessment, projectId);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Fünf-Jahres-Exit-Bewertung ansehen"
      aria-description={view.value + " · " + view.label}
      title={
        view.value +
        " · " +
        view.label +
        (view.assessment?.as_of ? " · " + formatExitDate(view.assessment.as_of) : "")
      }
      data-workjet-action={"project.exit_model.open:" + projectId}
      className="absolute top-1/2 left-1/2 z-10 max-w-[85%] -translate-x-1/2 -translate-y-1/2 -rotate-6 rounded-sm border-4 border-double border-foreground/70 bg-background/90 px-4 py-2 text-center text-3xl leading-none font-bold tracking-tight whitespace-nowrap text-foreground tabular-nums shadow-sm hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      data-workjet-exit-model-status={view.status}
      data-workjet-exit-model-stamp=""
    >
      {view.value}
    </button>
  );
}

export function ProjectExitModelPanel({
  projectId,
  instanceId,
  assessment,
}: {
  readonly projectId: string;
  readonly instanceId: string | null;
  readonly assessment?: WorkjetExitModelAssessment | null;
}) {
  const state = useProjectExitModel(instanceId, projectId, assessment);
  return (
    <ProjectExitModelReport
      projectId={projectId}
      assessment={state.assessment}
      pending={state.pending}
      error={state.error}
      {...(state.connected ? { onRefresh: state.refresh, onCheck: state.check } : {})}
    />
  );
}

export function ProjectExitModelReport({
  projectId,
  assessment,
  pending = null,
  error = null,
  onRefresh,
  onCheck,
}: {
  readonly projectId: string;
  readonly assessment?: WorkjetExitModelAssessment | null;
  readonly pending?: "read" | "refresh" | null;
  readonly error?: string | null;
  readonly onRefresh?: (resources?: WorkjetExitModelResources) => Promise<boolean>;
  readonly onCheck?: () => Promise<boolean>;
}) {
  const view = exitModelPresentation(assessment, projectId);
  const current = view.assessment;
  const result = current?.result;
  const plan = current?.plan_summary;
  const proposal = current?.resource_proposal;
  const busy = pending !== null;
  const researching = current?.status === "researching";

  return (
    <section
      className="mb-6 min-w-0 border-y border-border py-5"
      aria-label="Fünf-Jahres-Exit-Bewertung"
      data-workjet-exit-model-project={projectId}
      data-workjet-exit-model-status={view.status}
    >
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">Kennzahl · Exit in 5 Jahren</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          {onRefresh && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || researching}
                onClick={() => void onRefresh()}
                data-workjet-action={"project.exit_model.refresh:" + projectId}
              >
                <RotateCcwIcon className="size-3.5" aria-hidden="true" />
                {pending === "refresh" ? "Bewerten …" : "Bewertung aktualisieren"}
              </Button>
            </>
          )}
          {researching && onCheck && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void onCheck()}>
              {pending === "read" ? "Prüfen …" : "Stand prüfen"}
            </Button>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div className="min-w-0">
          <p
            className="break-words text-3xl font-semibold tracking-tight tabular-nums"
            data-workjet-exit-model-value=""
          >
            {view.value}
          </p>
          <p role="status" className="mt-1 text-xs text-muted-foreground">
            {pending === "read" && current === null ? "Bewertung wird geladen …" : view.label}
            {current?.as_of ? " · bewertet " + formatExitDate(current.as_of) : ""}
          </p>
          {view.change && (
            <p className="mt-1 text-xs text-muted-foreground">
              {formatExitChange(view.change.percent)} seit der Bewertung vom{" "}
              {formatExitDate(view.change.asOf)}
            </p>
          )}
        </div>
        {result && (
          <dl className="flex flex-wrap gap-x-6 gap-y-3">
            <Metric
              label="Erlös P10–P90"
              value={formatExitEur(result.p10_eur) + " – " + formatExitEur(result.p90_eur)}
            />
            <Metric label="Verkaufschance" value={formatExitPercent(result.sale_probability)} />
            <Metric label="Exit-Datum" value={formatExitDate(current?.exit_date ?? null)} />
          </dl>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <p role="status" className="mt-3 text-xs text-muted-foreground">
        {!onRefresh
          ? "Bewertung braucht eine verbundene Instanz."
          : researching
            ? "Bewertung läuft …"
            : current?.status === "provisional"
              ? "Prognose mit deklarierten Annahmen."
              : view.stale
                ? "Stand veraltet — bitte aktualisieren."
                : ""}
      </p>
      {(current?.missing_inputs.length ?? 0) > 0 && (
        <div className="mt-4" data-workjet-exit-model-missing="">
          <h3 className="text-xs font-medium">Fehlende Angaben</h3>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-muted-foreground">
            {current!.missing_inputs.map((input, index) => (
              <li key={index} className="break-words [overflow-wrap:anywhere]">
                {formatExitMissingInput(input, current)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {current?.findings.length ? (
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {current.findings.map((finding, index) => (
            <li key={index}>{formatExitFinding(finding)}</li>
          ))}
        </ul>
      ) : null}

      {result && (
        <details className="mt-5 border-t border-border pt-3">
          <summary className="cursor-pointer text-sm font-medium">Szenarien und Bewertung</summary>
          <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
            <Metric label="Median-Erlös" value={formatExitEur(result.p50_eur)} />
            <Metric
              label="Preis bei Verkauf"
              value={formatExitEur(result.expected_price_given_sale_eur)}
            />
            <Metric
              label="Kein Erlös"
              value={formatExitPercent(result.probability_zero_proceeds)}
            />
          </dl>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">
                Scenario contributions to expected exit proceeds
              </caption>
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">Szenario</th>
                  <th className="px-2 font-medium">Wahrscheinlichkeit</th>
                  <th className="px-2 font-medium">Verkauf</th>
                  <th className="px-2 font-medium">Anteilspreis</th>
                  <th className="pl-2 font-medium">E5-Beitrag</th>
                </tr>
              </thead>
              <tbody>
                {current!.scenarios.map((scenario) => (
                  <tr key={scenario.state} className="border-t border-border tabular-nums">
                    <th scope="row" className="py-2 pr-3 font-normal">
                      {scenario.state.replaceAll("_", " ")}
                    </th>
                    <td className="px-2">{formatExitPercent(scenario.probability)}</td>
                    <td className="px-2">{formatExitPercent(scenario.sale_probability)}</td>
                    <td className="px-2 whitespace-nowrap">
                      {formatExitEur(scenario.equity_price_eur)}
                    </td>
                    <td className="pl-2 whitespace-nowrap">
                      {formatExitEur(scenario.contribution_eur)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {current?.diagnostics?.length ? (
        <details className="mt-4 border-t border-border pt-3">
          <summary className="cursor-pointer text-sm font-medium">
            Unternehmenswert und Finanzierung
          </summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Scenario enterprise value, cash and financing</caption>
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">Szenario</th>
                  <th className="px-2 font-medium">Unternehmenswert</th>
                  <th className="px-2 font-medium">Überschuss-Cash</th>
                  <th className="px-2 font-medium">Finanzierung</th>
                  <th className="pl-2 font-medium">Cash-Ausfall</th>
                </tr>
              </thead>
              <tbody>
                {current.diagnostics.map((item) => (
                  <tr key={item.state} className="border-t border-border tabular-nums">
                    <th scope="row" className="py-2 pr-3 font-normal">
                      {item.state.replaceAll("_", " ")}
                    </th>
                    <td className="px-2 whitespace-nowrap">{formatExitEur(item.ev_eur)}</td>
                    <td className="px-2 whitespace-nowrap">
                      {formatExitEur(item.excess_cash_eur)}
                    </td>
                    <td className="px-2 whitespace-nowrap">{formatExitEur(item.funding_eur)}</td>
                    <td className="pl-2 whitespace-nowrap">
                      {item.cash_failure_month === null
                        ? "None"
                        : "Month " + item.cash_failure_month}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      {plan || proposal || current?.sources.length ? (
        <details className="mt-4 border-t border-border pt-3">
          <summary className="cursor-pointer text-sm font-medium">
            Ressourcen, Annahmen und Quellen
          </summary>
          {proposal && (
            <>
              <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
                <Metric label="Stunden pro Woche" value={String(proposal.hours_per_week)} />
                <Metric
                  label="Monatsbudget (Vorschlag)"
                  value={formatExitEur(proposal.monthly_budget_eur)}
                />
                <Metric
                  label="Vergleich"
                  value={
                    proposal.comparison_mode === "equal_resources"
                      ? "Equal resources"
                      : "Projektspezifisch"
                  }
                />
              </dl>
            </>
          )}
          {plan && (
            <>
              <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
                <Metric label="Plan-Budget · 60 Monate" value={formatExitEur(plan.budget_eur)} />
                <Metric label="Stunden pro Woche" value={String(plan.hours_per_week)} />
                <Metric
                  label="Ressourcenzusage"
                  value={plan.confirmed ? "Bestätigt" : "Vorgeschlagen"}
                />
                <Metric
                  label="Vergleich"
                  value={
                    plan.comparison_mode === "equal_resources"
                      ? "Equal resources"
                      : "Projektspezifisch"
                  }
                />
              </dl>
              {plan.assumptions.length > 0 && (
                <ul className="mt-3 list-disc space-y-1 pl-4 text-sm text-muted-foreground">
                  {plan.assumptions.map((assumption, index) => (
                    <li key={index}>{assumption}</li>
                  ))}
                </ul>
              )}
            </>
          )}
          {current?.sources.length ? (
            <ul className="mt-4 space-y-3 text-sm">
              {current.sources.map((source) => {
                const url = exitSourceUrl(source.reference);
                return (
                  <li key={source.id} className="min-w-0 break-words [overflow-wrap:anywhere]">
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline underline-offset-2"
                      >
                        {source.reference}
                      </a>
                    ) : (
                      source.reference
                    )}
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {source.kind === "assumed"
                        ? "Assumption"
                        : source.kind === "derived"
                          ? "Derived"
                          : "Observed"}
                      {" · " +
                        formatExitDate(source.observed_at) +
                        " · valid through " +
                        formatExitDate(source.valid_until)}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </details>
      ) : null}

      {current?.history.length ? (
        <details className="mt-4 border-t border-border pt-3">
          <summary className="cursor-pointer text-sm font-medium">
            Assessment history · {current.history.length}
          </summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">
                Retained assessments with their original five-year horizons
              </caption>
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">Assessed</th>
                  <th className="px-2 font-medium">Exit date</th>
                  <th className="px-2 font-medium">Status</th>
                  <th className="pl-2 font-medium">Expected proceeds</th>
                </tr>
              </thead>
              <tbody>
                {[...current.history].reverse().map((run) => (
                  <tr key={run.run_id} className="border-t border-border">
                    <td className="py-2 pr-3 whitespace-nowrap">{formatExitDate(run.as_of)}</td>
                    <td className="px-2 whitespace-nowrap">{formatExitDate(run.exit_date)}</td>
                    <td className="px-2">{EXIT_MODEL_STATUS_LABELS[run.status]}</td>
                    <td className="pl-2 tabular-nums whitespace-nowrap">
                      {formatExitEur(run.result?.expected_exit_equity_eur ?? null)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}
    </section>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0">
      <dd className="break-words text-sm font-medium tabular-nums">{value}</dd>
      <dt className="mt-0.5 text-[11px] text-muted-foreground">{label}</dt>
    </div>
  );
}
