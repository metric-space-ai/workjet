import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ProjectOverview, ProjectWebsiteUrl } from "./projectOverview.ts";
import { OrchestrationProject, OrchestrationCommand } from "./orchestration.ts";

const decode = Schema.decodeUnknownSync(ProjectOverview);
const decodeUrl = Schema.decodeUnknownSync(ProjectWebsiteUrl);
const decodeProject = Schema.decodeUnknownSync(OrchestrationProject);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationCommand);
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
  it("persists a repository independently of the website and accepts legacy records", () => {
    const legacy = { websiteUrl: null, slots: [null, null, null] };
    expect(decode(legacy)).toEqual(legacy);
    const configured = {
      ...legacy,
      repositoryUrl: "https://github.com/owner/repository",
    };
    expect(decode(configured)).toEqual(configured);
    expect(decode({ ...configured, repositoryUrl: null }).repositoryUrl).toBeNull();
    for (const repositoryUrl of [
      "javascript:alert(1)",
      "https://user:secret@example.org",
      "invalid",
    ])
      expect(() => decode({ ...legacy, repositoryUrl })).toThrow();
    const command = {
      type: "project.meta.update",
      commandId: "repository-change",
      projectId: "existing-project",
      overview: configured,
    };
    expect(decodeCommand(command)).toEqual(command);
  });
  it("accepts reversible archive metadata without changing project lifecycle or slots", () => {
    const overview = { archived: true, websiteUrl: null, slots: [null, null, null] };
    const command = {
      type: "project.meta.update",
      commandId: "archive-project",
      projectId: "retained",
      overview,
    };
    expect(decodeCommand(command)).toEqual(command);
    expect(decode({ ...overview, archived: false }).archived).toBe(false);
    for (const archived of [null, "true", 1])
      expect(() => decode({ ...overview, archived })).toThrow();
  });
  it("rejects fewer or more than three slots", () => {
    for (const slots of [[], [null, null], [null, null, null, null]])
      expect(() => decode({ websiteUrl: null, slots })).toThrow();
  });
  it("rejects unsafe URLs and non-finite metrics at the wire boundary", () => {
    for (const value of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "ftp://example.org",
      "https://user:secret@example.org",
      "not a URL",
    ])
      expect(() => decodeUrl(value)).toThrow();
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
    expect(decodeProject(project).overview).toBeUndefined();
    const command = {
      type: "project.meta.update",
      commandId: "overview-change",
      projectId: "legacy",
      overview: { websiteUrl: null, slots: [null, null, null] },
    };
    expect(decodeCommand(command)).toEqual(command);
    expect(() =>
      decodeCommand({
        ...command,
        overview: { websiteUrl: null, slots: [null] },
      }),
    ).toThrow();
  });
});
