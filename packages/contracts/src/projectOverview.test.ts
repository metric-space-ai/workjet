import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { ProjectOverview, ProjectWebsiteUrl } from "./projectOverview.ts";
import { OrchestrationProject, OrchestrationCommand } from "./orchestration.ts";

const decode = Schema.decodeUnknownSync(ProjectOverview);
describe("project overview wire contract", () => {
  it("accepts three independently typed or empty slots", () => {
    const overview = {
      websiteUrl: "https://example.org/project",
      slots: [
        { kind: "text", label: "Phase", value: "Research" },
        { kind: "metric", label: "Entered leads", value: 17, unit: "leads" },
        null,
      ],
    };
    expect(decode(overview)).toEqual(overview);
    expect(
      decode({
        websiteUrl: null,
        slots: [
          null,
          { kind: "updated", label: "Changed" },
          { kind: "link", label: "Plan", url: "https://example.org/plan" },
        ],
      }).slots,
    ).toHaveLength(3);
  });
  it("rejects fewer or more than three slots", () => {
    for (const slots of [[], [null, null], [null, null, null, null]])
      expect(() => decode({ websiteUrl: null, slots })).toThrow();
  });
  it("rejects unsafe URLs and non-finite metrics at the wire boundary", () => {
    const url = Schema.decodeUnknownSync(ProjectWebsiteUrl);
    for (const value of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "ftp://example.org",
      "https://user:secret@example.org",
      "not a URL",
    ])
      expect(() => url(value)).toThrow();
    expect(() =>
      decode({
        websiteUrl: null,
        slots: [{ kind: "metric", label: "Total", value: Infinity, unit: "" }, null, null],
      }),
    ).toThrow();
  });
  it("keeps legacy snapshots valid and validates metadata update commands", () => {
    const project = {
      id: "legacy",
      title: "Legacy",
      workspaceRoot: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-10-02T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
      deletedAt: null,
    };
    expect(Schema.decodeUnknownSync(OrchestrationProject)(project).overview).toBeUndefined();
    const command = {
      type: "project.meta.update",
      commandId: "overview-change",
      projectId: "legacy",
      overview: { websiteUrl: null, slots: [null, null, null] },
    };
    expect(Schema.decodeUnknownSync(OrchestrationCommand)(command)).toEqual(command);
    expect(() =>
      Schema.decodeUnknownSync(OrchestrationCommand)({
        ...command,
        overview: { websiteUrl: null, slots: [null] },
      }),
    ).toThrow();
  });
});
