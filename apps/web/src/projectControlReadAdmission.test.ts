import { describe, expect, it, vi } from "vite-plus/test";
import { CommandId, ProjectId } from "@workjet/contracts";
import { readGalleryProjectKpis } from "./projectKpiProjection";
import { createKernel } from "./ctox/kernel/kernel.mjs";
import { KernelTransport } from "./ctox/kernel/transport.mjs";
import { bindCtoxClient } from "./ctox/ctoxClient";
import {
  readWorkjetProjectKpis,
  requestWorkjetProjectControl,
  requestWorkjetProjectControlFromExplicitHost,
  type WorkjetProjectControlPort,
} from "./workjetProjectControl";

it("reads local gallery order without a desktop read or warmup", async () => {
  const kernel = createKernel({
    instanceId: "local-admission",
    userId: "owner",
    storage: "memory",
    dbName: "p11c-admission",
    multiTab: false,
    transport: new KernelTransport(),
  });
  await kernel.ready;
  const unbind = bindCtoxClient(kernel.instanceId, kernel.appApi("workjet", "test"));
  const port = vi
    .fn<WorkjetProjectControlPort>()
    .mockResolvedValue({ _tag: "failed", code: "guest_failed" });
  const request = {
    action: "project.gallery.order.read",
    commandId: CommandId.make("first"),
  } as const;
  const deliver = (revision: number, projectIds: string[]) =>
    kernel.receivePage({
      epoch: "1",
      collection: "workjet_gallery_orders",
      scope_hash: "local",
      gen: 1,
      cursor_to: String(revision),
      complete: true,
      docs: [
        {
          id: "own",
          seq: String(revision),
          rev: String(revision),
          data: { id: "own", owner_user_id: "owner", revision, projectIds },
        },
        {
          id: "foreign",
          seq: String(revision),
          rev: String(revision),
          data: { id: "foreign", owner_user_id: "foreign", revision, projectIds: ["private"] },
        },
      ],
    });
  try {
    await deliver(1, ["p1"]);
    const [first, second] = await Promise.all([
      requestWorkjetProjectControl(kernel.instanceId, request, port),
      requestWorkjetProjectControl(
        kernel.instanceId,
        { ...request, commandId: CommandId.make("second") },
        port,
      ),
    ]);
    expect(first).toMatchObject({
      _tag: "completed",
      response: { commandId: "first", order: { revision: 1, projectIds: ["p1"] } },
    });
    expect(second).toMatchObject({
      _tag: "completed",
      response: { commandId: "second", order: { projectIds: ["p1"] } },
    });
    await deliver(2, ["p2"]);
    expect(await requestWorkjetProjectControl(kernel.instanceId, request, port)).toMatchObject({
      _tag: "completed",
      response: { order: { revision: 2, projectIds: ["p2"] } },
    });
    unbind();
    expect(
      await requestWorkjetProjectControlFromExplicitHost(kernel.instanceId, request, port),
    ).toEqual({ _tag: "failed", code: "not_active" });
    expect(port).not.toHaveBeenCalled();
  } finally {
    unbind();
    await kernel.close();
  }
});

describe("local overview KPI admission", () => {
  it("does not queue or dispatch gallery and overview reads while the V4 client is absent", async () => {
    const port = vi.fn<WorkjetProjectControlPort>();
    const projects = Array.from({ length: 12 }, (_, index) => `project-${index}`);
    const read = (id: string) => readWorkjetProjectKpis("own", ProjectId.make(id), port);
    await Promise.all([
      readGalleryProjectKpis(projects, read, () => true),
      readGalleryProjectKpis(projects, read, () => true),
      read(projects[0]!),
    ]);
    expect(port).not.toHaveBeenCalled();
    expect(await read("a")).toEqual({ _tag: "failed", code: "not_active" });
  });
});
