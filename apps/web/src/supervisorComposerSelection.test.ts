import {
  ProjectId,
  ThreadId,
  WorkjetWorkerProfile,
  WorkjetComputer,
  WorkjetLumaInstanceConfiguration,
  DEFAULT_WORKJET_CONFIGURATION,
  type CtoxWorkjetProjectProjection,
} from "@workjet/contracts";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  isSupervisorManualProfile,
  prepareSupervisorManualProfile,
  persistSupervisorComposerSelection,
} from "./supervisorComposerSelection";
import type { WorkjetProjectControlPort } from "./workjetProjectControl";

const scope = {
  instanceId: "instance",
  projectId: ProjectId.make("project"),
  threadId: ThreadId.make("thread"),
};
// Existing authenticated catalog evidence: models/g3-claude-live-models-20261009.json.
const profile = Schema.decodeUnknownSync(WorkjetWorkerProfile)({
  id: "claude",
  name: "Claude",
  computerId: "mac",
  harness: "claude-code",
  modelId: "claude-opus-5-5",
  llmRouteId: "claude-account",
  reasoning: "automatic",
});
const configuration = Schema.decodeUnknownSync(WorkjetLumaInstanceConfiguration)({
  ...DEFAULT_WORKJET_CONFIGURATION,
  workerProfiles: [profile],
  llmRoutes: [{ id: profile.llmRouteId, label: "Claude", gatewayAccountId: "account" }],
});
const computers = [
  Schema.decodeUnknownSync(WorkjetComputer)({
    id: profile.computerId,
    label: "MacBook",
    environmentId: "local",
    presentationKind: "local",
    harnesses: [{ harness: profile.harness, available: true }],
  }),
];
const project: CtoxWorkjetProjectProjection = {
  id: scope.projectId,
  title: "Molecularity",
  workingCopies: [],
  supervisorLumaId: profile.id,
};

describe("Supervisor composer selection persistence", () => {
  it("creates a project-owned Manual route without changing a shared Luma", () => {
    const manual = prepareSupervisorManualProfile({
      projectId: scope.projectId,
      selection: profile,
      configuration,
      computers,
      models: [],
    });
    expect(isSupervisorManualProfile(manual, scope.projectId)).toBe(true);
    expect(manual).toMatchObject({
      name: "Manual",
      harness: profile.harness,
      modelId: profile.modelId,
      computerId: profile.computerId,
    });
    expect(configuration.workerProfiles).toEqual([profile]);
    expect(
      prepareSupervisorManualProfile({
        projectId: scope.projectId,
        selection: manual,
        configuration: { ...configuration, workerProfiles: [profile, manual] },
        computers,
        models: [],
      }),
    ).toBe(manual);
  });
  it("saves and reads back the route without sending, then restores the same choice after reload", async () => {
    const manual = prepareSupervisorManualProfile({
      projectId: scope.projectId,
      selection: profile,
      configuration,
      computers,
      models: [],
    });
    let saved = configuration;
    let persisted = project;
    const port = vi
      .fn<WorkjetProjectControlPort>()
      .mockImplementation(async (_instance, request) => {
        if (request.action === "project.configure") {
          persisted = { ...project, supervisorLumaId: request.supervisorLumaId! };
          return {
            _tag: "completed",
            response: { action: request.action, commandId: request.commandId, project: persisted },
          };
        }
        if (request.action === "project.list")
          return {
            _tag: "completed",
            response: { action: request.action, projects: [persisted], count: 1, truncated: false },
          };
        throw new Error("Must never send a turn");
      });
    const write = vi.fn(async (next: typeof configuration) => {
      saved = next;
      return "saved" as const;
    });
    const result = await persistSupervisorComposerSelection({
      scope,
      project,
      profile: manual,
      snapshot: { revision: 1, configuration, updatedAtMs: null },
      writeConfiguration: write,
      readConfiguration: async () => ({ revision: 2, configuration: saved, updatedAtMs: null }),
      signal: new AbortController().signal,
      isCurrent: () => true,
      port,
    });
    expect(result.supervisorLumaId).toBe(manual.id);
    const reloaded = saved.workerProfiles.find((entry) => entry.id === result.supervisorLumaId)!;
    expect(isSupervisorManualProfile(reloaded, scope.projectId)).toBe(true);
    expect(reloaded).toMatchObject({
      harness: profile.harness,
      modelId: profile.modelId,
      computerId: profile.computerId,
    });
    expect(port.mock.calls.map((call) => call[1].action)).toEqual([
      "project.configure",
      "project.list",
    ]);
    expect(write).toHaveBeenCalledOnce();
  });
  it("refuses a configuration conflict before selecting a route", async () => {
    const port = vi.fn<WorkjetProjectControlPort>();
    await expect(
      persistSupervisorComposerSelection({
        scope,
        project,
        profile: { ...profile, id: WorkjetWorkerProfile.fields.id.make("new") },
        snapshot: { revision: 1, configuration, updatedAtMs: null },
        writeConfiguration: async () => "conflict",
        readConfiguration: async () => ({ revision: 2, configuration, updatedAtMs: null }),
        signal: new AbortController().signal,
        isCurrent: () => true,
        port,
      }),
    ).rejects.toThrow("configuration changed");
    expect(port).not.toHaveBeenCalled();
  });
  it("refuses an unconfirmed model or a stale scope without overwriting the project", async () => {
    const port = vi.fn<WorkjetProjectControlPort>();
    await expect(
      persistSupervisorComposerSelection({
        scope,
        project,
        profile,
        snapshot: { revision: 1, configuration, updatedAtMs: null },
        writeConfiguration: async () => "saved",
        readConfiguration: async () => ({
          revision: 2,
          configuration: { ...configuration, workerProfiles: [] },
          updatedAtMs: null,
        }),
        signal: new AbortController().signal,
        isCurrent: () => true,
        port,
      }),
    ).rejects.toThrow("did not confirm");
    expect(port).not.toHaveBeenCalled();
  });
});
