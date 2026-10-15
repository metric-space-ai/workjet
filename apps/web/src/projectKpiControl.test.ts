import { describe, expect, it, vi } from "vite-plus/test";
import { CommandId, ProjectId } from "@workjet/contracts";
import { saveWorkjetProjectKpis, type WorkjetProjectControlPort } from "./workjetProjectControl";

const request = {
  action: "project.kpis.configure",
  commandId: CommandId.make("kpi-save"),
  projectId: ProjectId.make("project-a"),
  operationId: "save-operation",
  expectedRevision: 4,
  prompts: [{ kpi_id: "kpi-1", prompt: "Count completed project tasks." }],
} as const;
const response = {
  action: "project.kpis.configure",
  commandId: request.commandId,
  projectId: request.projectId,
  contract: "ctox.workjet.project_kpis.v1",
  kpis: { project_id: request.projectId, revision: 5, items: [] },
} as const;

function port(next = response) {
  return vi
    .fn<WorkjetProjectControlPort>()
    .mockResolvedValue({ _tag: "completed", response: next });
}

describe("native project KPI saves", () => {
  it("persists prompts through the selected instance with operation ID and revision", async () => {
    const persist = port();
    expect(await saveWorkjetProjectKpis("managed:selected", request, persist)).toEqual(
      response.kpis,
    );
    expect(persist).toHaveBeenCalledExactlyOnceWith("managed:selected", request);
  });
  it("clears prompts through an empty native list", async () => {
    const persist = port();
    await saveWorkjetProjectKpis("managed:selected", { ...request, prompts: [] }, persist);
    expect(persist.mock.calls[0]?.[1]).toEqual({ ...request, prompts: [] });
  });
  it.each([
    { ...response, commandId: CommandId.make("another-command") },
    { ...response, projectId: ProjectId.make("another-project") },
    { ...response, kpis: { ...response.kpis, project_id: ProjectId.make("another-project") } },
    { ...response, kpis: { ...response.kpis, revision: 4 } },
  ])("retains the previous card for an uncorrelated or stale receipt", async (next) => {
    const persist = vi
      .fn<WorkjetProjectControlPort>()
      .mockResolvedValue({ _tag: "completed", response: next });
    expect(await saveWorkjetProjectKpis("managed:selected", request, persist)).toBeNull();
  });
  it("does not treat a read receipt as save confirmation", async () => {
    const persist = vi.fn<WorkjetProjectControlPort>().mockResolvedValue({
      _tag: "completed",
      response: { ...response, action: "project.kpis.read" },
    });
    expect(await saveWorkjetProjectKpis("managed:selected", request, persist)).toBeNull();
  });
  it("retains values on native denial or connection failure without replay", async () => {
    for (const persist of [
      vi.fn<WorkjetProjectControlPort>().mockResolvedValue({ _tag: "failed", code: "unsupported" }),
      vi.fn<WorkjetProjectControlPort>().mockRejectedValue(new Error("Connection closed")),
    ]) {
      expect(await saveWorkjetProjectKpis("managed:selected", request, persist)).toBeNull();
      expect(persist).toHaveBeenCalledOnce();
    }
  });
});
