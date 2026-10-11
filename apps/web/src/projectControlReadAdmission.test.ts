import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CommandId, ProjectId, type CtoxWorkjetProjectControlResult } from "@workjet/contracts";
import { commitActiveWorkjetSelection, readActiveWorkjetScope } from "./activeWorkjetScope";
import { readGalleryProjectKpis } from "./projectKpiProjection";
import {
  readWorkjetProjectKpis,
  requestWorkjetProjectControl,
  type WorkjetProjectControlPort,
} from "./workjetProjectControl";

const completed = {
  _tag: "completed",
  response: {
    action: "project.list",
    projects: [],
    count: 0,
    truncated: false,
  },
} as const;
afterEach(() => vi.useRealTimers());

describe("project control in-flight reads", () => {
  it("shares identical reads despite property ordering and forgets completed results", async () => {
    const pending = Promise.withResolvers<CtoxWorkjetProjectControlResult>();
    const port = vi
      .fn<WorkjetProjectControlPort>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue(completed);
    const first = requestWorkjetProjectControl(
      "own",
      { action: "project.list", includeConfiguration: true },
      port,
    );
    const second = requestWorkjetProjectControl(
      "own",
      { includeConfiguration: true, action: "project.list" },
      port,
    );
    expect(second).toBe(first);
    expect(port).toHaveBeenCalledOnce();
    pending.resolve(completed);
    await first;
    await requestWorkjetProjectControl(
      "own",
      { action: "project.list", includeConfiguration: true },
      port,
    );
    expect(port).toHaveBeenCalledTimes(2);
  });

  it("keeps instances, parameters, transport and mutations separate", async () => {
    const pending = Promise.withResolvers<CtoxWorkjetProjectControlResult>();
    const port = vi.fn<WorkjetProjectControlPort>().mockReturnValue(pending.promise);
    const other = vi.fn<WorkjetProjectControlPort>().mockReturnValue(pending.promise);
    const request = { action: "project.list" } as const;
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
      requestWorkjetProjectControl("own", { ...request, includeConfiguration: true }, port),
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
    const pending = Promise.withResolvers<CtoxWorkjetProjectControlResult>();
    const port = vi
      .fn<WorkjetProjectControlPort>()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ _tag: "failed", code: "timeout" })
      .mockResolvedValue(completed);
    const first = requestWorkjetProjectControl("own", { action: "project.list" }, port);
    const second = requestWorkjetProjectControl("own", { action: "project.list" }, port);
    const joined = Promise.allSettled([first, second]);
    pending.reject(new Error("transport closed"));
    expect((await joined).every((entry) => entry.status === "rejected")).toBe(true);
    await requestWorkjetProjectControl("own", { action: "project.list" }, port);
    expect(await requestWorkjetProjectControl("own", { action: "project.list" }, port)).toEqual(
      completed,
    );
    expect(port).toHaveBeenCalledTimes(3);
  });
});

describe("shared overview KPI admission", () => {
  it("merges two gallery rounds and the project overview, caps reads at one, and admits project.list immediately", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maximum = 0;
    const port = vi
      .fn<WorkjetProjectControlPort>()
      .mockImplementation(async (_instance, request) => {
        if (request.action === "project.list") return completed;
        if (request.action !== "project.kpis.read") throw new Error("unexpected action");
        maximum = Math.max(maximum, ++active);
        await new Promise<void>((resolve) => setTimeout(resolve, 10_000));
        active--;
        return {
          _tag: "completed",
          response: {
            ...request,
            contract: "ctox.workjet.project_kpis.v1",
            kpis: { project_id: request.projectId, revision: 0, items: [] },
          },
        };
      });
    const projects = Array.from({ length: 12 }, (_, index) => `project-${index}`);
    const read = (id: string) => readWorkjetProjectKpis("own", ProjectId.make(id), port);
    const rounds = [
      readGalleryProjectKpis(projects, read, () => true),
      readGalleryProjectKpis(projects, read, () => true),
    ];
    const overview = read(projects[0]!);
    expect(port).toHaveBeenCalledOnce();
    expect(await requestWorkjetProjectControl("own", { action: "project.list" }, port)).toEqual(
      completed,
    );
    await vi.runAllTimersAsync();
    await Promise.all([...rounds, overview]);
    expect(maximum).toBe(1);
    expect(
      port.mock.calls.filter(([, request]) => request.action === "project.kpis.read"),
    ).toHaveLength(12);
    expect(active).toBe(0);
  });

  it("preserves actual command correlation and rejects a mismatched receipt", async () => {
    const pending = Promise.withResolvers<CtoxWorkjetProjectControlResult>();
    const port = vi.fn<WorkjetProjectControlPort>().mockReturnValue(pending.promise);
    const first = readWorkjetProjectKpis("own", ProjectId.make("a"), port);
    const joined = readWorkjetProjectKpis("own", ProjectId.make("a"), port);
    expect(joined).toBe(first);
    const request = port.mock.calls[0]![1];
    if (request.action !== "project.kpis.read") throw new Error("missing read");
    pending.resolve({
      _tag: "completed",
      response: {
        ...request,
        commandId: CommandId.make("foreign"),
        contract: "ctox.workjet.project_kpis.v1",
        kpis: { project_id: "a", revision: 0, items: [] },
      },
    });
    expect(await first).toEqual({ _tag: "failed", code: "guest_failed" });
    expect(await joined).toEqual({ _tag: "failed", code: "guest_failed" });
  });

  it("drops queued reads from an old selection and keeps another instance independent", async () => {
    const original = readActiveWorkjetScope().selectedInstanceId;
    const pending = Promise.withResolvers<CtoxWorkjetProjectControlResult>();
    const port = vi.fn<WorkjetProjectControlPort>().mockReturnValue(pending.promise);
    const reads = ["a", "b", "c"].map((id) =>
      readWorkjetProjectKpis("own", ProjectId.make(id), port),
    );
    const other = readWorkjetProjectKpis("other", ProjectId.make("d"), port);
    expect(port).toHaveBeenCalledTimes(2);
    try {
      commitActiveWorkjetSelection("new-selection");
      pending.resolve({ _tag: "failed", code: "timeout" });
      expect(await reads[2]).toEqual({ _tag: "failed", code: "not_active" });
      await Promise.all([...reads, other]);
      expect(port).toHaveBeenCalledTimes(2);
    } finally {
      commitActiveWorkjetSelection(original);
    }
  });
});
