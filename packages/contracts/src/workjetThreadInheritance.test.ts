import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { EnvironmentId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { DEFAULT_WORKJET_THREAD_CONFIG, inheritWorkjetThreadSettings, WorkjetThreadConfig } from "./workjet.ts";

const parent = { environmentId: EnvironmentId.make("fixture-environment"), threadId: ThreadId.make("parent") };
const projectId = ProjectId.make("fixture-project");

describe("new thread settings inheritance", () => {
  it("does not inherit another Worker's pull request or team membership", () => {
    const original: WorkjetThreadConfig = {
      ...DEFAULT_WORKJET_THREAD_CONFIG, schemaVersion: 2, role: "worker", parent,
      managedInstructions: "Project guidance",
      enabledCapabilityIds: ["greppy"],
      executionPolicy: { mode: "autonomous-worktree", projectId, revision: 8 },
      team: { role: "worker", projectId, threadId: ThreadId.make("old-worker"), parentThreadId: parent.threadId, packageId: "old-package", goal: "Old goal", createdAt: "2026-10-10T20:00:00.000Z" },
      pullRequest: { provider: "github", number: 77, url: "https://github.com/fixture/project/pull/77", branch: "old-worker" },
    };
    const next = inheritWorkjetThreadSettings(original);
    expect(next).toEqual({
      schemaVersion: 2, role: "standard", parent: null, managedInstructions: "Project guidance",
      enabledCapabilityIds: ["greppy"], capabilityBindings: [], ctoxSession: null,
      executionPolicy: { mode: "autonomous-worktree", projectId, revision: 8 },
    });
    expect(Schema.is(WorkjetThreadConfig)(next)).toBe(true);
    expect(original).toHaveProperty("pullRequest");
  });
  it("normalizes legacy configuration without inventing native references", () => {
    const next = inheritWorkjetThreadSettings({ schemaVersion: 1, role: "worker", parent, managedInstructions: "Existing guidance", enabledCapabilityIds: [] });
    expect(next).toEqual({ schemaVersion: 2, role: "standard", parent: null, managedInstructions: "Existing guidance", enabledCapabilityIds: [], capabilityBindings: [], ctoxSession: null });
  });
});
