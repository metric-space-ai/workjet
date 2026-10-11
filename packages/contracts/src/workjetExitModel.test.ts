import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import ctoxAssessment from "./fixtures/ctox-exit-model-assessment.json" with { type: "json" };
import { CtoxWorkjetProjectControlRequest, CtoxWorkjetProjectControlResponse } from "./ctox.ts";
import {
  WorkjetExitModelAssessment,
  exitModelHorizon,
  isWorkjetExitModelReceiptForRequest,
} from "./workjetExitModel.ts";

const decode = Schema.decodeUnknownSync(WorkjetExitModelAssessment, { onExcessProperty: "error" });
const encode = Schema.encodeSync(WorkjetExitModelAssessment);
const result = {
  expected_exit_equity_eur: 800_000,
  sale_probability: 0.8,
  expected_price_given_sale_eur: 1_000_000,
  probability_zero_proceeds: 0.2,
  p10_eur: 0,
  p50_eur: 1_000_000,
  p90_eur: 1_000_000,
};
const assessment = {
  contract: "ctox.workjet.exit_model.v1",
  project_id: "project-one",
  run_id: "run-one",
  as_of: "2026-10-08",
  exit_date: "2031-10-08",
  refresh_due: "2026-11-08",
  status: "provisional",
  missing_inputs: [],
  findings: [],
  sources: [
    {
      id: "fixture-source",
      reference: "fixture:explicit-test-assumptions",
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
    assumptions: ["Synthetic test only"],
  },
  result,
  scenarios: [
    {
      state: "operating",
      probability: 1,
      sale_probability: 0.8,
      equity_price_eur: 1_000_000,
      contribution_eur: 800_000,
    },
  ],
  history: [],
};

describe("native five-year exit assessment contracts", () => {
  it("strictly decodes a recorded CTOX producer receipt, including diagnostics and research history", () => {
    const value = decode(ctoxAssessment);
    expect(value.project_id).toBe("project");
    expect(value.status).toBe("provisional");
    expect(value.result?.expected_exit_equity_eur).toBe(8050);
    expect(value.result?.expected_price_given_sale_eur).toBe(8050);
    expect(value.history.map((run) => run.status)).toEqual(["provisional", "researching"]);
    expect(value.history[0]?.run_id).toBe(value.run_id);
    expect(value.resource_proposal?.monthly_budget_eur).toBe(300);
    expect(value.diagnostics?.[1]?.excess_cash_eur).toBe(6100);
  });

  it("retains source-backed, explicitly provisional inputs and exact computed amounts", () => {
    expect(decode(assessment)).toEqual(assessment);
    expect(encode(decode(assessment))).toEqual(assessment);
  });

  it.each([
    { status: "ready" },
    { sources: [] },
    { result: { ...result, expected_exit_equity_eur: Number.NaN } },
    { result: { ...result, sale_probability: 1.01 } },
    { result: { ...result, p10_eur: 2_000_000 } },
    { result: { ...result, expected_price_given_sale_eur: 2_000_000 } },
    { result: { ...result, probability_zero_proceeds: 0 } },
    {
      result: {
        ...result,
        expected_exit_equity_eur: 400_000,
        expected_price_given_sale_eur: 500_000,
      },
    },
    { scenarios: [{ ...assessment.scenarios[0], probability: 0.5 }] },
    { scenarios: [{ ...assessment.scenarios[0], contribution_eur: 100 }] },
    { as_of: "2026-02-30", exit_date: "2031-02-28" },
    { exit_date: "2030-10-08" },
    { status: "researching" },
  ])("rejects incomplete, inconsistent or invalid valuation %#", (patch) => {
    expect(() => decode({ ...assessment, ...patch })).toThrow();
  });

  it("keeps a blocked run empty and its old valuation in history", () => {
    const blocked = {
      ...assessment,
      run_id: "run-two",
      status: "blocked",
      result: null,
      sources: [],
      plan_summary: null,
      scenarios: [],
      missing_inputs: ["Confirmed plan"],
      history: [
        {
          run_id: "run-one",
          as_of: assessment.as_of,
          exit_date: assessment.exit_date,
          status: "provisional",
          result,
          missing_inputs: [],
        },
      ],
    };
    expect(decode(blocked).result).toBeNull();
    expect(decode(blocked).history[0]?.result?.expected_exit_equity_eur).toBe(800_000);
  });

  it("requires the same native project in metadata and control receipts", () => {
    const decodeResponse = Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse, {
      onExcessProperty: "error",
    });
    const response = {
      action: "project.exit_model.read",
      commandId: "command-one",
      projectId: "project-one",
      assessment,
    };
    expect(decodeResponse(response)).toEqual(response);
    expect(() => decodeResponse({ ...response, projectId: "foreign-project" })).toThrow();
    expect(() =>
      decodeResponse({
        action: "project.list",
        count: 1,
        truncated: false,
        projects: [
          { id: "foreign-project", title: "Foreign", workingCopies: [], exitModel: assessment },
        ],
      }),
    ).toThrow();
    expect(isWorkjetExitModelReceiptForRequest(response, decodeResponse(response))).toBe(true);
    expect(
      isWorkjetExitModelReceiptForRequest(
        { ...response, commandId: "another-command" },
        decodeResponse(response),
      ),
    ).toBe(false);
  });

  it("accepts resource proposals through the existing project-control request", () => {
    const decodeRequest = Schema.decodeUnknownSync(CtoxWorkjetProjectControlRequest);
    const request = {
      action: "project.exit_model.refresh",
      commandId: "command-one",
      projectId: "project-one",
      resources: { hoursPerWeek: 20, monthlyBudgetEur: 500, comparisonMode: "project_specific" },
    };
    expect(decodeRequest(request)).toEqual(request);
    expect(() =>
      decodeRequest({ ...request, resources: { ...request.resources, hoursPerWeek: 169 } }),
    ).toThrow();
  });

  it("clamps a leap-day horizon by calendar months and preserves the assessment date", () => {
    expect(exitModelHorizon("2024-02-29")).toBe("2029-02-28");
    expect(exitModelHorizon("2026-10-08")).toBe("2031-10-08");
    expect(exitModelHorizon("2026-02-30")).toBeNull();
    expect(exitModelHorizon("0004-02-29")).toBe("0009-02-28");
  });
});
