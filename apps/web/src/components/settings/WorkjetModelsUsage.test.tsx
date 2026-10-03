import type { WorkjetGatewayUsage, WorkjetGatewayUsageCounters } from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { usageDays, WorkjetModelsUsageView } from "./WorkjetModelsUsage";

const counters: WorkjetGatewayUsageCounters = {
  requests: 5,
  errors: 0,
  inputTokens: 40,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  inputMeasuredRequests: 1,
  outputMeasuredRequests: 0,
  cacheReadMeasuredRequests: 0,
  cacheWriteMeasuredRequests: 0,
  responseModelRequests: 5,
};
const usage: WorkjetGatewayUsage = {
  schemaVersion: 1,
  observedAtMs: Date.parse("2026-10-02T12:00:00Z"),
  days: 7,
  timeZone: "Europe/Berlin",
  startDate: "2026-09-26",
  endDate: "2026-10-02",
  availability: "recorded",
  daily: [
    {
      ...counters,
      requests: 2,
      responseModelRequests: 2,
      date: "2026-10-02",
      model: "shared-model",
      provider: "provider-a",
    },
    {
      ...counters,
      requests: 3,
      responseModelRequests: 3,
      inputTokens: null,
      inputMeasuredRequests: 0,
      date: "2026-10-02",
      model: "shared-model",
      provider: "provider-b",
    },
  ],
  modelTotals: [{ ...counters, model: "shared-model" }],
  providerTotals: [],
  totals: counters,
};

describe("Models usage presentation", () => {
  it("combines the same model across providers into one daily segment and includes empty days", () => {
    const days = usageDays(usage);
    expect(days).toHaveLength(7);
    expect(days[0]).toMatchObject({ date: "2026-09-26", requests: 0 });
    expect(days[6]?.requests).toBe(5);
    expect(days[6]?.models.size).toBe(1);
    expect(days[6]?.models.get("shared-model")).toBe(5);
  });

  it("shows partly measured token totals as a lower bound and missing counters as unknown", () => {
    const html = renderToStaticMarkup(
      <WorkjetModelsUsageView
        usage={usage}
        days={7}
        pending={false}
        error={null}
        onDaysChange={() => {}}
        onRefresh={() => {}}
      />,
    );
    expect(html).toContain("≥ 40");
    expect(html).toContain("—");
    expect(html).toContain("shared-model");
    expect(html).not.toContain("NaN");
  });
});
