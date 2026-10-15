import type { ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  EnvironmentId,
  ThreadId,
  WorkjetConnectionId,
  type WorkjetThreadConfig,
} from "@workjet/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { builtInCapabilityManifests } from "@metric-space-ai/workjet-capabilities";

import {
  executeWorkjetCapabilityToggle,
  GREPPY_CAPABILITY_ID,
  setWorkjetCapabilityEnabled,
  WorkjetCapabilityMenu,
  WorkjetCapabilityMenuItems,
  workjetComposerCapabilities,
  WORKJET_CODE_HOST_ADAPTER,
  WORKJET_GREPPY_DESCRIPTION,
  WORKJET_GREPPY_DISPLAY_NAME,
  WORKJET_GREPPY_FAILURE_TOAST,
  type WorkjetCapabilityMenuProps,
  workjetComposerCapabilityList,
  workjetConnectionStatusLabel,
} from "./WorkjetCapabilityMenu";

const greppyManifest = builtInCapabilityManifests.find(({ id }) => id === GREPPY_CAPABILITY_ID);

const workerConfig = {
  schemaVersion: 1,
  role: "worker",
  parent: {
    environmentId: EnvironmentId.make("environment-parent"),
    threadId: ThreadId.make("thread-parent"),
  },
  managedInstructions: "Preserve these managed instructions.",
  enabledCapabilityIds: ["web-search", "web-stack-browser"],
} as const satisfies WorkjetThreadConfig;

type InspectableElement = ReactElement<
  Readonly<Record<string, unknown>> & { readonly children?: ReactNode }
>;

const baseMenuProps: WorkjetCapabilityMenuProps = {
  greppyEnabled: false,
  busy: false,
  onGreppyEnabledChange: () => undefined,
};

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (isValidElement(node)) {
    return textContent((node as InspectableElement).props.children);
  }
  return "";
}

function findByLabel(node: ReactNode, label: string): InspectableElement {
  const visit = (current: ReactNode): InspectableElement | undefined => {
    if (Array.isArray(current)) {
      for (const child of current) {
        const found = visit(child);
        if (found) return found;
      }
    } else if (isValidElement(current)) {
      const element = current as InspectableElement;
      if (element.props["aria-label"] === label) return element;
      return visit(element.props.children);
    }
    return undefined;
  };
  const result = visit(node);
  if (!result) throw new Error(`Missing labeled control: ${label}`);
  return result;
}

describe("setWorkjetCapabilityEnabled", () => {
  it("enables Greppy while preserving every unrelated config field and capability", () => {
    const next = setWorkjetCapabilityEnabled(workerConfig, GREPPY_CAPABILITY_ID, true);

    expect(next).toEqual({
      ...workerConfig,
      enabledCapabilityIds: ["web-search", "web-stack-browser", "greppy"],
    });
    expect(next.role).toBe("worker");
    expect(next.parent).toBe(workerConfig.parent);
    expect(next.managedInstructions).toBe(workerConfig.managedInstructions);
  });

  it("disables only Greppy", () => {
    const current = {
      ...workerConfig,
      enabledCapabilityIds: ["web-search", "greppy", "web-stack-browser"],
    } satisfies WorkjetThreadConfig;

    expect(setWorkjetCapabilityEnabled(current, GREPPY_CAPABILITY_ID, false)).toEqual(workerConfig);
  });

  it("is idempotent and removes duplicate Greppy entries without changing unrelated entries", () => {
    const enabled = setWorkjetCapabilityEnabled(workerConfig, GREPPY_CAPABILITY_ID, true);
    expect(setWorkjetCapabilityEnabled(enabled, GREPPY_CAPABILITY_ID, true)).toBe(enabled);

    const duplicated = {
      ...workerConfig,
      enabledCapabilityIds: ["greppy", "web-search", "greppy", "web-stack-browser"],
    } satisfies WorkjetThreadConfig;
    expect(
      setWorkjetCapabilityEnabled(duplicated, GREPPY_CAPABILITY_ID, true).enabledCapabilityIds,
    ).toEqual(["greppy", "web-search", "web-stack-browser"]);

    expect(setWorkjetCapabilityEnabled(workerConfig, GREPPY_CAPABILITY_ID, false)).toBe(
      workerConfig,
    );
  });
});

describe("WorkjetCapabilityMenu", () => {
  it("takes every label and description from the catalog, never a local copy", () => {
    expect(greppyManifest).toBeDefined();
    expect(WORKJET_GREPPY_DISPLAY_NAME).toBe(greppyManifest?.metadata.displayName);
    expect(WORKJET_GREPPY_DESCRIPTION).toBe(greppyManifest?.metadata.description);
    expect(WORKJET_GREPPY_FAILURE_TOAST.title).toContain(
      greppyManifest?.metadata.displayName ?? "",
    );

    // Membership is resolved from the catalog for the Code host, so a manifest
    // that stops exposing the Workjet MCP adapter stops appearing here.
    const views = workjetComposerCapabilities([GREPPY_CAPABILITY_ID]);
    const greppyView = views.find(({ manifest }) => manifest.id === GREPPY_CAPABILITY_ID);
    expect(greppyView?.manifest).toBe(greppyManifest);
    expect(greppyView?.availability.status).toBe("available");
    expect(greppyView?.activated).toBe(true);
    expect(
      workjetComposerCapabilities([]).find(({ manifest }) => manifest.id === GREPPY_CAPABILITY_ID)
        ?.activated,
    ).toBe(false);
    for (const view of views) {
      expect(view.manifest.supportedAdapters).toContain(WORKJET_CODE_HOST_ADAPTER);
      expect(view.host).toBe("code");
    }
  });

  it("toggles a tool directly in the dropdown entry", () => {
    const onGreppyEnabledChange = vi.fn();
    const content = WorkjetCapabilityMenuItems({
      ...baseMenuProps,
      greppyEnabled: true,
      onGreppyEnabledChange,
    });
    const toggle = findByLabel(content, WORKJET_GREPPY_DISPLAY_NAME);
    expect(toggle.props.checked).toBe(true);
    expect(toggle.props.disabled).toBeFalsy();
    // A plain checkbox entry, never a Switch component inside the menu.
    expect(toggle.props.variant).toBeUndefined();
    (toggle.props.onCheckedChange as (checked: boolean) => void)(false);
    expect(onGreppyEnabledChange).toHaveBeenCalledWith(false);
  });

  it("names every tool in German and never passes catalog product names through", () => {
    const text = textContent(
      WorkjetCapabilityMenuItems({
        ...baseMenuProps,
        onCapabilityEnabledChange: vi.fn(),
        enabledCapabilityIds: [],
        workjetRole: "standard",
        onWorkjetRoleChange: vi.fn(),
      }),
    );
    for (const label of ["Greppy", "Websuche", "Browser", "Entscheidungszentrale"]) {
      expect(text).toContain(label);
    }
    expect(text).toContain("Instanz-Werkzeug");
    expect(text).toContain("Worker steuern");
    for (const raw of ["Orchestrator", "Decision Hub", "CTOX Business OS", "Web Search"]) {
      expect(text).not.toContain(raw);
    }
  });

  it("keeps catalog descriptions in the tooltip, never as sentences in the list", () => {
    const content = WorkjetCapabilityMenuItems(baseMenuProps);
    const toggle = findByLabel(content, WORKJET_GREPPY_DISPLAY_NAME);
    expect(toggle.props.title).toBe(WORKJET_GREPPY_DESCRIPTION);
    const list = textContent(content);
    expect(list).toContain(WORKJET_GREPPY_DISPLAY_NAME);
    expect(list).not.toContain(WORKJET_GREPPY_DESCRIPTION);
    expect(list).not.toContain("Open a row for details");
  });

  it("disables activation during an in-flight change and exposes its status", () => {
    const props = { ...baseMenuProps, busy: true };
    const content = WorkjetCapabilityMenuItems(props);
    const toggle = findByLabel(content, WORKJET_GREPPY_DISPLAY_NAME);
    expect(toggle.props.disabled).toBe(true);
    expect(toggle.props["aria-busy"]).toBe(true);
    // No status line inside the menu; busy is carried by aria-busy only.
    expect(textContent(content)).not.toContain("Aktualisiert");
    const trigger = renderToStaticMarkup(<WorkjetCapabilityMenu {...props} />);
    expect(trigger).toContain('aria-label="Werkzeuge"');
    expect(trigger).toContain('aria-busy="true"');
    expect(trigger).toContain("disabled");
    expect(
      findByLabel(
        WorkjetCapabilityMenuItems({ ...baseMenuProps, disabled: true }),
        WORKJET_GREPPY_DISPLAY_NAME,
      ).props.disabled,
    ).toBe(true);
  });

  it("is a dropdown in the bar and a submenu inside the options menu", () => {
    const markup = renderToStaticMarkup(<WorkjetCapabilityMenu {...baseMenuProps} />);
    expect(markup).toContain('aria-label="Werkzeuge"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).not.toContain("Tools for this chat");
    const compact = WorkjetCapabilityMenu({ ...baseMenuProps, compact: true });
    expect(textContent(compact)).toContain("Werkzeuge");
    // The submenu trigger is a simple entry: no "1 an" / "aus" status.
    const trigger = findByLabel(compact, "Werkzeuge");
    expect(textContent(trigger).trim()).toBe("Werkzeuge");
  });

  it("allows the root Orchestrator switch but keeps a child Luma's role managed", () => {
    const onWorkjetRoleChange = vi.fn();
    const props = {
      ...baseMenuProps,
      onCapabilityEnabledChange: vi.fn(),
      workjetRole: "standard" as const,
      onWorkjetRoleChange,
    };
    const toggle = findByLabel(WorkjetCapabilityMenuItems(props), "Worker steuern");
    expect(toggle.props.checked).toBe(false);
    (toggle.props.onCheckedChange as (checked: boolean) => void)(true);
    expect(onWorkjetRoleChange).toHaveBeenCalledWith("orchestrator");
    const managed = findByLabel(
      WorkjetCapabilityMenuItems({ ...props, workjetRole: "worker" }),
      "Worker steuern",
    );
    expect(managed.props.disabled).toBe(true);
  });

  it("offers the Decision Hub instance only when enabled", () => {
    const props = {
      ...baseMenuProps,
      onCapabilityEnabledChange: vi.fn(),
      onDecisionHubConnectionChange: vi.fn(),
    };
    const disabled = WorkjetCapabilityMenuItems({ ...props, enabledCapabilityIds: [] });
    expect(() => findByLabel(disabled, "Instanz der Entscheidungszentrale")).toThrow();
    const missing = WorkjetCapabilityMenuItems({
      ...props,
      enabledCapabilityIds: ["decision-hub"],
    });
    expect(textContent(missing)).toContain("Keine Instanz");
    expect(props.onDecisionHubConnectionChange).not.toHaveBeenCalled();
  });

  it("offers the CTOX selector separately from Decision Hub", () => {
    const props = {
      ...baseMenuProps,
      onCapabilityEnabledChange: vi.fn(),
      onCtoxBusinessOsConnectionChange: vi.fn(),
    };
    expect(() =>
      findByLabel(
        WorkjetCapabilityMenuItems({ ...props, enabledCapabilityIds: [] }),
        "Instanz des Instanz-Werkzeugs",
      ),
    ).toThrow();
    const enabled = WorkjetCapabilityMenuItems({
      ...props,
      enabledCapabilityIds: ["ctox-business-os"],
      ctoxBusinessOsConnections: [
        {
          connectionId: WorkjetConnectionId.make("ctox-dev:tenant-source"),
          instanceId: "source.ctox.dev",
          displayName: "Source instance",
          source: "ctox_dev",
          status: "ready",
          reason: null,
        },
      ],
    });
    const selector = findByLabel(enabled, "Instanz des Instanz-Werkzeugs");
    expect(textContent(selector)).toContain("Source instance");
    // The status is a tooltip, never a second text in the entry.
    expect(textContent(selector)).not.toContain("bereit");
    expect(() => findByLabel(enabled, "Instanz der Entscheidungszentrale")).toThrow();
    (selector.props.onValueChange as (value: string) => void)("ctox-dev:tenant-source");
    expect(props.onCtoxBusinessOsConnectionChange).toHaveBeenCalledWith("ctox-dev:tenant-source");
  });

  it("shows a missing source and preserves a locked thread connection", () => {
    const props = {
      ...baseMenuProps,
      onCapabilityEnabledChange: vi.fn(),
      onCtoxBusinessOsConnectionChange: vi.fn(),
      enabledCapabilityIds: ["ctox-business-os"] as const,
    };
    expect(textContent(WorkjetCapabilityMenuItems(props))).toContain("Keine Instanz");
    const locked = WorkjetCapabilityMenuItems({
      ...props,
      ctoxBusinessOsConnectionLocked: true,
      ctoxBusinessOsConnections: [
        {
          connectionId: WorkjetConnectionId.make("ctox-dev:tenant-source"),
          instanceId: "source.ctox.dev",
          displayName: "Source instance",
          source: "ctox_dev",
          status: "ready",
          reason: null,
        },
      ],
    });
    expect(textContent(locked)).not.toContain("Instanz fest");
    const selector = findByLabel(locked, "Instanz des Instanz-Werkzeugs");
    const item = (selector.props.children as ReadonlyArray<InspectableElement>)[0];
    expect(item?.props.disabled).toBe(true);
    expect(item?.props.title).toBe("Instanz fest");
  });
});

describe("executeWorkjetCapabilityToggle", () => {
  it("optimistically dispatches the complete config and retains it on success", async () => {
    const dispatch = vi.fn().mockResolvedValue(AsyncResult.success({ sequence: 1 }));
    const setVisibleConfig = vi.fn();
    const notifyFailure = vi.fn();

    const next = await executeWorkjetCapabilityToggle({
      currentConfig: workerConfig,
      capabilityId: GREPPY_CAPABILITY_ID,
      enabled: true,
      dispatch,
      setVisibleConfig,
      notifyFailure,
    });

    expect(dispatch).toHaveBeenCalledWith(next);
    expect(dispatch.mock.calls[0]?.[0]).toEqual({
      ...workerConfig,
      enabledCapabilityIds: ["web-search", "web-stack-browser", "greppy"],
    });
    expect(setVisibleConfig).toHaveBeenCalledTimes(1);
    expect(setVisibleConfig).toHaveBeenCalledWith(next);
    expect(notifyFailure).not.toHaveBeenCalled();
  });

  it("reverts and requests exactly one bounded failure toast", async () => {
    const setVisibleConfig = vi.fn();
    const notifyFailure = vi.fn();

    await executeWorkjetCapabilityToggle({
      currentConfig: workerConfig,
      capabilityId: GREPPY_CAPABILITY_ID,
      enabled: true,
      dispatch: vi
        .fn()
        .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("private server details")))),
      setVisibleConfig,
      notifyFailure,
    });

    expect(setVisibleConfig).toHaveBeenCalledTimes(2);
    expect(setVisibleConfig).toHaveBeenLastCalledWith(workerConfig);
    expect(notifyFailure).toHaveBeenCalledTimes(1);
    expect(WORKJET_GREPPY_FAILURE_TOAST).toEqual({
      type: "error",
      title: `${WORKJET_GREPPY_DISPLAY_NAME} nicht geändert`,
      data: { hideCopyButton: true },
    });
    expect(JSON.stringify(WORKJET_GREPPY_FAILURE_TOAST)).not.toContain("private server details");
  });

  it("reverts interruption failures without showing a toast", async () => {
    const setVisibleConfig = vi.fn();
    const notifyFailure = vi.fn();

    await executeWorkjetCapabilityToggle({
      currentConfig: workerConfig,
      capabilityId: GREPPY_CAPABILITY_ID,
      enabled: true,
      dispatch: vi.fn().mockResolvedValue(AsyncResult.failure(Cause.interrupt())),
      setVisibleConfig,
      notifyFailure,
    });

    expect(setVisibleConfig).toHaveBeenLastCalledWith(workerConfig);
    expect(notifyFailure).not.toHaveBeenCalled();
  });
});

/** Every string in the element tree; Menu parts cannot render standalone. */
function menuText(props: WorkjetCapabilityMenuProps): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (isValidElement(node)) {
      walk((node.props as { children?: ReactNode }).children);
    }
  };
  walk(WorkjetCapabilityMenuItems(props));
  return parts.join(" | ");
}

describe("Extras: every capability the host can activate", () => {
  it("offers the whole catalog once the caller can toggle any of it", () => {
    // web-search and web-stack-browser declare ALL_ADAPTERS, so they were
    // available to this host all along — the menu just never offered them.
    const text = menuText({
      greppyEnabled: false,
      busy: false,
      enabledCapabilityIds: ["web-search"],
      onGreppyEnabledChange: vi.fn(),
      onCapabilityEnabledChange: vi.fn(),
    });

    expect(workjetComposerCapabilityList().length).toBeGreaterThan(1);
    for (const capability of workjetComposerCapabilityList()) {
      expect(text).toContain(capability.displayName);
    }
  });

  it("shows Greppy alone when the caller wired only Greppy", () => {
    // Rendering switches a caller cannot honour would be worse than one row:
    // they would look live and silently do nothing.
    const text = menuText({
      greppyEnabled: true,
      busy: false,
      onGreppyEnabledChange: vi.fn(),
    });

    expect(text).toContain(WORKJET_GREPPY_DISPLAY_NAME);
    expect(text).not.toContain("Web Search");
  });
});

describe("worker source connection action", () => {
  const props = {
    ...baseMenuProps,
    enabledCapabilityIds: ["ctox-business-os"],
    onCapabilityEnabledChange: vi.fn(),
  };

  it("offers the normal product connect action when no connection exists", () => {
    const onConnect = vi.fn();
    const items = WorkjetCapabilityMenuItems({ ...props, onCtoxBusinessOsConnect: onConnect });
    const action = findByLabel(items, "Instanz verbinden");
    expect(action.props.disabled).toBeFalsy();
    (action.props.onClick as () => void)();
    expect(onConnect).toHaveBeenCalledOnce();
  });

  it("disables duplicate connection attempts; a failure is a toast, not a menu line", () => {
    const items = WorkjetCapabilityMenuItems({
      ...props,
      onCtoxBusinessOsConnect: vi.fn(),
      ctoxBusinessOsConnecting: true,
    });
    expect(findByLabel(items, "Instanz verbinden").props.disabled).toBe(true);
    expect(textContent(items)).toContain("Verbindet");
  });

  it("does not offer a replacement grant for a pinned thread or an unavailable desktop bridge", () => {
    const pinned = WorkjetCapabilityMenuItems({
      ...props,
      onCtoxBusinessOsConnect: vi.fn(),
      ctoxBusinessOsConnectionLocked: true,
    });
    expect(() => findByLabel(pinned, "Instanz verbinden")).toThrow();
    expect(() => findByLabel(WorkjetCapabilityMenuItems(props), "Instanz verbinden")).toThrow();
  });
});

describe("workjetConnectionStatusLabel", () => {
  it("names every connection status in German, never raw", () => {
    expect(workjetConnectionStatusLabel("ready")).toBe("bereit");
    expect(workjetConnectionStatusLabel("offline")).toBe("getrennt");
    expect(workjetConnectionStatusLabel("needs_auth")).toBe("Anmeldung nötig");
    expect(workjetConnectionStatusLabel("error")).toBe("Fehler");
    expect(workjetConnectionStatusLabel("unsupported")).toBe("nicht unterstützt");
    expect(workjetConnectionStatusLabel("something-new")).toBe("nicht verfügbar");
  });
});
