import {
  CommandId,
  EnvironmentId,
  ProjectId,
  WorkjetComputerId,
  type CtoxWorkjetProjectProjection,
  type WorkjetComputer,
} from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  resolveProjectHistoryBindings,
  type ProjectHistoryIdentity,
} from "./workjetProjectIdentity";
import { workjetProjectConversationKeys } from "./workjetProjectConversationScope";

const environmentId = EnvironmentId.make("local");
const computer: WorkjetComputer = {
  id: WorkjetComputerId.make("owned-computer"),
  environmentId,
  label: "Local",
  presentationKind: "local",
  harnesses: [],
};
const native: CtoxWorkjetProjectProjection = {
  id: ProjectId.make("canonical"),
  title: "Renamed project",
  workingCopies: [
    { id: "immutable-copy", computerId: computer.id, path: "/work/source", status: "active" },
  ],
};
const duplicate: CtoxWorkjetProjectProjection = {
  id: ProjectId.make("older-id"),
  title: native.title,
  workingCopies: [],
};
const physical: ProjectHistoryIdentity = {
  id: ProjectId.make("retained-source-id"),
  environmentId,
  workspaceRoot: "/work/source/",
};
const input = {
  instanceId: "own",
  nativeProjects: [native, duplicate],
  projects: [physical],
  computers: [computer],
};
const registration = {
  instanceId: "own",
  commandId: CommandId.make("retained-intent"),
  status: "pending" as const,
};

describe("lossless native project/history identity", () => {
  it("retains both native IDs and the physical history ID, with an explicit working-copy proof", () => {
    const original = JSON.stringify(input);
    expect(resolveProjectHistoryBindings(input)).toEqual([
      {
        instanceId: "own",
        nativeProjectId: native.id,
        projectId: physical.id,
        environmentId,
        proof: { kind: "working-copy", workingCopyId: "immutable-copy", computerId: computer.id },
      },
    ]);
    expect(JSON.stringify(input)).toBe(original);
    expect([...workjetProjectConversationKeys({ ...input, project: native })]).toEqual([
      "local:retained-source-id",
      "local:canonical",
    ]);
    expect(workjetProjectConversationKeys({ ...input, project: duplicate }).size).toBe(0);
  });
  it("reconstructs the same ownership after persisted snapshots reload and project titles change", () => {
    const reloaded = JSON.parse(JSON.stringify(input));
    reloaded.nativeProjects[0].title = "Another title";
    expect(resolveProjectHistoryBindings(reloaded)).toEqual(resolveProjectHistoryBindings(input));
  });
  it("includes the retained folder-free supervisor without requiring a computer", () => {
    const logical = {
      id: native.id,
      environmentId,
      workspaceRoot: null,
      ctoxRegistration: registration,
    };
    expect([
      ...workjetProjectConversationKeys({
        ...input,
        project: native,
        computers: [],
        projects: [logical],
      }),
    ]).toEqual(["local:canonical"]);
  });
  it("rejects a foreign registration even when ID, computer and path coincide", () => {
    expect(
      resolveProjectHistoryBindings({
        ...input,
        projects: [
          {
            ...physical,
            id: native.id,
            ctoxRegistration: { ...registration, instanceId: "foreign" },
          },
        ],
      }),
    ).toEqual([]);
  });
  it("never rebinds an explicitly registered older project through an equal path", () => {
    const older = { ...physical, id: duplicate.id, ctoxRegistration: registration };
    expect([
      ...workjetProjectConversationKeys({ ...input, projects: [older], project: native }),
    ]).toEqual([]);
    expect([
      ...workjetProjectConversationKeys({ ...input, projects: [older], project: duplicate }),
    ]).toEqual(["local:older-id"]);
  });
  it("leaves an ambiguous shared working copy unresolved", () => {
    expect(
      resolveProjectHistoryBindings({
        ...input,
        nativeProjects: [
          native,
          { ...duplicate, workingCopies: [{ ...native.workingCopies[0]!, id: "other-copy" }] },
        ],
      }),
    ).toEqual([]);
  });
  it("cannot infer an unregistered folder-free history from an equal native ID", () => {
    expect(
      resolveProjectHistoryBindings({
        ...input,
        projects: [{ id: native.id, environmentId, workspaceRoot: null }],
      }),
    ).toEqual([]);
    expect(resolveProjectHistoryBindings({ ...input, instanceId: null })).toEqual([]);
  });
});
