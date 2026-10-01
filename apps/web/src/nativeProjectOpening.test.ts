import { CommandId, EnvironmentId, ProjectId } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveNativeProjectOpening } from "./nativeProjectOpening";

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
