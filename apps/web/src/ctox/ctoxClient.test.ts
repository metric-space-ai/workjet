import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ProjectId, CommandId } from "@workjet/contracts";
import { bindCtoxClient, getCtoxClient } from "./ctoxClient";
import { openStubCtoxClient } from "./stubClient";
import { createLiveStore } from "./liveStore";
import {
  listWorkjetProjects,
  readWorkjetProjectKpis,
  requestWorkjetProjectControl,
} from "../workjetProjectControl";

const hosts: Awaited<ReturnType<typeof openStubCtoxClient>>[] = [];
let userId = "";
let fixtureId = 0;
beforeEach(() => {
  userId = `fixture-${++fixtureId}`;
});
async function host(instanceId: string = `instance-${++fixtureId}`) {
  const next = await openStubCtoxClient({
    instanceId,
    userId,
    appVersion: "p11-a-fixture",
    storage: "memory",
    multiTab: false,
    latencyMs: 0,
  });
  hosts.push(next);
  return next;
}
afterEach(async () => {
  for (const next of hosts.splice(0)) await next.close();
});

describe("Workjet App API 4.0 local data", () => {
  it("reads every active project offline without a row cap or a transport call", async () => {
    const { api, kernel } = await host("a");
    await kernel.sim.push(
      "workjet_projects",
      Array.from({ length: 125 }, (_, n) => ({
        id: `p-${n}`,
        title: `Project ${n}`,
        workingCopies: [],
        status: n === 0 ? "archived" : "active",
      })),
    );
    await kernel.sim.setLink({ state: "offline", rtt_ms: 0, relay: false });
    const port = vi.fn();
    const result = await listWorkjetProjects("a", port);
    expect(result._tag).toBe("completed");
    if (result._tag !== "completed" || result.response.action !== "project.list")
      throw new Error("missing local projects");
    expect(result.response.count).toBe(124);
    expect(result.response.projects).toHaveLength(124);
    expect(result.response.projects.some((p) => p.id === "p-0")).toBe(false);
    expect(port).not.toHaveBeenCalled();
    expect(api.metrics.get().link.state).toBe("offline");
  });

  it("keeps instance data separate and reads the latest local KPI revision", async () => {
    const a = await host("a");
    const b = await host("b");
    await a.kernel.sim.push("workjet_project_kpis", [
      { id: "p", project_id: "p", revision: 1, items: [] },
    ]);
    await b.kernel.sim.push("workjet_project_kpis", [
      { id: "p", project_id: "p", revision: 9, items: [] },
    ]);
    const request = {
      action: "project.kpis.read",
      projectId: ProjectId.make("p"),
      commandId: CommandId.make("correlation"),
    } as const;
    const port = vi.fn();
    expect(await requestWorkjetProjectControl("a", request, port)).toMatchObject({
      response: { commandId: "correlation", kpis: { revision: 1 } },
    });
    expect(await readWorkjetProjectKpis("b", ProjectId.make("p"))).toMatchObject({
      response: { kpis: { revision: 9 } },
    });
    await a.kernel.sim.push("workjet_project_kpis", [
      { id: "p", project_id: "p", revision: 2, items: [] },
    ]);
    expect(await readWorkjetProjectKpis("a", ProjectId.make("p"))).toMatchObject({
      response: { kpis: { revision: 2 } },
    });
    expect(port).not.toHaveBeenCalled();
  });

  it("does not synthesize a KPI value, and rejects a document bound to another project", async () => {
    const a = await host("a");
    expect(await readWorkjetProjectKpis("a", ProjectId.make("missing"))).toMatchObject({
      response: { kpis: { revision: 0, items: [] } },
    });
    await a.kernel.sim.push("workjet_project_kpis", [
      { id: "p", project_id: "other", revision: 2, items: [] },
    ]);
    await expect(readWorkjetProjectKpis("a", ProjectId.make("p"))).rejects.toThrow(
      "invalid_kpi_scope",
    );
  });

  it("subscribes immediately, keeps React snapshots stable, pushes updates and unsubscribes", async () => {
    const { api, kernel } = await host();
    const store = createLiveStore(api.query<{ id: string }>("workjet_projects", {}));
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    const changed = vi.fn();
    const off = store.subscribe(changed);
    const second = vi.fn();
    const offSecond = store.subscribe(second);
    expect(changed).not.toHaveBeenCalled();
    await kernel.sim.push("workjet_projects", [{ id: "p" }]);
    await Promise.resolve();
    expect(store.getSnapshot()).toEqual([{ id: "p" }]);
    expect(changed).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    off();
    await kernel.sim.push("workjet_projects", [{ id: "q" }]);
    await Promise.resolve();
    expect(changed).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    offSecond();
  });

  it("persists a local projection across stub reopen and keeps commands durable offline", async () => {
    const first = await host("retained");
    await first.kernel.sim.push("workjet_projects", [
      { id: "p", title: "Retained", workingCopies: [], status: "active" },
    ]);
    await first.close();
    const next = await host("retained");
    expect(await listWorkjetProjects("retained")).toMatchObject({ response: { count: 1 } });
    await next.kernel.sim.setLink({ state: "offline", rtt_ms: 0, relay: false });
    const command = next.api.command("ctox.workjet.project.kpis.refresh", { project_id: "p" });
    await command.local;
    expect(command.status.get().status).toBe("queued");
    expect(command.cancel()).toBe(true);
    expect(await command.result).toMatchObject({ status: "rejected", reason: "cancelled" });
  });

  it("does not let stale unmount dispose a replacement client", async () => {
    const first = await host("same");
    const other = await host("same");
    await first.close();
    expect(getCtoxClient("same")).toBe(other.api);
    await other.close();
    expect(getCtoxClient("same")).toBeNull();
  });

  it("rejects reusing one instance API under another instance name", async () => {
    const { api } = await host("source");
    expect(() => bindCtoxClient("other", api)).toThrow("invalid_ctox_instance_scope");
    expect(getCtoxClient("other")).toBeNull();
  });

  it("allows remounting the same API without an old cleanup removing it", async () => {
    const { api } = await host("remount");
    const first = bindCtoxClient("remount", api);
    const second = bindCtoxClient("remount", api);
    first();
    expect(getCtoxClient("remount")).toBe(api);
    second();
    expect(getCtoxClient("remount")).toBeNull();
  });
});
