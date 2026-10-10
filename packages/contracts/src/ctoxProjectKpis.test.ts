import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CtoxWorkjetProjectControlRequest, CtoxWorkjetProjectControlResponse } from "./ctox.ts";

const decodeRequest = Schema.decodeUnknownSync(CtoxWorkjetProjectControlRequest, {
  onExcessProperty: "error",
});
const decodeResponse = Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse, {
  onExcessProperty: "error",
});
const configure = {
  action: "project.kpis.configure",
  commandId: "c",
  projectId: "p",
  operationId: "operation",
  expectedRevision: 0,
  prompts: [{ kpi_id: "kpi-1", prompt: "Count completed project tasks." }],
};

describe("native KPI configuration contract", () => {
  it("accepts revision-checked prompts and clearing all slots", () => {
    expect(decodeRequest(configure)).toEqual(configure);
    expect(decodeRequest({ ...configure, prompts: [] }).action).toBe("project.kpis.configure");
  });
  it.each([
    { expectedRevision: -1 },
    { expectedRevision: 1.5 },
    { operationId: "" },
    {
      prompts: Array.from({ length: 4 }, (_, index) => ({
        kpi_id: `kpi-${index}`,
        prompt: "Count tasks.",
      })),
    },
    { prompts: [{ kpi_id: "kpi-1", prompt: "x".repeat(1025) }] },
    { prompts: [{ kpi_id: "kpi-1", prompt: "Count tasks.", value: "123" }] },
  ])("rejects invalid concurrency data or caller-computed values", (patch) => {
    expect(() => decodeRequest({ ...configure, ...patch })).toThrow();
  });
  it("decodes both legacy read and configure receipts but rejects another project's KPI data", () => {
    const response = {
      action: "project.kpis.configure",
      commandId: "c",
      projectId: "p",
      contract: "ctox.workjet.project_kpis.v1",
      kpis: { project_id: "p", revision: 1, items: [] },
    };
    expect(decodeResponse(response)).toEqual(response);
    expect(decodeResponse({ ...response, action: "project.kpis.read" }).action).toBe(
      "project.kpis.read",
    );
    expect(() =>
      decodeResponse({ ...response, kpis: { ...response.kpis, project_id: "other" } }),
    ).toThrow();
  });
});

// Full native ready wire shape observed on WELSCH native85e700 (not a projected subset).
const readySnapshot = {
  project_id: "p",
  kpi_id: "kpi-1",
  prompt_revision: 1,
  label: "Tasks",
  value: 0,
  unit: "tasks",
  display_value: "0",
  sources: [
    {
      source_key: "native-0",
      kind: "native_metric",
      connection_id: "native-core-command-ledger",
      metric_key: "project_tasks.total",
      project_id: "p",
      snapshot_revision: "receipt-sha256",
      evidence_ref: "native-project-task-snapshot:receipt-sha256",
      observed_at_ms: 1791561612174,
      value: 0,
    },
  ],
  computation: {
    recipe_id: "project_tasks.total",
    revision: 1,
    operation: "identity",
    input_keys: ["native-0"],
    window_start_ms: 1788969612174,
    window_end_ms: 1791561612174,
  },
  freshness: {
    calculated_at_ms: 1791561612174,
    refresh_at_ms: 1791565212174,
    fresh_until_ms: 1791568812174,
  },
};
const readyResponse = {
  action: "project.kpis.read",
  commandId: "read",
  projectId: "p",
  contract: "ctox.workjet.project_kpis.v1",
  kpis: {
    project_id: "p",
    revision: 4,
    items: [
      {
        prompt: { kpi_id: "kpi-1", prompt: "project_tasks_total", revision: 1 },
        result: { status: "ready", snapshot: readySnapshot },
      },
    ],
  },
};

describe("full native KPI snapshot transport", () => {
  it("keeps native values, source receipts and computation across strict IPC decoding", () => {
    expect(decodeResponse(readyResponse)).toEqual(readyResponse);
  });
  it.each([
    { project_id: "foreign" },
    { prompt_revision: 2 },
    { kpi_id: "other" },
    { sources: [{ ...readySnapshot.sources[0], project_id: "foreign" }] },
    { sources: [{ ...readySnapshot.sources[0], url: "https://private.example" }] },
    { computation: { ...readySnapshot.computation, sql: "SELECT secret" } },
    { value: Infinity },
    { value: NaN },
  ])("rejects foreign, nonfinite or unexpected snapshot data", (patch) => {
    expect(() =>
      decodeResponse({
        ...readyResponse,
        kpis: {
          ...readyResponse.kpis,
          items: [
            {
              ...readyResponse.kpis.items[0],
              result: { status: "ready", snapshot: { ...readySnapshot, ...patch } },
            },
          ],
        },
      }),
    ).toThrow();
  });
  it("requires a ready snapshot and never attaches it to an unresolved result", () => {
    for (const result of [
      { status: "ready" },
      {
        status: "missing_source",
        reason_code: "not_bound",
        message: "Not bound",
        snapshot: readySnapshot,
      },
    ]) {
      expect(() =>
        decodeResponse({
          ...readyResponse,
          kpis: { ...readyResponse.kpis, items: [{ ...readyResponse.kpis.items[0], result }] },
        }),
      ).toThrow();
    }
  });
});
