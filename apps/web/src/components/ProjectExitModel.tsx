import { useId, useState } from "react";
import type { WorkjetExitModelAssessment, WorkjetExitModelResources } from "@workjet/contracts";
import { ArrowUpRightIcon, RotateCcwIcon } from "lucide-react";
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
      aria-label="View five-year exit assessment"
      data-workjet-action={"project.exit_model.open:" + projectId}
      className="flex w-full min-w-0 items-start justify-between gap-2 border-t border-border px-3 py-3 text-left hover:bg-muted/30 focus-visible:outline focus-visible:outline-ring"
      data-workjet-exit-model-status={view.status}
    >
      <span className="min-w-0">
        <span className="block text-[11px] text-muted-foreground">
          Essential KPI · Exit in 5 years
        </span>
        <span className="mt-0.5 block break-words text-xl font-semibold tracking-tight tabular-nums">
          {view.value}
        </span>
        <span className="mt-1 block text-[11px] text-muted-foreground">
          {view.label}
          {view.assessment?.as_of ? " · " + formatExitDate(view.assessment.as_of) : ""}
        </span>
        {view.change && (
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {formatExitChange(view.change.percent)} since previous calculated assessment
          </span>
        )}
      </span>
      <ArrowUpRightIcon
        className="mt-1 size-3.5 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
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
      onRefresh={state.connected ? state.refresh : undefined}
      onCheck={state.connected ? state.check : undefined}
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
  const [editingPlan, setEditingPlan] = useState(false);
  const [hours, setHours] = useState("");
  const [budget, setBudget] = useState("");
  const [comparison, setComparison] = useState<"equal_resources" | "project_specific">(
    "project_specific",
  );
  const [planError, setPlanError] = useState<string | null>(null);
  const formId = useId();
  const busy = pending !== null;
  const researching = current?.status === "researching";

  const openPlan = () => {
    if (!editingPlan) {
      setHours(
        proposal ? String(proposal.hours_per_week) : plan ? String(plan.hours_per_week) : "",
      );
      setBudget(proposal ? String(proposal.monthly_budget_eur) : "");
      setComparison(
        proposal?.comparison_mode === "equal_resources" ? "equal_resources" : "project_specific",
      );
      setPlanError(null);
    }
    setEditingPlan((value) => !value);
  };

  const savePlan = async () => {
    if (!onRefresh || busy) return;
    const hoursPerWeek = Number(hours);
    const monthlyBudgetEur = Number(budget);
    if (
      hours.trim() === "" ||
      budget.trim() === "" ||
      !Number.isFinite(hoursPerWeek) ||
      hoursPerWeek < 0 ||
      hoursPerWeek > 168 ||
      !Number.isFinite(monthlyBudgetEur) ||
      monthlyBudgetEur < 0
    ) {
      setPlanError("Enter hours between 0 and 168 and a nonnegative monthly budget.");
      return;
    }
    setPlanError(null);
    if (await onRefresh({ hoursPerWeek, monthlyBudgetEur, comparisonMode: comparison }))
      setEditingPlan(false);
  };

  return (
    <section
      className="mb-6 min-w-0 border-y border-border py-5"
      aria-label="Five-year exit assessment"
      data-workjet-exit-model-project={projectId}
      data-workjet-exit-model-status={view.status}
    >
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">Essential KPI · Exit in 5 years</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Expected sale proceeds · 100% equity · nominal EUR
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {onRefresh && (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || researching}
                onClick={openPlan}
                data-workjet-action={"project.exit_model.plan:" + projectId}
              >
                Resource plan
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || researching}
                onClick={() => void onRefresh()}
                data-workjet-action={"project.exit_model.refresh:" + projectId}
              >
                <RotateCcwIcon className="size-3.5" aria-hidden="true" />
                {pending === "refresh" ? "Assessing…" : "Update assessment"}
              </Button>
            </>
          )}
          {researching && onCheck && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void onCheck()}>
              {pending === "read" ? "Checking…" : "Check progress"}
            </Button>
          )}
        </div>
      </header>

      {editingPlan && (
        <form
          className="mb-5 border-b border-border pb-5"
          aria-label="Exit assessment resource plan"
          onSubmit={(event) => {
            event.preventDefault();
            void savePlan();
          }}
        >
          <p className="mb-3 text-xs text-muted-foreground">
            Set the resources available to this project. Research will use this plan; assumptions
            remain visible.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            <label htmlFor={formId + "-hours"} className="text-xs">
              Hours per week
              <Input
                id={formId + "-hours"}
                type="number"
                min="0"
                max="168"
                step="any"
                className="mt-1"
                value={hours}
                disabled={busy}
                onChange={(event) => setHours(event.target.value)}
              />
            </label>
            <label htmlFor={formId + "-budget"} className="text-xs">
              Monthly budget (EUR)
              <Input
                id={formId + "-budget"}
                type="number"
                min="0"
                step="any"
                className="mt-1"
                value={budget}
                disabled={busy}
                onChange={(event) => setBudget(event.target.value)}
              />
            </label>
            <label htmlFor={formId + "-comparison"} className="text-xs">
              Compare using
              <select
                id={formId + "-comparison"}
                className="mt-1 h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                value={comparison}
                disabled={busy}
                onChange={(event) =>
                  setComparison(
                    event.target.value === "equal_resources"
                      ? "equal_resources"
                      : "project_specific",
                  )
                }
              >
                <option value="project_specific">This project's plan</option>
                <option value="equal_resources">Equal resources per project</option>
              </select>
            </label>
          </div>
          {planError && (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {planError}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <Button size="sm" disabled={busy || researching} type="submit">
              {pending === "refresh" ? "Saving…" : "Save plan and assess"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditingPlan(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div className="min-w-0">
          <p
            className="break-words text-3xl font-semibold tracking-tight tabular-nums"
            data-workjet-exit-model-value=""
          >
            {view.value}
          </p>
          <p role="status" className="mt-1 text-xs text-muted-foreground">
            {pending === "read" && current === null ? "Loading assessment…" : view.label}
            {current?.as_of ? " · assessed " + formatExitDate(current.as_of) : ""}
          </p>
          {view.change && (
            <p className="mt-1 text-xs text-muted-foreground">
              {formatExitChange(view.change.percent)} since the calculated assessment on{" "}
              {formatExitDate(view.change.asOf)}
            </p>
          )}
        </div>
        {result && (
          <dl className="flex flex-wrap gap-x-6 gap-y-3">
            <Metric
              label="P10–P90 proceeds"
              value={formatExitEur(result.p10_eur) + " – " + formatExitEur(result.p90_eur)}
            />
            <Metric label="Sale probability" value={formatExitPercent(result.sale_probability)} />
            <Metric label="Exit date" value={formatExitDate(current?.exit_date ?? null)} />
          </dl>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {!onRefresh && (
        <p className="mt-3 text-sm text-muted-foreground">
          Connect this project to a CTOX instance to request an assessment.
        </p>
      )}
      {current?.status === "provisional" && (
        <p className="mt-3 text-xs text-muted-foreground">
          This forecast uses declared assumptions. Review the plan and sources before comparing
          projects.
        </p>
      )}
      {view.stale && (
        <p className="mt-3 text-xs text-muted-foreground">
          This result belongs to its recorded assessment date. Update it to include new evidence.
        </p>
      )}
      {researching && (
        <p className="mt-3 text-sm text-muted-foreground">
          Research is running. A sale estimate will appear after the inputs have been checked and
          calculated.
        </p>
      )}
      {(current?.missing_inputs.length ?? 0) > 0 && (
        <div className="mt-4" data-workjet-exit-model-missing="">
          <h3 className="text-xs font-medium">Inputs needed</h3>
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
          <summary className="cursor-pointer text-sm font-medium">
            Scenarios and valuation details
          </summary>
          <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
            <Metric label="Median proceeds" value={formatExitEur(result.p50_eur)} />
            <Metric
              label="Price if sold"
              value={formatExitEur(result.expected_price_given_sale_eur)}
            />
            <Metric
              label="Zero proceeds"
              value={formatExitPercent(result.probability_zero_proceeds)}
            />
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            Model forecast range; proceeds are before transaction fees and personal taxes.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">
                Scenario contributions to expected exit proceeds
              </caption>
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">Scenario</th>
                  <th className="px-2 font-medium">Probability</th>
                  <th className="px-2 font-medium">Sale</th>
                  <th className="px-2 font-medium">Equity price</th>
                  <th className="pl-2 font-medium">E5 contribution</th>
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
            Operating value and financing
          </summary>
          <p className="mt-3 text-xs text-muted-foreground">
            Committed funding and remaining cash are shown separately from operating enterprise
            value.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Scenario enterprise value, cash and financing</caption>
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3 font-medium">Scenario</th>
                  <th className="px-2 font-medium">Enterprise value</th>
                  <th className="px-2 font-medium">Excess cash</th>
                  <th className="px-2 font-medium">Funding</th>
                  <th className="pl-2 font-medium">Cash failure</th>
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
            Resource plan, assumptions and sources
          </summary>
          {proposal && (
            <>
              <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
                <Metric label="Proposed hours per week" value={String(proposal.hours_per_week)} />
                <Metric
                  label="Proposed monthly budget"
                  value={formatExitEur(proposal.monthly_budget_eur)}
                />
                <Metric
                  label="Comparison"
                  value={
                    proposal.comparison_mode === "equal_resources"
                      ? "Equal resources"
                      : "Project-specific plan"
                  }
                />
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">
                The proposal sets resource limits. A confirmed monthly operating plan is still
                required for calculation.
              </p>
            </>
          )}
          {plan && (
            <>
              <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
                <Metric label="Plan budget · 60 months" value={formatExitEur(plan.budget_eur)} />
                <Metric label="Hours per week" value={String(plan.hours_per_week)} />
                <Metric
                  label="Resource commitment"
                  value={plan.confirmed ? "Confirmed" : "Proposed"}
                />
                <Metric
                  label="Comparison"
                  value={
                    plan.comparison_mode === "equal_resources"
                      ? "Equal resources"
                      : "Project-specific plan"
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
