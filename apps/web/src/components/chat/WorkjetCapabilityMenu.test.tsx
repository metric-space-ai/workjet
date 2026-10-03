import type { ReactElement, ReactNode } from "react";
import { isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId, ThreadId, type WorkjetThreadConfig } from "@workjet/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { builtInCapabilityManifests } from "@metric-space-ai/workjet-capabilities";

import {
  executeWorkjetCapabilityToggle,
  GREPPY_CAPABILITY_ID,
  setWorkjetCapabilityEnabled,
  WorkjetCapabilityMenu,
  WorkjetCapabilityMenuContent,
  WorkjetCapabilityDetail,
  workjetComposerCapabilities,
  WORKJET_CODE_HOST_ADAPTER,
  WORKJET_GREPPY_DESCRIPTION,
  WORKJET_GREPPY_DISPLAY_NAME,
  WORKJET_GREPPY_FAILURE_TOAST,
  type WorkjetCapabilityMenuProps,
  workjetComposerCapabilityList,
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

  it("keeps activation separate from opening settings", () => {
    const onGreppyEnabledChange = vi.fn();
    const onOpenSetting = vi.fn();
    const content = WorkjetCapabilityMenuContent({
      ...baseMenuProps,
      greppyEnabled: true,
      onGreppyEnabledChange,
      onOpenSetting,
    });
    const toggle = findByLabel(content, `${WORKJET_GREPPY_DISPLAY_NAME} for this thread`);
    const details = findByLabel(content, `${WORKJET_GREPPY_DISPLAY_NAME} settings`);
    expect(toggle.props.checked).toBe(true);
    expect(toggle.props.disabled).toBeFalsy();
    const trigger = {} as HTMLButtonElement;
    (details.props.onClick as (event: { currentTarget: HTMLButtonElement }) => void)({
      currentTarget: trigger,
    });
    expect(onOpenSetting).toHaveBeenCalledWith("greppy", trigger);
    expect(onGreppyEnabledChange).not.toHaveBeenCalled();
    (toggle.props.onCheckedChange as (checked: boolean) => void)(false);
    expect(onGreppyEnabledChange).toHaveBeenCalledWith(false);
  });

  it("shows catalog descriptions in details while keeping the list compact", () => {
    const detail = renderToStaticMarkup(
      <WorkjetCapabilityDetail {...baseMenuProps} settingId="greppy" />,
    );
    expect(detail).toContain(WORKJET_GREPPY_DESCRIPTION);
    expect(detail).toContain("activated only for this thread");
    expect(detail).toContain("runtime and store are shared by all threads on this server");
    const list = textContent(WorkjetCapabilityMenuContent(baseMenuProps));
    expect(list).toContain(WORKJET_GREPPY_DISPLAY_NAME);
    expect(list).not.toContain(WORKJET_GREPPY_DESCRIPTION);
  });

  it("disables activation during an in-flight change and exposes its status", () => {
    const props = { ...baseMenuProps, busy: true };
    const content = WorkjetCapabilityMenuContent(props);
    const toggle = findByLabel(content, `${WORKJET_GREPPY_DISPLAY_NAME} for this thread`);
    expect(toggle.props.disabled).toBe(true);
    expect(toggle.props["aria-busy"]).toBe(true);
    expect(textContent(content)).toContain("Updating…");
    const trigger = renderToStaticMarkup(<WorkjetCapabilityMenu {...props} />);
    expect(trigger).toContain('aria-label="Thread tools"');
    expect(trigger).toContain('aria-busy="true"');
    expect(trigger).toContain("disabled");
    expect(
      findByLabel(
        WorkjetCapabilityMenuContent({ ...baseMenuProps, disabled: true }),
        `${WORKJET_GREPPY_DISPLAY_NAME} for this thread`,
      ).props.disabled,
    ).toBe(true);
  });

  it("keeps a direct popup trigger in compact and full layouts", () => {
    for (const compact of [true, false]) {
      const markup = renderToStaticMarkup(
        <WorkjetCapabilityMenu {...baseMenuProps} compact={compact} />,
      );
      expect(markup).toContain('aria-label="Thread tools"');
      expect(markup).toContain("Tools");
    }
  });

  it("allows the root Orchestrator switch but keeps a child worker's role managed", () => {
    const onWorkjetRoleChange = vi.fn();
    const props = {
      ...baseMenuProps,
      onCapabilityEnabledChange: vi.fn(),
      workjetRole: "standard" as const,
      onWorkjetRoleChange,
    };
    const toggle = findByLabel(WorkjetCapabilityMenuContent(props), "Orchestrator for this thread");
    expect(toggle.props.checked).toBe(false);
    (toggle.props.onCheckedChange as (checked: boolean) => void)(true);
    expect(onWorkjetRoleChange).toHaveBeenCalledWith("orchestrator");
    const managed = findByLabel(
      WorkjetCapabilityMenuContent({ ...props, workjetRole: "worker" }),
      "Orchestrator for this thread",
    );
    expect(managed.props.disabled).toBe(true);
  });

  it("offers Decision Hub connection settings only when enabled", () => {
    const props = {
      ...baseMenuProps,
      onCapabilityEnabledChange: vi.fn(),
      onDecisionHubConnectionChange: vi.fn(),
      settingId: "decision-hub",
    };
    const disabled = renderToStaticMarkup(
      <WorkjetCapabilityDetail {...props} enabledCapabilityIds={[]} />,
    );
    expect(disabled).toContain("Enable Decision Hub");
    expect(disabled).not.toContain('aria-label="Decision Hub CTOX connection"');
    const missing = renderToStaticMarkup(
      <WorkjetCapabilityDetail {...props} enabledCapabilityIds={["decision-hub"]} />,
    );
    expect(missing).toContain("No MCP-capable CTOX connection");
    expect(missing).toContain("disabled");
    expect(props.onDecisionHubConnectionChange).not.toHaveBeenCalled();
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
      title: `Could not update ${WORKJET_GREPPY_DISPLAY_NAME}`,
      description: `${WORKJET_GREPPY_DISPLAY_NAME} was left unchanged for this thread.`,
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
  walk(WorkjetCapabilityMenuContent(props));
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
