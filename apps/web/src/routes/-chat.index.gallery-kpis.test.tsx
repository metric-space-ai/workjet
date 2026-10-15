import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PromptedProjectKpis } from "../projectKpis";
import { ProjectGallery, showsCachedProjectRegistryNotice } from "./_chat.index";

const kpiReads: string[] = [];
let kpiResult: "fail" | "ok" | "hang" = "fail";
let releaseHang: (() => void) | undefined;

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
      if (kpiResult === "hang")
        await new Promise<void>((resolve) => {
          releaseHang = resolve;
        });
      if (kpiResult === "fail") return { _tag: "failed" as const, code: "timeout" as const };
      return { _tag: "completed" as const, response: { kpis: readyKpis(String(projectId)) } };
    },
  };
});

class DomNode {
  nodeType: number;
  nodeName: string;
  tagName: string;
  childNodes: DomNode[] = [];
  parentNode: DomNode | null = null;
  attributes: Record<string, string> = {};
  style: Record<string, string> = {};
  ownerDocument: DomDocument | null = null;
  data = "";
  namespaceURI = "http://www.w3.org/1999/xhtml";
  className = "";
  lang = "";
  constructor(tag: string) {
    this.nodeType = tag === "#text" ? 3 : 1;
    this.nodeName = tag === "#text" ? "#text" : tag.toUpperCase();
    this.tagName = this.nodeName;
  }
  get nextSibling(): DomNode | null {
    const parent = this.parentNode;
    if (!parent) return null;
    const index = parent.childNodes.indexOf(this);
    return parent.childNodes[index + 1] ?? null;
  }
  get firstChild(): DomNode | null {
    return this.childNodes[0] ?? null;
  }
  get textContent(): string {
    return this.nodeType === 3
      ? this.data
      : this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(value: string) {
    this.childNodes = [];
    if (value) {
      const text = new DomNode("#text");
      text.data = String(value);
      this.appendChild(text);
    }
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = String(value);
    if (name === "class") this.className = String(value);
  }
  getAttribute(name: string) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]!
      : null;
  }
  hasAttribute(name: string) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name);
  }
  removeAttribute(name: string) {
    delete this.attributes[name];
  }
  appendChild(child: DomNode) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  insertBefore(child: DomNode, ref: DomNode | null) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    const index = ref ? this.childNodes.indexOf(ref) : -1;
    if (index < 0) this.childNodes.push(child);
    else this.childNodes.splice(index, 0, child);
    return child;
  }
  removeChild(child: DomNode) {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  contains(child: DomNode): boolean {
    if (child === this) return true;
    return this.childNodes.some((node) => node.contains(child));
  }
  addEventListener() {}
  removeEventListener() {}
  focus() {}
  blur() {}
  getBoundingClientRect() {
    return {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      toJSON() {
        return {};
      },
    };
  }
  get classList() {
    const node = this;
    return {
      add(...tokens: string[]) {
        const current = new Set(node.className.split(/\s+/u).filter(Boolean));
        for (const token of tokens) current.add(token);
        node.className = [...current].join(" ");
        node.attributes.class = node.className;
      },
      remove(...tokens: string[]) {
        const drop = new Set(tokens);
        node.className = node.className
          .split(/\s+/u)
          .filter((token) => token && !drop.has(token))
          .join(" ");
        node.attributes.class = node.className;
      },
      contains(token: string) {
        return node.className.split(/\s+/u).includes(token);
      },
      toggle(token: string) {
        if (this.contains(token)) this.remove(token);
        else this.add(token);
      },
    };
  }
}

interface DomDocument {
  visibilityState: DocumentVisibilityState;
  activeElement: DomNode | null;
  documentElement: DomNode;
  body: DomNode;
  defaultView: typeof globalThis;
  createElement(tag: string): DomNode;
  createElementNS(_ns: string, tag: string): DomNode;
  createTextNode(text: string): DomNode;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

function installDom() {
  const listeners = new Map<string, Set<EventListener>>();
  const document: DomDocument = {
    visibilityState: "visible",
    activeElement: null,
    documentElement: null as unknown as DomNode,
    body: null as unknown as DomNode,
    defaultView: globalThis,
    createElement(tag: string) {
      const node = new DomNode(tag);
      node.ownerDocument = document;
      return node;
    },
    createElementNS(_ns: string, tag: string): DomNode {
      return document.createElement(tag);
    },
    createTextNode(text: string) {
      const node = new DomNode("#text");
      node.data = String(text);
      node.ownerDocument = document;
      return node;
    },
    addEventListener(type: string, listener: EventListener) {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
  };
  document.documentElement = document.createElement("html");
  document.documentElement.lang = "de";
  document.body = document.createElement("body");
  globalThis.document = document as unknown as Document;
  globalThis.window = globalThis as unknown as Window & typeof globalThis;
  globalThis.HTMLElement = DomNode as unknown as typeof HTMLElement;
  globalThis.Element = DomNode as unknown as typeof Element;
  globalThis.Node = DomNode as unknown as typeof Node;
  globalThis.HTMLIFrameElement = class {} as unknown as typeof HTMLIFrameElement;
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  return document;
}

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

describe("gallery KPI failures", () => {
  let document: ReturnType<typeof installDom>;
  let container: DomNode;
  let root: Root;

  beforeEach(() => {
    kpiReads.length = 0;
    kpiResult = "fail";
    releaseHang = undefined;
    document = installDom();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container as unknown as Element);
  });

  afterEach(async () => {
    releaseHang?.();
    await act(async () => {
      root.unmount();
    });
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
    expect(kpiReads.length).toBeGreaterThan(0);
    expect(html).not.toContain("nicht geladen");
    expect(html).not.toContain("Erneut versuchen");
    expect(html).not.toContain("could not be loaded");
    // Unknown KPI values drop out entirely; no „—“ placeholder (Feinschliff WP-K2).
    expect(html).not.toContain("—");
  });

  it("retries a failed read once after 15s and then fills the tile", async () => {
    vi.useFakeTimers();
    await render(gallery());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(kpiReads).toEqual(["p1"]);
    kpiResult = "ok";
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });
    expect(kpiReads).toEqual(["p1"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(kpiReads).toEqual(["p1", "p1"]);
    expect(container.textContent).toContain("412");
    expect(container.textContent).not.toContain("nicht geladen");
    expect(container.textContent).not.toContain("Erneut versuchen");
  });

  it("does not retry while the window is hidden", async () => {
    vi.useFakeTimers();
    document.visibilityState = "hidden";
    await render(gallery());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(kpiReads).toEqual(["p1"]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(kpiReads).toEqual(["p1"]);
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
