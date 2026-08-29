import { CommandId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { runWorkjetProjectCreation, workjetLogicalProjectId } from "./workjetProjectCreation";

const instanceId = "managed:welsch";
const projectId = ProjectId.make("11111111-1111-4111-8111-111111111111");
const commandId = CommandId.make("22222222-2222-4222-8222-222222222222");
const request = {
  action: "project.create" as const,
  commandId,
  projectId,
  title: "greppy",
  workingCopy: { computerId: "computer:mac", path: "/workspace/greppy" },
  createdAt: "2026-08-29T08:00:00.000Z",
};
const logicalRequest = {
  action: "project.create" as const,
  commandId,
  projectId,
  title: "greppy",
  createdAt: "2026-08-29T08:00:00.000Z",
};
const project = {
  id: projectId,
  title: "greppy",
  createdAt: request.createdAt,
  workingCopies: [
    {
      id: "copy:greppy",
      computerId: "computer:mac",
      path: "/workspace/greppy",
      status: "active" as const,
    },
  ],
};

describe("runWorkjetProjectCreation", () => {
  it("derives a stable instance-bound id for retrying the same folder", async () => {
    const first = await workjetLogicalProjectId(instanceId, "/workspace/greppy/");
    const retry = await workjetLogicalProjectId(instanceId, "/workspace/greppy");
    const otherInstance = await workjetLogicalProjectId("managed:other", "/workspace/greppy");

    expect(retry).toBe(first);
    expect(otherInstance).not.toBe(first);
  });

  it("returns an existing exact project without issuing a duplicate create", async () => {
    const port = vi.fn(async () => ({
      _tag: "completed" as const,
      response: { action: "project.list" as const, projects: [project] },
    }));

    await expect(
      runWorkjetProjectCreation({ presentationInstanceId: instanceId, request }, { port }),
    ).resolves.toEqual({
      _tag: "visible",
      project,
    });
    expect(port).toHaveBeenCalledTimes(1);
    expect(port).toHaveBeenCalledWith(instanceId, { action: "project.list" });
  });

  it("lists, creates, and exposes the exact authoritative projection", async () => {
    const phases: string[] = [];
    const port = vi
      .fn()
      .mockResolvedValueOnce({
        _tag: "completed",
        response: { action: "project.list", projects: [] },
      })
      .mockResolvedValueOnce({
        _tag: "completed",
        response: { action: "project.create", project },
      });

    await expect(
      runWorkjetProjectCreation(
        { presentationInstanceId: instanceId, request },
        { port, onPhase: (phase) => phases.push(phase) },
      ),
    ).resolves.toEqual({ _tag: "visible", project });
    expect(port).toHaveBeenNthCalledWith(1, instanceId, { action: "project.list" });
    expect(port).toHaveBeenNthCalledWith(2, instanceId, request);
    expect(phases).toEqual(["checking", "creating", "visible"]);
  });

  it("creates a logical project without requiring a computer working copy", async () => {
    const logicalProject = { ...project, workingCopies: [] };
    const port = vi
      .fn()
      .mockResolvedValueOnce({
        _tag: "completed",
        response: { action: "project.list", projects: [] },
      })
      .mockResolvedValueOnce({
        _tag: "completed",
        response: { action: "project.create", project: logicalProject },
      });

    await expect(
      runWorkjetProjectCreation(
        { presentationInstanceId: instanceId, request: logicalRequest },
        { port },
      ),
    ).resolves.toEqual({
      _tag: "visible",
      project: logicalProject,
    });
    expect(port).toHaveBeenNthCalledWith(2, instanceId, logicalRequest);
    expect(logicalRequest).not.toHaveProperty("workingCopy");
  });

  it("fails closed when create returns a different project", async () => {
    const port = vi
      .fn()
      .mockResolvedValueOnce({
        _tag: "completed",
        response: { action: "project.list", projects: [] },
      })
      .mockResolvedValueOnce({
        _tag: "completed",
        response: {
          action: "project.create",
          project: { ...project, id: ProjectId.make("33333333-3333-4333-8333-333333333333") },
        },
      });

    await expect(
      runWorkjetProjectCreation({ presentationInstanceId: instanceId, request }, { port }),
    ).resolves.toEqual({
      _tag: "failed",
      code: "invalid_projection",
    });
  });

  it("never calls a transport without an explicit CTOX instance", async () => {
    const port = vi.fn();
    await expect(
      runWorkjetProjectCreation({ presentationInstanceId: "", request }, { port }),
    ).resolves.toEqual({
      _tag: "failed",
      code: "not_active",
    });
    expect(port).not.toHaveBeenCalled();
  });
});
