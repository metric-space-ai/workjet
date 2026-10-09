import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CtoxWorkjetProjectControlRequest, CtoxWorkjetProjectControlResponse } from "./ctox.ts";

const decodeRequest = Schema.decodeUnknownSync(CtoxWorkjetProjectControlRequest, { onExcessProperty: "error" });
const decodeResponse = Schema.decodeUnknownSync(CtoxWorkjetProjectControlResponse, { onExcessProperty: "error" });
const configure = {
  action: "project.kpis.configure", commandId: "c", projectId: "p",
  operationId: "operation", expectedRevision: 0,
  prompts: [{ kpi_id: "kpi-1", prompt: "Count completed project tasks." }],
};

describe("native KPI configuration contract", () => {
  it("accepts revision-checked prompts and clearing all slots", () => {
    expect(decodeRequest(configure)).toEqual(configure);
    expect(decodeRequest({ ...configure, prompts: [] }).action).toBe("project.kpis.configure");
  });
  it.each([
    { expectedRevision: -1 }, { expectedRevision: 1.5 }, { operationId: "" },
    { prompts: Array.from({ length: 4 }, (_, index) => ({ kpi_id: `kpi-${index}`, prompt: "Count tasks." })) },
    { prompts: [{ kpi_id: "kpi-1", prompt: "x".repeat(1025) }] },
    { prompts: [{ kpi_id: "kpi-1", prompt: "Count tasks.", value: "123" }] },
  ])("rejects invalid concurrency data or caller-computed values", (patch) => {
    expect(() => decodeRequest({ ...configure, ...patch })).toThrow();
  });
  it("decodes both legacy read and configure receipts but rejects another project's KPI data", () => {
    const response = { action: "project.kpis.configure", commandId: "c", projectId: "p",
      contract: "ctox.workjet.project_kpis.v1", kpis: { project_id: "p", revision: 1, items: [] } };
    expect(decodeResponse(response)).toEqual(response);
    expect(decodeResponse({ ...response, action: "project.kpis.read" }).action).toBe("project.kpis.read");
    expect(() => decodeResponse({ ...response, kpis: { ...response.kpis, project_id: "other" } })).toThrow();
  });
});
