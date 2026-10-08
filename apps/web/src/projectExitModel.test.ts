import { describe, expect, it, vi } from "vite-plus/test";
import { CommandId, ProjectId } from "@workjet/contracts";
import {
  exitModelPresentation,
  exitSourceUrl,
  formatExitEur,
  requestProjectExitModel,
} from "./projectExitModel";
import { exitModelFixture } from "./test/exitModelFixture";
import type { WorkjetProjectControlPort } from "./workjetProjectControl";

const request = {
  action: "project.exit_model.read",
  commandId: CommandId.make("command-one"),
  projectId: ProjectId.make("project-one"),
} as const;
const receipt = { ...request, assessment: exitModelFixture };

describe("project exit assessment", () => {
  it("routes the typed native request only through its selected instance", async () => {
    const port = vi
      .fn<WorkjetProjectControlPort>()
      .mockResolvedValue({ _tag: "completed", response: receipt });
    await expect(requestProjectExitModel("managed:selected", request, port)).resolves.toEqual({
      _tag: "completed",
      assessment: exitModelFixture,
    });
    expect(port).toHaveBeenCalledExactlyOnceWith("managed:selected", request);
  });

  it.each([
    { ...receipt, commandId: CommandId.make("another-command") },
    { ...receipt, projectId: ProjectId.make("foreign-project") },
    { ...receipt, action: "project.exit_model.refresh" as const },
    {
      ...receipt,
      assessment: { ...exitModelFixture, project_id: ProjectId.make("foreign-project") },
    },
  ])("rejects an uncorrelated receipt %#", async (response) => {
    const port = vi
      .fn<WorkjetProjectControlPort>()
      .mockResolvedValue({ _tag: "completed", response });
    expect((await requestProjectExitModel("managed:selected", request, port))._tag).toBe("failed");
  });

  it("shows service absence without turning it into zero proceeds", async () => {
    const port = vi
      .fn<WorkjetProjectControlPort>()
      .mockResolvedValue({ _tag: "failed", code: "unsupported" });
    expect(await requestProjectExitModel("managed:selected", request, port)).toEqual({
      _tag: "failed",
      message:
        "The native exit assessment service is unavailable. Update or reconnect this instance.",
    });
    expect(exitModelPresentation(null, "project-one").value).toBe("—");
  });

  it("keeps dated values visible while explicitly labelling expired evidence", () => {
    expect(exitModelPresentation(exitModelFixture, "project-one", "2026-10-08")).toMatchObject({
      value: "800k EUR",
      label: "Provisional",
      stale: false,
    });
    expect(exitModelPresentation(exitModelFixture, "project-one", "2026-11-08")).toMatchObject({
      value: "800k EUR",
      label: "Out of date",
      stale: true,
    });
    expect(
      exitModelPresentation(
        { ...exitModelFixture, refresh_due: "2026-12-08" },
        "project-one",
        "2026-11-09",
      ).stale,
    ).toBe(true);
    expect(exitModelPresentation(exitModelFixture, "another-project").value).toBe("—");
  });

  it("does not promote retained history into a current blocked valuation", () => {
    const blocked = {
      ...exitModelFixture,
      status: "blocked" as const,
      result: null,
      missing_inputs: ["Confirmed rights"],
      scenarios: [],
      history: [
        {
          run_id: "old-run",
          as_of: "2026-10-08",
          exit_date: "2031-10-08",
          status: "provisional" as const,
          result: exitModelFixture.result,
          missing_inputs: [],
        },
      ],
    };
    expect(exitModelPresentation(blocked, "project-one", "2026-10-08")).toMatchObject({
      value: "—",
      label: "Inputs needed",
      stale: false,
    });
  });

  it("uses forecast precision and links only ordinary credential-free web sources", () => {
    expect(formatExitEur(3_163_500)).toBe("3.2m EUR");
    expect(formatExitEur(0)).toBe("0 EUR");
    expect(formatExitEur(Number.NaN)).toBe("—");
    expect(exitSourceUrl("https://example.org/evidence")).toBe("https://example.org/evidence");
    for (const reference of [
      "javascript:alert(1)",
      "file:///secret",
      "https://user:pass@example.org",
      "receipt:source",
    ])
      expect(exitSourceUrl(reference)).toBeNull();
  });
});
