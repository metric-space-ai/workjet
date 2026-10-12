import type { WorkjetExitModelAssessment, WorkjetExitModelResources } from "@workjet/contracts";
import { RotateCcwIcon } from "lucide-react";
import { useState } from "react";
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
  parseExitHoursPerWeek,
  parseExitMonthlyBudget,
} from "../projectExitModel";
import { useProjectExitModel } from "../hooks/useProjectExitModel";
import { Button } from "./ui/button";

export function ProjectExitModelSummary({
  projectId,
  assessment,
}: {
  readonly projectId: string;
  readonly assessment?: WorkjetExitModelAssessment | null;
}) {
  const view = exitModelPresentation(assessment, projectId);
  const valued = view.value !== "—";
  // Der Stempel ist immer sichtbar und bleibt reine Anzeige: nicht klickbar,
  // damit ein Klick auf die Vorschau weiter das Projekt öffnet.
  return (
    <div
      role="img"
      aria-label={
        valued
          ? view.value +
            " · " +
            view.label +
            (view.assessment?.as_of ? " · " + formatExitDate(view.assessment.as_of) : "")
          : "Nicht bewertet"
      }
      className={
        "pointer-events-none absolute top-1/2 left-1/2 z-10 max-w-[85%] -translate-x-1/2 -translate-y-1/2 -rotate-6 rounded-sm border-4 border-double px-4 py-2 text-center text-[22px] leading-none font-bold tracking-tight whitespace-nowrap tabular-nums shadow-sm " +
        (valued
          ? "border-foreground/70 bg-background/90 text-foreground"
          : "border-foreground/30 bg-background/70 text-muted-foreground/70")
      }
      data-workjet-exit-model-status={view.status}
      data-workjet-exit-model-stamp=""
    >
      {valued ? view.value : "Nicht bewertet"}
    </div>
  );
}

/**
 * Kompakte Rückseite der Galeriekarte: Ressourcen eingeben, bewerten, Stand lesen.
 * Szenarien, Quellen und Verlauf bleiben auf der Projektseite (ProjectExitModelReport).
 */
export function ProjectExitModelCardPanel({
  projectId,
  instanceId,
  assessment,
}: {
  readonly projectId: string;
  readonly instanceId: string | null;
  readonly assessment?: WorkjetExitModelAssessment | null;
}) {
  const state = useProjectExitModel(instanceId, projectId, assessment);
  const current = state.assessment;
  const view = exitModelPresentation(current, projectId);
  const proposal = current?.resource_proposal;
  const draftFor = (source: typeof proposal): ExitResourcesDraft => ({
    source,
    hours: source ? String(source.hours_per_week) : "",
    budget: source ? String(source.monthly_budget_eur) : "",
    mode: source?.comparison_mode ?? null,
  });
  const [storedDraft, setDraft] = useState<ExitResourcesDraft>(() => draftFor(proposal));
  const draft = storedDraft.source === proposal ? storedDraft : draftFor(proposal);
  const hoursValue = parseExitHoursPerWeek(draft.hours);
  const budgetValue = parseExitMonthlyBudget(draft.budget);
  const hoursInvalid = draft.hours.trim() !== "" && hoursValue === null;
  const budgetInvalid = draft.budget.trim() !== "" && budgetValue === null;
  const resourcesReady = hoursValue !== null && budgetValue !== null && draft.mode !== null;
  const busy = state.pending !== null || current?.status === "researching";
  const fieldsDisabled = !state.connected || busy;
  const missing = current?.missing_inputs ?? [];
  return (
    <div
      className="flex size-full min-h-0 flex-col gap-2 p-3"
      data-workjet-exit-model-project={projectId}
      data-workjet-exit-model-status={view.status}
      data-workjet-project-card-exit=""
    >
      <div className="flex flex-wrap items-end gap-x-2 gap-y-1.5">
        <label className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
          Std./Woche
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={168}
            step={1}
            value={draft.hours}
            disabled={fieldsDisabled}
            aria-label="Std./Woche"
            aria-invalid={hoursInvalid || undefined}
            onChange={(event) => setDraft({ ...draft, hours: event.currentTarget.value })}
            data-workjet-exit-model-input="hours"
            className="h-7 w-16 rounded-[var(--control-radius)] border border-input bg-popover px-2 text-[13.5px] text-foreground tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-64 aria-invalid:border-destructive"
          />
        </label>
        <label className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
          €/Monat
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={50}
            value={draft.budget}
            disabled={fieldsDisabled}
            aria-label="€/Monat"
            aria-invalid={budgetInvalid || undefined}
            onChange={(event) => setDraft({ ...draft, budget: event.currentTarget.value })}
            data-workjet-exit-model-input="budget"
            className="h-7 w-20 rounded-[var(--control-radius)] border border-input bg-popover px-2 text-[13.5px] text-foreground tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-64 aria-invalid:border-destructive"
          />
        </label>
        <div role="group" aria-label="Vergleichsmodus" className="flex gap-1">
          <Button
            size="xs"
            variant={draft.mode === "equal_resources" ? "default" : "outline"}
            aria-pressed={draft.mode === "equal_resources"}
            disabled={fieldsDisabled}
            onClick={() => setDraft({ ...draft, mode: "equal_resources" })}
            data-workjet-action={"project.exit_model.mode.equal:" + projectId}
          >
            Gleich
          </Button>
          <Button
            size="xs"
            variant={draft.mode === "project_specific" ? "default" : "outline"}
            aria-pressed={draft.mode === "project_specific"}
            disabled={fieldsDisabled}
            onClick={() => setDraft({ ...draft, mode: "project_specific" })}
            data-workjet-action={"project.exit_model.mode.specific:" + projectId}
          >
            Projekt
          </Button>
        </div>
        <Button
          size="xs"
          disabled={fieldsDisabled || !resourcesReady}
          onClick={() => {
            if (hoursValue === null || budgetValue === null || draft.mode === null) return;
            void state.refresh({
              hoursPerWeek: hoursValue,
              monthlyBudgetEur: budgetValue,
              comparisonMode: draft.mode,
            });
          }}
          data-workjet-action={"project.exit_model.refresh:" + projectId}
        >
          {state.pending === "refresh" ? "Bewerten …" : "Bewerten"}
        </Button>
      </div>
      <p
        role="status"
        className="min-w-0 break-words text-xs text-muted-foreground"
        data-workjet-exit-model-card-status=""
      >
        <span className="font-medium text-foreground tabular-nums">{view.value}</span>
        {" · "}
        {state.pending === "read" && current === null ? "Bewertung wird geladen …" : view.label}
        {missing.length > 0
          ? " · fehlt: " +
            missing
              .slice(0, 3)
              .map((input) => formatExitMissingInput(input, current))
              .join(", ")
          : ""}
        {!state.connected ? " · Instanz nicht verbunden" : ""}
      </p>
      {state.error && (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      )}
    </div>
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

  // Ressourcen-Eingabe: Vorbelegung aus dem Vorschlag des Eigentümers, keine Standardwerte.
  // Ein neu geladener Vorschlag (andere Objektidentität) ersetzt den Entwurf.
  const draftFor = (source: typeof proposal): ExitResourcesDraft => ({
    source,
    hours: source ? String(source.hours_per_week) : "",
    budget: source ? String(source.monthly_budget_eur) : "",
    mode: source?.comparison_mode ?? null,
  });
  const [storedDraft, setDraft] = useState<ExitResourcesDraft>(() => draftFor(proposal));
  const draft = storedDraft.source === proposal ? storedDraft : draftFor(proposal);
  const hoursValue = parseExitHoursPerWeek(draft.hours);
  const budgetValue = parseExitMonthlyBudget(draft.budget);
  const hoursInvalid = draft.hours.trim() !== "" && hoursValue === null;
  const budgetInvalid = draft.budget.trim() !== "" && budgetValue === null;
  const resourcesReady = hoursValue !== null && budgetValue !== null && draft.mode !== null;
  const fieldsDisabled = busy || researching;

  return (
    <section
      className="mb-6 min-w-0 border-y border-border py-5"
      aria-label="Fünf-Jahres-Exit-Bewertung"
      data-workjet-exit-model-project={projectId}
      data-workjet-exit-model-status={view.status}
    >
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[13.5px] font-medium">Kennzahl · Exit in 5 Jahren</h2>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          {onRefresh && (
            <>
              <label className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
                Std./Woche
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={168}
                  step={1}
                  value={draft.hours}
                  disabled={fieldsDisabled}
                  aria-label="Std./Woche"
                  aria-invalid={hoursInvalid || undefined}
                  onChange={(event) => setDraft({ ...draft, hours: event.currentTarget.value })}
                  data-workjet-exit-model-input="hours"
                  className="h-8 w-20 rounded-[var(--control-radius)] border border-input bg-popover px-2 text-[13.5px] text-foreground tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-64 aria-invalid:border-destructive sm:h-7"
                />
              </label>
              <label className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
                €/Monat
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={50}
                  value={draft.budget}
                  disabled={fieldsDisabled}
                  aria-label="€/Monat"
                  aria-invalid={budgetInvalid || undefined}
                  onChange={(event) => setDraft({ ...draft, budget: event.currentTarget.value })}
                  data-workjet-exit-model-input="budget"
                  className="h-8 w-24 rounded-[var(--control-radius)] border border-input bg-popover px-2 text-[13.5px] text-foreground tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-64 aria-invalid:border-destructive sm:h-7"
                />
              </label>
              <div role="group" aria-label="Vergleichsmodus" className="flex gap-1">
                <Button
                  size="sm"
                  variant={draft.mode === "equal_resources" ? "default" : "outline"}
                  aria-pressed={draft.mode === "equal_resources"}
                  disabled={fieldsDisabled}
                  onClick={() => setDraft({ ...draft, mode: "equal_resources" })}
                  data-workjet-action={"project.exit_model.mode.equal:" + projectId}
                >
                  Gleiche Ressourcen
                </Button>
                <Button
                  size="sm"
                  variant={draft.mode === "project_specific" ? "default" : "outline"}
                  aria-pressed={draft.mode === "project_specific"}
                  disabled={fieldsDisabled}
                  onClick={() => setDraft({ ...draft, mode: "project_specific" })}
                  data-workjet-action={"project.exit_model.mode.specific:" + projectId}
                >
                  Projektspezifisch
                </Button>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={fieldsDisabled || !resourcesReady}
                onClick={() => {
                  if (hoursValue === null || budgetValue === null || draft.mode === null) return;
                  void onRefresh({
                    hoursPerWeek: hoursValue,
                    monthlyBudgetEur: budgetValue,
                    comparisonMode: draft.mode,
                  });
                }}
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
            className="break-words text-[22px] font-semibold tracking-tight tabular-nums"
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
        <p role="alert" className="mt-3 text-[13.5px] text-destructive">
          {error}
        </p>
      )}
      <p role="status" className="mt-3 text-xs text-muted-foreground">
        {!onRefresh
          ? "Instanz nicht verbunden"
          : researching
            ? "Bewertung läuft …"
            : current?.status === "provisional"
              ? "Prognose mit Annahmen"
              : view.stale
                ? "Stand veraltet"
                : ""}
      </p>
      {(current?.missing_inputs.length ?? 0) > 0 && (
        <div className="mt-4" data-workjet-exit-model-missing="">
          <h3 className="text-xs font-medium">Fehlende Angaben</h3>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-[13.5px] text-muted-foreground">
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
          <summary className="cursor-pointer text-[13.5px] font-medium">
            Szenarien und Bewertung
          </summary>
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
              <caption className="sr-only">Szenariobeiträge zum Exit-Erlös</caption>
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
          <summary className="cursor-pointer text-[13.5px] font-medium">
            Unternehmenswert und Finanzierung
          </summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Szenarien: Wert, Cash, Finanzierung</caption>
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
                      {item.cash_failure_month === null ? "—" : "Monat " + item.cash_failure_month}
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
          <summary className="cursor-pointer text-[13.5px] font-medium">
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
                      ? "Gleiche Ressourcen"
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
                      ? "Gleiche Ressourcen"
                      : "Projektspezifisch"
                  }
                />
              </dl>
              {plan.assumptions.length > 0 && (
                <ul className="mt-3 list-disc space-y-1 pl-4 text-[13.5px] text-muted-foreground">
                  {plan.assumptions.map((assumption, index) => (
                    <li key={index}>{assumption}</li>
                  ))}
                </ul>
              )}
            </>
          )}
          {current?.sources.length ? (
            <ul className="mt-4 space-y-3 text-[13.5px]">
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
                        ? "Annahme"
                        : source.kind === "derived"
                          ? "Abgeleitet"
                          : "Beobachtet"}
                      {" · " +
                        formatExitDate(source.observed_at) +
                        " · gültig bis " +
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
          <summary className="cursor-pointer text-[13.5px] font-medium">
            Bewertungsverlauf · {current.history.length}
          </summary>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Frühere Bewertungen</caption>
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">Bewertet</th>
                  <th className="px-2 font-medium">Exit-Datum</th>
                  <th className="px-2 font-medium">Zustand</th>
                  <th className="pl-2 font-medium">Erwarteter Erlös</th>
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

type ExitResourcesDraft = {
  readonly source: WorkjetExitModelAssessment["resource_proposal"];
  readonly hours: string;
  readonly budget: string;
  readonly mode: WorkjetExitModelResources["comparisonMode"] | null;
};

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="min-w-0">
      <dd className="break-words text-[13.5px] font-medium tabular-nums">{value}</dd>
      <dt className="mt-0.5 text-[11px] text-muted-foreground">{label}</dt>
    </div>
  );
}
