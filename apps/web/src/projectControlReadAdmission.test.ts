import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CommandId, ProjectId, type CtoxWorkjetProjectControlResult } from "@workjet/contracts";
import { readGalleryProjectKpis } from "./projectKpiProjection";
import {
  readWorkjetProjectKpis,
  requestWorkjetProjectControl,
  type WorkjetProjectControlPort,
} from "./workjetProjectControl";

const completed = {
  _tag: "completed",
  response: {
    action: "project.feed.read",
    commandId: CommandId.make("read"),
    projectId: ProjectId.make("a"),
    contract: "ctox.workjet.project_feed.v1",
    posts: [],
    next_before_ms: null,
  },
} as const;
afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("project control in-flight reads", () => {
  it("shares identical reads despite property ordering and forgets completed results", async () => {
    const pending = deferred<CtoxWorkjetProjectControlResult>();
    const port = vi
      .fn<WorkjetProjectControlPort>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(completed);
    const first = requestWorkjetProjectControl(
      "own",
      {
        action: "project.feed.read",
        commandId: CommandId.make("read"),
        projectId: ProjectId.make("a"),
        limit: 30,
      },
      port,
    );
    const second = requestWorkjetProjectControl(
      "own",
      {
        limit: 30,
        projectId: ProjectId.make("a"),
        commandId: CommandId.make("read"),
        action: "project.feed.read",
      },
      port,
    );
    expect(second).toBe(first);
    expect(port).toHaveBeenCalledOnce();
    pending.resolve(completed);
    await first;
    await requestWorkjetProjectControl(
      "own",
      {
        action: "project.feed.read",
        commandId: CommandId.make("read"),
        projectId: ProjectId.make("a"),
        limit: 30,
      },
      port,
    );
    expect(port).toHaveBeenCalledTimes(2);
  });

  it("keeps instances, parameters, transport and mutations separate", async () => {
    const pending = deferred<CtoxWorkjetProjectControlResult>();
    const port = vi.fn<WorkjetProjectControlPort>().mockReturnValue(pending.promise);
    const other = vi.fn<WorkjetProjectControlPort>().mockReturnValue(pending.promise);
    const request = {
      action: "project.feed.read",
      commandId: CommandId.make("read"),
      projectId: ProjectId.make("a"),
      limit: 30,
    } as const;
    const write = {
      action: "project.kpis.configure",
      projectId: ProjectId.make("a"),
      commandId: CommandId.make("write"),
      operationId: "save",
      expectedRevision: 0,
      prompts: [],
    } as const;
    const reads = [
      requestWorkjetProjectControl("own", request, port),
      requestWorkjetProjectControl("other", request, port),
      requestWorkjetProjectControl("own", { ...request, projectId: ProjectId.make("b") }, port),
      requestWorkjetProjectControl("own", request, other),
      requestWorkjetProjectControl("own", write, port),
      requestWorkjetProjectControl("own", write, port),
    ];
    expect(port).toHaveBeenCalledTimes(5);
    expect(other).toHaveBeenCalledOnce();
    pending.resolve(completed);
    await Promise.all(reads);
  });

  it("clears rejected and failed reads so a retry really reaches the instance", async () => {
    const pending = deferred<CtoxWorkjetProjectControlResult>();
    const port = vi
      .fn<WorkjetProjectControlPort>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ _tag: "failed", code: "timeout" })
      .mockResolvedValue(completed);
    const first = requestWorkjetProjectControl(
      "own",
      {
        action: "project.feed.read",
        commandId: CommandId.make("read"),
        projectId: ProjectId.make("a"),
        limit: 30,
      },
      port,
    );
    const second = requestWorkjetProjectControl(
      "own",
      {
        action: "project.feed.read",
        commandId: CommandId.make("read"),
        projectId: ProjectId.make("a"),
        limit: 30,
      },
      port,
    );
    const joined = Promise.allSettled([first, second]);
    pending.reject(new Error("transport closed"));
    expect((await joined).every((entry) => entry.status === "rejected")).toBe(true);
    await requestWorkjetProjectControl(
      "own",
      {
        action: "project.feed.read",
        commandId: CommandId.make("read"),
        projectId: ProjectId.make("a"),
        limit: 30,
      },
      port,
    );
    expect(
      await requestWorkjetProjectControl(
        "own",
        {
          action: "project.feed.read",
          commandId: CommandId.make("read"),
          projectId: ProjectId.make("a"),
          limit: 30,
        },
        port,
      ),
    ).toEqual(completed);
    expect(port).toHaveBeenCalledTimes(3);
  });
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
