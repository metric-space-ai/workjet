// Scheibe C: project overview sources and the project registry follow the local kernel on a V4
// instance and keep the desktop port on V3.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopCtoxBridge } from "@workjet/contracts";
import { installDom } from "../test/localReactDom";
import { useProjectOverviewSources } from "../hooks/useProjectOverviewSources";
import { subscribeWorkjetProjectRegistryLive } from "../workjetProjectRegistry";
import { closeV4Kernels, openV4 } from "./v4TestCore";

afterEach(closeV4Kernels);

type Sources = ReturnType<typeof useProjectOverviewSources>;
async function renderOverview(instanceId: string, projectId: string) {
  installDom();
  const root = createRoot(document.createElement("div"));
  const seen: { current: Sources | null } = { current: null };
  function Probe() {
    seen.current = useProjectOverviewSources(instanceId, projectId);
    return null;
  }
  await act(async () => root.render(createElement(Probe)));
  return { seen, unmount: () => act(async () => root.unmount()) };
}

describe("V4 gate: project overview sources", () => {
  it("V4: KPIs and feed come from the local kernel, no desktop port", async () => {
    installDom();
    const requestProjectControl = vi.fn();
    window.desktopBridge = {
      ctox: { requestProjectControl } as unknown as DesktopCtoxBridge,
    } as typeof window.desktopBridge;
    const { instanceId, seed } = await openV4();
    await seed("workjet_project_kpis", [{ id: "p-1", project_id: "p-1", revision: 7, items: [] }]);
    const view = await renderOverview(instanceId, "p-1");
    await vi.waitFor(() => expect(view.seen.current?.kpis?.revision).toBe(7));
    expect(view.seen.current?.failed).toBe(false);
    expect(requestProjectControl).not.toHaveBeenCalled();
    await view.unmount();
  });

  it("V3: the overview reads KPIs through the desktop port", async () => {
    installDom();
    const requestProjectControl = vi.fn(async () => ({
      _tag: "failed" as const,
      code: "not_active" as const,
    }));
    window.desktopBridge = {
      ctox: { requestProjectControl } as unknown as DesktopCtoxBridge,
    } as typeof window.desktopBridge;
    const instanceId = `v3-overview-${Date.now()}`;
    const { commitActiveWorkjetSelection } = await import("../activeWorkjetScope");
    commitActiveWorkjetSelection(instanceId);
    const view = await renderOverview(instanceId, "p-1");
    await vi.waitFor(() =>
      expect(requestProjectControl).toHaveBeenCalledWith(
        instanceId,
        expect.objectContaining({ action: "project.kpis.read", projectId: "p-1" }),
      ),
    );
    await view.unmount();
  });
});

describe("V4 gate: project registry live refresh", () => {
  it("V4: a local project change refreshes the registry", async () => {
    const { instanceId, seed } = await openV4();
    const refresh = vi.fn();
    const stop = subscribeWorkjetProjectRegistryLive(instanceId, refresh);
    refresh.mockClear();
    await seed("workjet_projects", [
      { id: "p-live", title: "Live", workingCopies: [], status: "active" },
    ]);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    stop();
  });

  it("V3: no binding, no subscription; another instance mounting V4 does not refresh it", async () => {
    const instanceId = `v3-registry-${Date.now()}`;
    const refresh = vi.fn();
    const stop = subscribeWorkjetProjectRegistryLive(instanceId, refresh);
    expect(refresh).not.toHaveBeenCalled();
    // A different instance becoming V4 does not touch this V3 registry.
    await openV4(false);
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });
});
