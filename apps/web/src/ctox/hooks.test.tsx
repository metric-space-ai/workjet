import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { useCtoxCommand, useCtoxDoc, useCtoxMetrics, useCtoxQuery } from "./hooks";
import { openStubCtoxClient } from "./stubClient";
import { bindCtoxClient, type CtoxAppApi, type LiveDoc, type Query } from "./ctoxClient";
import { installDom } from "../test/localReactDom";

let host: Awaited<ReturnType<typeof openStubCtoxClient>> | undefined;
afterEach(async () => {
  await host?.close();
  host = undefined;
});

function Probe({ instanceId }: { instanceId: string }) {
  const rows = useCtoxQuery<{ id: string; title: string }>(instanceId, "workjet_projects", {
    selector: { status: "active" },
  });
  const doc = useCtoxDoc<{ title: string }>(instanceId, "workjet_projects", "p");
  const metrics = useCtoxMetrics(instanceId);
  const { status } = useCtoxCommand(instanceId);
  return createElement("output", null, JSON.stringify({ rows, doc, metrics, status }));
}

describe("App API hooks local first render", () => {
  it("exposes local rows, document and offline metrics in the initial render without effects", async () => {
    host = await openStubCtoxClient({
      instanceId: "hook-fixture",
      userId: "owner",
      appVersion: "p11-a-fixture",
      storage: "memory",
      multiTab: false,
    });
    await host.kernel.sim.push("workjet_projects", [
      { id: "p", title: "Local before network", status: "active" },
    ]);
    await host.kernel.sim.setLink({ state: "offline", rtt_ms: 0, relay: false });
    const html = renderToStaticMarkup(createElement(Probe, { instanceId: "hook-fixture" }));
    expect(html).toContain("Local before network");
    expect(html).toContain("offline");
    expect(html).toContain("&quot;status&quot;:null");
  });

  it("does not leak another instance's snapshot when no client is bound", async () => {
    host = await openStubCtoxClient({
      instanceId: "private",
      userId: "owner",
      appVersion: "p11-a-fixture",
      storage: "memory",
      multiTab: false,
    });
    await host.kernel.sim.push("workjet_projects", [
      { id: "p", title: "Do not leak", status: "active" },
    ]);
    const html = renderToStaticMarkup(createElement(Probe, { instanceId: "unbound" }));
    expect(html).not.toContain("Do not leak");
    expect(html).toContain("&quot;rows&quot;:[]");
    expect(html).toContain("&quot;metrics&quot;:null");
  });

  it("releases every live subscription on scope change and unmount; a command stays durable", async () => {
    installDom();
    host = await openStubCtoxClient({
      instanceId: "lifecycle",
      userId: "lifecycle-owner",
      appVersion: "p11-a-fixture",
      storage: "memory",
      multiTab: false,
    });
    await host.kernel.sim.setLink({ state: "offline", rtt_ms: 0, relay: false });
    const api = host.api;
    let subscriptions = 0;
    function track<T>(live: LiveDoc<T>): LiveDoc<T> {
      return {
        get: () => live.get(),
        subscribe: (callback) => {
          subscriptions++;
          const off = live.subscribe(callback);
          return () => {
            subscriptions--;
            off();
          };
        },
      };
    }
    const counted: CtoxAppApi = {
      ...api,
      query: <T,>(collection: string, query: Query) => track(api.query<T>(collection, query)),
      get: <T,>(collection: string, id: string) => track(api.get<T>(collection, id)),
      metrics: track(api.metrics),
      command: (type, payload) => {
        const handle = api.command(type, payload);
        return { ...handle, status: track(handle.status) };
      },
    };
    const off = bindCtoxClient("lifecycle", counted);
    let controls: ReturnType<typeof useCtoxCommand> | undefined;
    let observed: { rows: { id: string }[]; doc: unknown; backlog: number | undefined } | undefined;
    function LiveProbe({ instanceId }: { instanceId: string }) {
      const rows = useCtoxQuery<{ id: string }>(instanceId, "workjet_projects", {});
      const doc = useCtoxDoc(instanceId, "workjet_projects", "p");
      const metrics = useCtoxMetrics(instanceId);
      observed = { rows, doc, backlog: metrics?.backlog };
      controls = useCtoxCommand(instanceId);
      return createElement("output", null, JSON.stringify(rows));
    }
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(createElement(LiveProbe, { instanceId: "lifecycle" })));
      expect(subscriptions).toBe(3);
      await act(async () => {
        await host!.kernel.sim.setBacklog(7);
      });
      expect(observed!.backlog).toBe(7);
      let write: ReturnType<CtoxAppApi["put"]> | undefined;
      await act(async () => {
        write = api.put("workjet_projects", { id: "p", title: "Locally queued" });
        await write.local;
      });
      expect(observed!.rows).toEqual([{ id: "p", title: "Locally queued" }]);
      expect(observed!.doc).toEqual({ id: "p", title: "Locally queued" });
      expect(subscriptions).toBe(3);
      await act(async () => {
        write!.cancel();
        await write!.result;
      });
      let command: ReturnType<CtoxAppApi["command"]> | undefined;
      await act(async () => {
        command = controls!.command("ctox.workjet.project.kpis.refresh", { project_id: "p" });
        await command.local;
      });
      expect(subscriptions).toBe(4);
      expect(controls!.status?.status).toBe("queued");
      const oldCommand = controls!.command;
      await act(async () => root.render(createElement(LiveProbe, { instanceId: "unbound" })));
      expect(subscriptions).toBe(0);
      expect(controls!.status).toBeNull();
      expect(container.textContent).toBe("[]");
      expect(command!.status.get().status).toBe("queued");
      expect(() => oldCommand("ctox.workjet.project.kpis.refresh", { project_id: "p" })).toThrow(
        "ctox_client_unavailable",
      );
      await act(async () => root.render(createElement(LiveProbe, { instanceId: "lifecycle" })));
      expect(subscriptions).toBe(4);
      await act(async () => root.unmount());
      expect(subscriptions).toBe(0);
      expect(command!.status.get().status).toBe("queued");
      command!.cancel();
      await command!.result;
    } finally {
      off();
    }
  });
});
