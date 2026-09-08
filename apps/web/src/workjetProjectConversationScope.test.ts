import {
  EnvironmentId,
  ProjectId,
  WorkjetComputerId,
  type CtoxWorkjetProjectProjection,
  type WorkjetComputer,
} from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { workjetProjectConversationKeys } from "./workjetProjectConversationScope";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const computers: WorkjetComputer[] = [
  {
    id: WorkjetComputerId.make("local-computer"),
    environmentId: local,
    label: "Local",
    presentationKind: "local",
    harnesses: [],
  },
  {
    id: WorkjetComputerId.make("remote-computer"),
    environmentId: remote,
    label: "Remote",
    presentationKind: "remote",
    harnesses: [],
  },
];
const project: CtoxWorkjetProjectProjection = {
  id: ProjectId.make("logical-project"),
  title: "Selected project",
  workingCopies: [
    { id: "local-copy", computerId: "local-computer", path: "/work/project", status: "active" },
  ],
};
const projects = [
  { id: ProjectId.make("physical-project"), environmentId: local, workspaceRoot: "/work/project/" },
  { id: ProjectId.make("other-project"), environmentId: local, workspaceRoot: "/work/other" },
  {
    id: ProjectId.make("same-path-other-host"),
    environmentId: remote,
    workspaceRoot: "/work/project",
  },
];

describe("one project's conversation scope", () => {
  it("includes physical histories and logical drafts without exposing other projects or hosts", () => {
    expect([...workjetProjectConversationKeys({ project, computers, projects })]).toEqual([
      "local:physical-project",
      "local:logical-project",
    ]);
  });

  it("has no all-project fallback before a project is chosen", () => {
    expect(workjetProjectConversationKeys({ project: null, computers, projects }).size).toBe(0);
  });

  it("excludes detached copies and unknown computers", () => {
    expect(
      workjetProjectConversationKeys({
        project: {
          ...project,
          workingCopies: project.workingCopies.map((copy) => ({ ...copy, status: "detached" })),
        },
        computers,
        projects,
      }).size,
    ).toBe(0);
    expect(workjetProjectConversationKeys({ project, computers: [], projects }).size).toBe(0);
  });

  it("adds another host only through an explicit active working copy", () => {
    const twoCopies = {
      ...project,
      workingCopies: [
        ...project.workingCopies,
        {
          id: "remote-copy",
          computerId: "remote-computer",
          path: "/work/project",
          status: "active" as const,
        },
      ],
    };
    expect([
      ...workjetProjectConversationKeys({ project: twoCopies, computers, projects }),
    ]).toEqual([
      "local:physical-project",
      "local:logical-project",
      "remote:same-path-other-host",
      "remote:logical-project",
    ]);
  });

  it("does not treat a coincidentally equal project ID as a working-copy binding", () => {
    expect(
      workjetProjectConversationKeys({
        project,
        computers,
        projects: [{ id: project.id, environmentId: remote, workspaceRoot: "/work/project" }],
      }).size,
    ).toBe(0);
  });
});
