import { CommandId, EnvironmentId, ProjectId, WorkjetComputerId } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveNativeProjectOpening } from "./nativeProjectOpening";
import { buildProjectGallery } from "./projectOverview";

const project = { id: ProjectId.make("18dfe3f3-9703-41ac-9b56-254656e47822"), title: "greppy.xyz" };
const environmentId = EnvironmentId.make("local");
const intent = {
  instanceId: "welsch",
  commandId: CommandId.make("retained"),
  status: "confirmed" as const,
};
const input = {
  instanceId: "welsch",
  project,
  localEnvironmentId: environmentId,
  localConnected: true,
  projects: [],
};

describe("opening an existing native project", () => {
  const retained = {
    id: ProjectId.make("retained-history"),
    title: "Old greppy name",
    environmentId,
    workspaceRoot: "/work/greppy",
    updatedAt: "2026-10-06T00:00:00Z",
    ctoxRegistration: null,
  };
  const canonical = {
    ...project,
    workingCopies: [
      {
        id: "copy",
        computerId: WorkjetComputerId.make("computer"),
        path: retained.workspaceRoot,
        status: "active" as const,
      },
    ],
  };
  const gallery = buildProjectGallery({
    projects: [retained],
    nativeProjects: [canonical],
    instanceId: input.instanceId,
    primaryEnvironmentId: environmentId,
    computers: [
      {
        id: WorkjetComputerId.make("computer"),
        environmentId,
        label: "Local",
        presentationKind: "local",
        harnesses: [],
      },
    ],
  });
  it("opens the proven physical history to add its Supervisor without creating a duplicate project", () => {
    expect(
      resolveNativeProjectOpening({
        ...input,
        project: canonical,
        projects: [retained],
        gallery,
      }),
    ).toEqual({ _tag: "existing", project: retained });
  });
  it("keeps the exact joined environment when another environment has the same history ID", () => {
    const foreign = { ...retained, environmentId: EnvironmentId.make("foreign") };
    expect(
      resolveNativeProjectOpening({
        ...input,
        projects: [foreign, retained],
        gallery,
      }),
    ).toEqual({ _tag: "existing", project: retained });
    expect(resolveNativeProjectOpening({ ...input, projects: [foreign], gallery })._tag).toBe(
      "create",
    );
  });
  it("does not adopt a stale gallery join after the retained project belongs to another instance", () => {
    const foreign = { ...retained, ctoxRegistration: { ...intent, instanceId: "thesen" } };
    expect(resolveNativeProjectOpening({ ...input, projects: [foreign], gallery })._tag).toBe(
      "create",
    );
    expect(
      resolveNativeProjectOpening({
        ...input,
        instanceId: "thesen",
        projects: [retained],
        gallery,
      })._tag,
    ).toBe("create");
  });
  it("keeps the native ID and title when no local conversation exists", () => {
    expect(resolveNativeProjectOpening(input)).toEqual({
      _tag: "create",
      environmentId,
      projectId: project.id,
      title: project.title,
    });
  });
  it("reuses the retained project even when the local environment is offline", () => {
    const existing = { id: project.id, environmentId, ctoxRegistration: intent };
    expect(
      resolveNativeProjectOpening({ ...input, localConnected: false, projects: [existing] }),
    ).toEqual({ _tag: "existing", project: existing });
  });
  it("does not adopt a same-ID conversation belonging to another instance", () => {
    expect(
      resolveNativeProjectOpening({
        ...input,
        projects: [
          { id: project.id, environmentId, ctoxRegistration: { ...intent, instanceId: "thesen" } },
        ],
      })._tag,
    ).toBe("blocked");
  });
  it("does not overwrite an unregistered legacy project with the same ID", () => {
    expect(
      resolveNativeProjectOpening({
        ...input,
        projects: [{ id: project.id, environmentId, ctoxRegistration: null }],
      })._tag,
    ).toBe("blocked");
  });
  it("does not create a local conversation until its environment is connected", () => {
    expect(resolveNativeProjectOpening({ ...input, localConnected: false })._tag).toBe("blocked");
    expect(resolveNativeProjectOpening({ ...input, localEnvironmentId: null })._tag).toBe(
      "blocked",
    );
  });
  it("does not infer identity from a matching project name", () => {
    expect(
      resolveNativeProjectOpening({
        ...input,
        projects: [
          {
            id: ProjectId.make("04dfce58-d029-486a-a3fd-cd9fc5204a58"),
            environmentId,
            ctoxRegistration: intent,
          },
        ],
      }),
    ).toEqual({ _tag: "create", environmentId, projectId: project.id, title: project.title });
  });
});
