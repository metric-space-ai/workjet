import { describe, expect, it, vi } from "vite-plus/test";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  WorkjetComputerId,
  type CtoxWorkjetProjectProjection,
} from "@workjet/contracts";
import { type WorkjetProjectControlPort } from "./workjetProjectControl";
import { syncWorkjetProjectTitle } from "./workjetProjectRename";

const native: CtoxWorkjetProjectProjection = {
  id: ProjectId.make("canonical"),
  title: "Original name",
  createdAt: "2026-10-02T00:00:00.000Z",
  workingCopies: [
    {
      id: "copy",
      computerId: WorkjetComputerId.make("computer"),
      path: "/source",
      status: "active",
    },
  ],
};
const physical = {
  id: ProjectId.make("retained-history"),
  environmentId: EnvironmentId.make("local"),
  workspaceRoot: "/source",
};
const computer = {
  id: WorkjetComputerId.make("computer"),
  environmentId: physical.environmentId,
  label: "Local",
  presentationKind: "local" as const,
  harnesses: [],
};
const base = {
  instanceId: "managed:own",
  nativeProjects: [native],
  projects: [physical],
  computers: [computer],
  title: "Renamed",
};
const confirmed = { ...native, title: "Renamed" };

describe("authoritative existing-project rename", () => {
  it("upserts the proven canonical ID while preserving physical history and working copies", async () => {
    const port = vi.fn<WorkjetProjectControlPort>().mockResolvedValue({
      _tag: "completed",
      response: { action: "project.create", project: confirmed },
    });
    await expect(syncWorkjetProjectTitle({ ...base, port })).resolves.toEqual([confirmed]);
    expect(port).toHaveBeenCalledOnce();
    expect(port.mock.calls[0]?.[0]).toBe("managed:own");
    const request = port.mock.calls[0]?.[1];
    expect(request).toMatchObject({
      action: "project.create",
      projectId: "canonical",
      title: "Renamed",
      createdAt: native.createdAt,
    });
    expect(request).not.toHaveProperty("workingCopy");
    expect(physical.id).toBe("retained-history");
    expect(native.title).toBe("Original name");
    expect(confirmed.workingCopies).toBe(native.workingCopies);
  });
  it("deduplicates two registered physical checkouts and makes an already confirmed retry a no-op", async () => {
    const registration = {
      instanceId: base.instanceId,
      commandId: CommandId.make("original-create"),
      status: "pending" as const,
    };
    const projects = [
      { ...physical, id: native.id, ctoxRegistration: registration },
      {
        ...physical,
        id: native.id,
        environmentId: EnvironmentId.make("other"),
        ctoxRegistration: registration,
      },
    ];
    const port = vi.fn<WorkjetProjectControlPort>().mockResolvedValue({
      _tag: "completed",
      response: { action: "project.create", project: confirmed },
    });
    await expect(syncWorkjetProjectTitle({ ...base, projects, port })).resolves.toEqual([
      confirmed,
    ]);
    expect(port).toHaveBeenCalledOnce();
    port.mockClear();
    await expect(
      syncWorkjetProjectTitle({ ...base, projects, nativeProjects: [confirmed], port }),
    ).resolves.toEqual([]);
    expect(port).not.toHaveBeenCalled();
  });
  it("does not infer a native identity from a foreign registration or ambiguous shared path", async () => {
    const port = vi.fn<WorkjetProjectControlPort>();
    const foreign = {
      ...physical,
      id: native.id,
      ctoxRegistration: {
        instanceId: "managed:foreign",
        commandId: CommandId.make("foreign"),
        status: "pending" as const,
      },
    };
    await expect(syncWorkjetProjectTitle({ ...base, projects: [foreign], port })).resolves.toEqual(
      [],
    );
    await expect(
      syncWorkjetProjectTitle({
        ...base,
        nativeProjects: [native, { ...native, id: ProjectId.make("other-canonical") }],
        port,
      }),
    ).resolves.toEqual([]);
    expect(port).not.toHaveBeenCalled();
  });
  it("rejects an unresolved registered project without creating a replacement", async () => {
    const port = vi.fn<WorkjetProjectControlPort>();
    const pending = {
      ...physical,
      id: native.id,
      ctoxRegistration: {
        instanceId: base.instanceId,
        commandId: CommandId.make("pending"),
        status: "pending" as const,
      },
    };
    await expect(
      syncWorkjetProjectTitle({ ...base, projects: [pending], nativeProjects: [], port }),
    ).rejects.toThrow("Reconnect");
    expect(port).not.toHaveBeenCalled();
  });
  it("refuses a successful response for a different project or an unconfirmed name", async () => {
    for (const project of [{ ...confirmed, id: ProjectId.make("foreign") }, native]) {
      const port = vi.fn<WorkjetProjectControlPort>().mockResolvedValue({
        _tag: "completed",
        response: { action: "project.create", project },
      });
      await expect(syncWorkjetProjectTitle({ ...base, port })).rejects.toThrow(
        "different project or name",
      );
    }
  });
  it("propagates a native failure instead of claiming synchronized metadata", async () => {
    const port = vi
      .fn<WorkjetProjectControlPort>()
      .mockResolvedValue({ _tag: "failed", code: "guest_failed" });
    await expect(syncWorkjetProjectTitle({ ...base, port })).rejects.toThrow("guest_failed");
    expect(port).toHaveBeenCalledOnce();
    expect(native.title).toBe("Original name");
  });
  it("leaves standalone local projects local", async () => {
    const port = vi.fn<WorkjetProjectControlPort>();
    await expect(syncWorkjetProjectTitle({ ...base, instanceId: null, port })).resolves.toEqual([]);
    expect(port).not.toHaveBeenCalled();
  });
});
