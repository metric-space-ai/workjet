import * as Schema from "effect/Schema";
import { WorkjetExitModelAssessment } from "@workjet/contracts";

/** Synthetic contract data only; never seeds or evaluates a real project. */
export const exitModelFixture = Schema.decodeUnknownSync(WorkjetExitModelAssessment)({
  contract: "ctox.workjet.exit_model.v1",
  project_id: "project-one",
  run_id: "fixture-run",
  as_of: "2026-10-08",
  exit_date: "2031-10-08",
  refresh_due: "2026-11-08",
  status: "provisional",
  missing_inputs: [],
  findings: [],
  resource_proposal: {
    hours_per_week: 20,
    monthly_budget_eur: 1_000,
    comparison_mode: "project_specific",
  },
  sources: [
    {
      id: "fixture",
      reference: "https://example.org/synthetic-evidence",
      observed_at: "2026-10-08",
      valid_until: "2026-11-08",
      kind: "assumed",
    },
  ],
  plan_summary: {
    mode: "committed_plan",
    comparison_mode: "project_specific",
    confirmed: false,
    budget_eur: 60_000,
    hours_per_week: 20,
    assumptions: ["Synthetic test assumptions"],
  },
  result: {
    expected_exit_equity_eur: 800_000,
    sale_probability: 0.8,
    expected_price_given_sale_eur: 1_000_000,
    probability_zero_proceeds: 0.2,
    p10_eur: 0,
    p50_eur: 1_000_000,
    p90_eur: 1_000_000,
  },
  scenarios: [
    {
      state: "operating",
      probability: 1,
      sale_probability: 0.8,
      equity_price_eur: 1_000_000,
      contribution_eur: 800_000,
    },
  ],
  diagnostics: [
    {
      state: "operating",
      probability: 1,
      sale_probability: 0.8,
      equity_price_eur: 1_000_000,
      source_ids: ["fixture"],
      ev_eur: 950_000,
      excess_cash_eur: 50_000,
      funding_eur: 60_000,
      cash_failure_month: null,
    },
  ],
  history: [],
  engine_version: "synthetic-test",
  currency: "EUR",
  basis: "100_percent_equity_before_fees_and_personal_tax",
  compiled_parameters_hash: null,
});
