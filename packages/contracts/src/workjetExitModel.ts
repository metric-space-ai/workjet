import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CommandId, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const text = (maximum: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(maximum));
const money = Schema.Number.check(
  Schema.makeFilter(
    (value) => (Number.isFinite(value) && value >= 0) || "Use finite nonnegative EUR.",
  ),
);
const probability = money.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

export function isExitModelDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = DateTime.make(value + "T00:00:00Z");
  return Option.isSome(date) && DateTime.formatIsoDateUtc(date.value) === value;
}

export const WorkjetExitModelDate = Schema.String.check(
  Schema.makeFilter((value) => isExitModelDate(value) || "Use a valid calendar date."),
);

export function exitModelHorizon(asOf: string): string | null {
  if (!isExitModelDate(asOf)) return null;
  if (Number(asOf.slice(0, 4)) > 9994) return null;
  const horizon = DateTime.add(DateTime.makeUnsafe(asOf + "T00:00:00Z"), { months: 60 });
  return DateTime.formatIsoDateUtc(horizon);
}

export const WorkjetExitModelStatus = Schema.Literals([
  "not_started",
  "researching",
  "blocked",
  "provisional",
  "ready",
  "failed",
]);
export type WorkjetExitModelStatus = typeof WorkjetExitModelStatus.Type;

export const WorkjetExitModelResult = Schema.Struct({
  expected_exit_equity_eur: money,
  sale_probability: probability,
  expected_price_given_sale_eur: Schema.NullOr(money),
  probability_zero_proceeds: probability,
  p10_eur: money,
  p50_eur: money,
  p90_eur: money,
}).check(
  Schema.makeFilter((result) => {
    const sale = result.sale_probability;
    const conditional = result.expected_price_given_sale_eur;
    const expected = result.expected_exit_equity_eur;
    if (result.p10_eur > result.p50_eur || result.p50_eur > result.p90_eur)
      return "Proceeds quantiles must be ordered.";
    if (result.probability_zero_proceeds + 1e-9 < 1 - sale)
      return "No sale must contribute zero proceeds.";
    if (sale === 0)
      return (expected === 0 && conditional === null) || "No sale requires zero expected proceeds.";
    return (
      (conditional !== null &&
        Math.abs(conditional * sale - expected) <= 1e-8 * Math.max(1, expected)) ||
      "Conditional and expected sale proceeds must agree."
    );
  }),
);
export type WorkjetExitModelResult = typeof WorkjetExitModelResult.Type;

export const WorkjetExitModelSource = Schema.Struct({
  id: text(160),
  reference: text(4096),
  observed_at: WorkjetExitModelDate,
  valid_until: WorkjetExitModelDate,
  kind: Schema.Literals(["observed", "derived", "assumed"]),
}).check(
  Schema.makeFilter(
    (source) =>
      source.valid_until >= source.observed_at || "Source expiry cannot precede its observation.",
  ),
);
export const WorkjetExitModelPlanSummary = Schema.Struct({
  mode: text(96),
  comparison_mode: text(96),
  confirmed: Schema.Boolean,
  budget_eur: money,
  hours_per_week: money,
  assumptions: Schema.Array(text(2048)).check(Schema.isMaxLength(100)),
});
export const WorkjetExitModelScenario = Schema.Struct({
  state: text(256),
  probability,
  sale_probability: probability,
  equity_price_eur: money,
  contribution_eur: money,
});
export const WorkjetExitModelHistoryEntry = Schema.Struct({
  run_id: text(160),
  as_of: WorkjetExitModelDate,
  exit_date: WorkjetExitModelDate,
  status: WorkjetExitModelStatus,
  result: Schema.NullOr(WorkjetExitModelResult),
  missing_inputs: Schema.Array(text(2048)).check(Schema.isMaxLength(200)),
}).check(
  Schema.makeFilter(
    (entry) =>
      entry.exit_date === exitModelHorizon(entry.as_of) ||
      "History must retain each run's 60-month horizon.",
  ),
);
export const WorkjetExitModelAssessment = Schema.Struct({
  resource_proposal: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        hours_per_week: money.check(Schema.isBetween({ minimum: 0, maximum: 168 })),
        monthly_budget_eur: money,
        comparison_mode: Schema.Literals(["equal_resources", "project_specific"]),
      }),
    ),
  ),
  engine_version: Schema.optionalKey(text(128)),
  currency: Schema.optionalKey(Schema.Literal("EUR")),
  basis: Schema.optionalKey(text(256)),
  compiled_parameters_hash: Schema.optionalKey(Schema.NullOr(text(128))),
  diagnostics: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        state: text(256),
        probability,
        sale_probability: probability,
        equity_price_eur: money,
        source_ids: Schema.Array(text(160)).check(Schema.isMaxLength(400)),
        ev_eur: money,
        excess_cash_eur: money,
        funding_eur: money,
        cash_failure_month: Schema.NullOr(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
        ),
      }),
    ).check(Schema.isMaxLength(100)),
  ),
  contract: Schema.Literal("ctox.workjet.exit_model.v1"),
  project_id: ProjectId,
  run_id: Schema.NullOr(text(160)),
  as_of: Schema.NullOr(WorkjetExitModelDate),
  exit_date: Schema.NullOr(WorkjetExitModelDate),
  refresh_due: Schema.NullOr(WorkjetExitModelDate),
  status: WorkjetExitModelStatus,
  missing_inputs: Schema.Array(text(2048)).check(Schema.isMaxLength(200)),
  findings: Schema.Array(Schema.Struct({ code: text(128), message: text(2048) })).check(
    Schema.isMaxLength(200),
  ),
  sources: Schema.Array(WorkjetExitModelSource).check(Schema.isMaxLength(400)),
  plan_summary: Schema.NullOr(WorkjetExitModelPlanSummary),
  result: Schema.NullOr(WorkjetExitModelResult),
  scenarios: Schema.Array(WorkjetExitModelScenario).check(Schema.isMaxLength(100)),
  history: Schema.Array(WorkjetExitModelHistoryEntry).check(Schema.isMaxLength(120)),
}).check(
  Schema.makeFilter((assessment) => {
    if (assessment.as_of !== null && assessment.exit_date !== exitModelHorizon(assessment.as_of))
      return "Exit horizon must be 60 calendar months after the assessment date.";
    const valued = assessment.status === "ready" || assessment.status === "provisional";
    if (
      valued &&
      (assessment.result === null ||
        assessment.plan_summary === null ||
        assessment.run_id === null ||
        assessment.as_of === null ||
        assessment.sources.length === 0)
    )
      return "A valuation needs a run, date, resource plan and sources.";
    if (!valued && assessment.result !== null)
      return "An incomplete run cannot publish a valuation.";
    if (assessment.status === "ready" && !assessment.plan_summary?.confirmed)
      return "An unconfirmed resource plan must remain provisional.";
    if (valued) {
      const scenarios = assessment.scenarios;
      if (
        scenarios.length === 0 ||
        Math.abs(scenarios.reduce((sum, item) => sum + item.probability, 0) - 1) > 1e-8
      )
        return "Valuation scenarios must be complete and normalized.";
      if (
        scenarios.some(
          (item) =>
            Math.abs(
              item.contribution_eur -
                item.probability * item.sale_probability * item.equity_price_eur,
            ) >
            1e-8 * Math.max(1, item.contribution_eur),
        )
      )
        return "Scenario contributions must follow the expected proceeds formula.";
      if (
        Math.abs(
          scenarios.reduce((sum, item) => sum + item.contribution_eur, 0) -
            assessment.result!.expected_exit_equity_eur,
        ) >
        1e-8 * Math.max(1, assessment.result!.expected_exit_equity_eur)
      )
        return "Scenario contributions must sum to expected proceeds.";
      if (
        Math.abs(
          scenarios.reduce((sum, item) => sum + item.probability * item.sale_probability, 0) -
            assessment.result!.sale_probability,
        ) > 1e-8
      )
        return "Scenario sale probabilities must agree with the result.";
    }
    const ids = new Set(assessment.history.map((entry) => entry.run_id));
    return ids.size === assessment.history.length || "History run identifiers must be unique.";
  }),
);
export type WorkjetExitModelAssessment = typeof WorkjetExitModelAssessment.Type;

export const WorkjetExitModelResources = Schema.Struct({
  hoursPerWeek: money.check(Schema.isBetween({ minimum: 0, maximum: 168 })),
  monthlyBudgetEur: money,
  comparisonMode: Schema.Literals(["equal_resources", "project_specific"]),
});
export type WorkjetExitModelResources = typeof WorkjetExitModelResources.Type;

export const WorkjetExitModelReadRequest = Schema.Struct({
  action: Schema.Literal("project.exit_model.read"),
  commandId: CommandId,
  projectId: ProjectId,
});
export const WorkjetExitModelRefreshRequest = Schema.Struct({
  action: Schema.Literal("project.exit_model.refresh"),
  commandId: CommandId,
  projectId: ProjectId,
  asOf: Schema.optionalKey(WorkjetExitModelDate),
  resources: Schema.optionalKey(WorkjetExitModelResources),
});
export const WorkjetExitModelResponse = Schema.Struct({
  action: Schema.Literals(["project.exit_model.read", "project.exit_model.refresh"]),
  commandId: CommandId,
  projectId: ProjectId,
  assessment: WorkjetExitModelAssessment,
}).check(
  Schema.makeFilter(
    (response) =>
      response.projectId === response.assessment.project_id ||
      "Exit assessment belongs to another project.",
  ),
);

export function isWorkjetExitModelReceiptForRequest(
  request: { readonly action: string; readonly commandId?: string; readonly projectId?: string },
  response: {
    readonly action: string;
    readonly commandId?: string;
    readonly projectId?: string;
    readonly assessment?: WorkjetExitModelAssessment;
  },
): boolean {
  if (
    request.action !== "project.exit_model.read" &&
    request.action !== "project.exit_model.refresh"
  )
    return true;
  return (
    typeof request.commandId === "string" &&
    typeof request.projectId === "string" &&
    response.action === request.action &&
    response.commandId === request.commandId &&
    response.projectId === request.projectId &&
    response.assessment?.project_id === request.projectId
  );
}
