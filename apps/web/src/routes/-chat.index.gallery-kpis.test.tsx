import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PromptedProjectKpis } from "../projectKpis";
import { ProjectGallery, showsCachedProjectRegistryNotice } from "./_chat.index";

import { installDom, type DomNode } from "../test/localReactDom";
import { openStubCtoxClient } from "../ctox/stubClient";
const kpiReads: string[] = [];

const readyKpis = (projectId: string): PromptedProjectKpis => ({
  project_id: projectId,
  revision: 2,
  items: [
    {
      prompt: { kpi_id: "kpi-1", prompt: "Weekly active users", revision: 2 },
      result: {
        status: "ready",
        snapshot: {
          project_id: projectId,
          kpi_id: "kpi-1",
          prompt_revision: 2,
          label: "Active users",
          display_value: "412",
          unit: "",
          sources: [
            {
              kind: "native_metric",
              project_id: projectId,
              connection_id: "c",
              metric_key: "u",
            },
          ],
          freshness: { calculated_at_ms: 1, refresh_at_ms: 2, fresh_until_ms: 3 },
        },
      },
    },
  ],
});

vi.mock("../workjetProjectControl", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workjetProjectControl")>();
  return {
    ...actual,
    readWorkjetProjectKpis: async (_instanceId: string, projectId: string) => {
      kpiReads.push(String(projectId));
      throw new Error("unexpected_legacy_kpi_read");
    },
  };
});

const project = {
  key: "instance:p1",
  id: "p1",
  title: "greppy.xyz",
  local: null,
  native: true,
  onOpen: () => {},
  canArchive: false,
  statistics: { chatCount: null, activeChatCount: null, lastActivityAt: null },
};

function gallery(extra: { projectsUnavailable?: boolean; lastUpdatedAt?: number } = {}) {
  return createElement(ProjectGallery, {
    instanceId: "inst-1",
    projects: [project],
    registryStatus: undefined,
    lastUpdatedAt: extra.lastUpdatedAt,
    projectsUnavailable: extra.projectsUnavailable ?? false,
    createForm: null,
  });
}

describe("cached registry notice", () => {
  const cached = {
    refreshFailed: true,
    lastUpdatedAt: Date.parse("2026-10-13T18:04:00Z"),
    projects: [{ id: "p1" }],
  };
  it("shows the quiet line only for a retained project list", () => {
    expect(showsCachedProjectRegistryNotice(cached)).toBe(true);
    expect(
      showsCachedProjectRegistryNotice({ ...cached, refreshError: { code: "guest_failed" } }),
    ).toBe(true);
  });
  it("stays hidden while a read is still running, on a slow timeout, and without a cache", () => {
    expect(showsCachedProjectRegistryNotice({ ...cached, refreshFailed: undefined })).toBe(false);
    expect(showsCachedProjectRegistryNotice({ ...cached, refreshError: { code: "timeout" } })).toBe(
      false,
    );
    expect(
      showsCachedProjectRegistryNotice({
        ...cached,
        refreshError: { diagnostic: { reason: "request_timeout" } },
      }),
    ).toBe(false);
    expect(
      showsCachedProjectRegistryNotice({
        ...cached,
        refreshError: { preparation: { reason: "navigation_timeout" } },
      }),
    ).toBe(false);
    expect(showsCachedProjectRegistryNotice({ refreshFailed: true, projects: [] })).toBe(false);
    expect(
      showsCachedProjectRegistryNotice({ refreshFailed: true, projects: [{ id: "p1" }] }),
    ).toBe(false);
  });
});

describe("gallery local KPI subscription", () => {
  let client: Awaited<ReturnType<typeof openStubCtoxClient>>;
  let fixtureId = 0;
  let document: ReturnType<typeof installDom>;
  let container: DomNode;
  let root: Root;

  beforeEach(async () => {
    kpiReads.length = 0;
    document = installDom();
    client = await openStubCtoxClient({
      instanceId: "inst-1",
      userId: `gallery-owner-${++fixtureId}`,
      appVersion: "p11-a-fixture",
      storage: "memory",
      multiTab: false,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container as unknown as Element);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    await client.close();
    vi.useRealTimers();
  });

  async function render(node: ReactElement) {
    await act(async () => {
      root.render(node);
    });
  }

  it("renders no status sentence and no retry button when KPI reads fail", async () => {
    await render(gallery());
    await act(async () => {
      await Promise.resolve();
    });
    const html = container.textContent;
    expect(kpiReads).toEqual([]);
    expect(html).not.toContain("nicht geladen");
    expect(html).not.toContain("Erneut versuchen");
    expect(html).not.toContain("could not be loaded");
    expect(html).toContain("—");
  });

  it("fills the tile on local push without any retry or network call", async () => {
    await render(gallery());
    expect(container.textContent).not.toContain("412");
    await act(async () => {
      await client.kernel.sim.push("workjet_project_kpis", [{ id: "p1", ...readyKpis("p1") }]);
    });
    expect(container.textContent).toContain("412");
    expect(kpiReads).toEqual([]);
    expect(container.textContent).not.toContain("Erneut versuchen");
  });

  it("keeps local data live while hidden and offline without retry timers", async () => {
    vi.useFakeTimers();
    document.visibilityState = "hidden";
    await act(async () => {
      await client.kernel.sim.push("workjet_project_kpis", [{ id: "p1", ...readyKpis("p1") }]);
    });
    await client.kernel.sim.setLink({ state: "offline", rtt_ms: 0, relay: false });
    await render(gallery());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(kpiReads).toEqual([]);
    expect(container.textContent).toContain("412");
  });

  it("keeps the quiet registry line for a cached list and omits it for one slow read", async () => {
    const cachedAt = Date.parse("2026-10-13T18:04:00Z");
    await render(
      gallery({
        projectsUnavailable: showsCachedProjectRegistryNotice({
          refreshFailed: true,
          lastUpdatedAt: cachedAt,
          projects: [{ id: "p1" }],
          refreshError: { code: "guest_failed" },
        }),
        lastUpdatedAt: cachedAt,
      }),
    );
    expect(container.textContent).toContain("Instanz nicht erreichbar");
    expect(container.textContent).toContain("Letzter Stand:");
    expect(container.textContent).not.toContain("nicht geladen");
    await render(
      gallery({
        projectsUnavailable: showsCachedProjectRegistryNotice({
          refreshFailed: true,
          lastUpdatedAt: cachedAt,
          projects: [{ id: "p1" }],
          refreshError: { code: "timeout" },
        }),
        lastUpdatedAt: cachedAt,
      }),
    );
    expect(container.textContent).not.toContain("Instanz nicht erreichbar");
  });
});
