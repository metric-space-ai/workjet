import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId, ThreadId, type WorkjetThreadConfig } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { TooltipPopup } from "../ui/tooltip";
import {
  executeWorkjetRoleChange,
  setWorkjetThreadRole,
  WorkjetRoleControl,
  WorkjetRoleMenuContent,
  WORKJET_ROLE_FAILURE_TOAST,
  WORKJET_ROLE_NEXT_SESSION_HINT,
  WORKJET_SETTINGS_ROUTE,
  WORKJET_WORKER_ROLE_REASON,
  type WorkjetRoleControlProps,
} from "./WorkjetRoleControl";

const standardConfig = {
  schemaVersion: 1,
  role: "standard",
  parent: null,
  managedInstructions: "Preserve these managed instructions.",
  enabledCapabilityIds: ["greppy", "web-search"],
} as const satisfies WorkjetThreadConfig;

const workerConfig = {
  schemaVersion: 1,
  role: "worker",
  parent: {
    environmentId: EnvironmentId.make("environment-parent"),
    threadId: ThreadId.make("thread-parent"),
  },
  managedInstructions: "Implement the assigned slice.",
  enabledCapabilityIds: ["greppy"],
} as const satisfies WorkjetThreadConfig;

type InspectableElement = ReactElement<
  Readonly<Record<string, unknown>> & { readonly children?: ReactNode }
>;

const baseProps: WorkjetRoleControlProps = {
  role: "standard",
  busy: false,
  onRoleChange: () => undefined,
  onOpenSettings: () => undefined,
};

/**
 * Walks the returned element tree, following `render` props as well as
 * children, and collects every element carrying `attribute`. The composer's
 * controls hide their real button inside a Tooltip's `render` prop, so a plain
 * children walk would miss them.
 */
function collectByAttribute(node: ReactNode, attribute: string): InspectableElement[] {
  const found: InspectableElement[] = [];
  const visit = (current: ReactNode): void => {
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (!isValidElement(current)) return;
    const element = current as InspectableElement;
    if (attribute in element.props) found.push(element);
    const render = element.props["render"];
    if (render !== undefined) visit(render as ReactNode);
    visit(element.props.children as ReactNode);
  };
  visit(node);
  return found;
}

/** Collects the text of every tooltip popup in the rendered tree. */
function tooltipTexts(node: ReactNode): string[] {
  const texts: string[] = [];
  const visit = (current: ReactNode): void => {
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
      return;
    }
    if (!isValidElement(current)) return;
    const element = current as InspectableElement;
    if (element.type === TooltipPopup) {
      texts.push(textContent(element.props.children));
      return;
    }
    visit(element.props.children as ReactNode);
  };
  visit(node);
  return texts;
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (isValidElement(node)) return textContent((node as InspectableElement).props.children);
  return "";
}

function renderControl(props: WorkjetRoleControlProps): string {
  return renderToStaticMarkup(WorkjetRoleControl(props));
}

describe("setWorkjetThreadRole", () => {
  it("switches Code to Orchestrator while preserving every unrelated field", () => {
    const next = setWorkjetThreadRole(standardConfig, "orchestrator");

    expect(next).toEqual({ ...standardConfig, role: "orchestrator" });
    expect(next.parent).toBe(null);
    expect(next.managedInstructions).toBe(standardConfig.managedInstructions);
    expect(next.enabledCapabilityIds).toBe(standardConfig.enabledCapabilityIds);
  });

  it("returns the same object when the role is unchanged", () => {
    expect(setWorkjetThreadRole(standardConfig, "standard")).toBe(standardConfig);
  });

  it("never converts a worker thread, so its parent reference can never be dropped", () => {
    expect(setWorkjetThreadRole(workerConfig, "orchestrator")).toBe(workerConfig);
    expect(setWorkjetThreadRole(workerConfig, "standard")).toBe(workerConfig);
  });
});

describe("executeWorkjetRoleChange", () => {
  it("optimistically dispatches the complete config and retains it on success", async () => {
    const dispatch = vi.fn().mockResolvedValue(AsyncResult.success({ sequence: 1 }));
    const setVisibleConfig = vi.fn();
    const notifyFailure = vi.fn();

    const next = await executeWorkjetRoleChange({
      currentConfig: standardConfig,
      role: "orchestrator",
      dispatch,
      setVisibleConfig,
      notifyFailure,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(next);
    expect(dispatch.mock.calls[0]?.[0]).toEqual({
      ...standardConfig,
      role: "orchestrator",
    });
    expect(setVisibleConfig).toHaveBeenCalledTimes(1);
    expect(setVisibleConfig).toHaveBeenCalledWith(next);
    expect(notifyFailure).not.toHaveBeenCalled();
  });

  it("reverts and requests exactly one bounded failure toast", async () => {
    const setVisibleConfig = vi.fn();
    const notifyFailure = vi.fn();

    const retained = await executeWorkjetRoleChange({
      currentConfig: standardConfig,
      role: "orchestrator",
      dispatch: vi
        .fn()
        .mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("private server details")))),
      setVisibleConfig,
      notifyFailure,
    });

    expect(retained).toBe(standardConfig);
    expect(setVisibleConfig).toHaveBeenCalledTimes(2);
    expect(setVisibleConfig).toHaveBeenLastCalledWith(standardConfig);
    expect(notifyFailure).toHaveBeenCalledTimes(1);
    expect(WORKJET_ROLE_FAILURE_TOAST).toEqual({
      type: "error",
      title: "Could not change the Workjet role",
      description: "This thread kept its previous role.",
      data: { hideCopyButton: true },
    });
    expect(JSON.stringify(WORKJET_ROLE_FAILURE_TOAST)).not.toContain("private server details");
  });

  it("reverts an interrupted command without showing a toast", async () => {
    const setVisibleConfig = vi.fn();
    const notifyFailure = vi.fn();

    await executeWorkjetRoleChange({
      currentConfig: standardConfig,
      role: "orchestrator",
      dispatch: vi.fn().mockResolvedValue(AsyncResult.failure(Cause.interrupt())),
      setVisibleConfig,
      notifyFailure,
    });

    expect(setVisibleConfig).toHaveBeenLastCalledWith(standardConfig);
    expect(notifyFailure).not.toHaveBeenCalled();
  });

  it("does not dispatch at all for a worker thread", async () => {
    const dispatch = vi.fn();
    const setVisibleConfig = vi.fn();

    const retained = await executeWorkjetRoleChange({
      currentConfig: workerConfig,
      role: "orchestrator",
      dispatch,
      setVisibleConfig,
      notifyFailure: vi.fn(),
    });

    expect(retained).toBe(workerConfig);
    expect(dispatch).not.toHaveBeenCalled();
    expect(setVisibleConfig).not.toHaveBeenCalled();
  });
});

describe("WorkjetRoleControl", () => {
  it("renders a two-state radio group reflecting the current role", () => {
    const codeMarkup = renderControl(baseProps);
    expect(codeMarkup).toContain('role="radiogroup"');
    expect(codeMarkup).toContain('aria-label="Workjet thread role"');
    expect(codeMarkup).toContain('data-workjet-role="standard"');
    expect(codeMarkup).toContain('data-workjet-role="orchestrator"');
    expect(codeMarkup).not.toContain('data-workjet-role="worker"');
    expect(codeMarkup).toContain("Code");
    expect(codeMarkup).toContain("Orchestrator");

    const codeRadios = collectByAttribute(WorkjetRoleControl(baseProps), "data-workjet-role");
    expect(codeRadios.map((radio) => radio.props["data-workjet-role"])).toEqual([
      "standard",
      "orchestrator",
    ]);
    expect(codeRadios.map((radio) => radio.props["aria-checked"])).toEqual([true, false]);

    const orchestratorRadios = collectByAttribute(
      WorkjetRoleControl({ ...baseProps, role: "orchestrator" }),
      "data-workjet-role",
    );
    expect(orchestratorRadios.map((radio) => radio.props["aria-checked"])).toEqual([false, true]);
  });

  it("switches by calling back with the newly selected role and ignores the current one", () => {
    const onRoleChange = vi.fn();
    const radios = collectByAttribute(
      WorkjetRoleControl({ ...baseProps, onRoleChange }),
      "data-workjet-role",
    );

    (radios[1]?.props["onClick"] as () => void)();
    expect(onRoleChange).toHaveBeenCalledTimes(1);
    expect(onRoleChange).toHaveBeenCalledWith("orchestrator");

    (radios[0]?.props["onClick"] as () => void)();
    expect(onRoleChange).toHaveBeenCalledTimes(1);
  });

  it("shows a worker thread as a single read-only state with its reason, offering no conversion", () => {
    const markup = renderControl({ ...baseProps, role: "worker" });

    expect(markup).toContain('data-workjet-role="worker"');
    expect(markup).toContain("Worker");
    expect(markup).not.toContain('data-workjet-role="standard"');
    expect(markup).not.toContain('data-workjet-role="orchestrator"');

    const workerTree = WorkjetRoleControl({ ...baseProps, role: "worker" });
    expect(tooltipTexts(workerTree)).toContain(WORKJET_WORKER_ROLE_REASON);

    const [workerRadio, ...rest] = collectByAttribute(workerTree, "data-workjet-role");
    expect(rest).toEqual([]);
    expect(workerRadio?.props["aria-checked"]).toBe(true);
    // aria-disabled, not disabled: a disabled button emits no pointer events
    // and would swallow the tooltip that carries the reason.
    expect(workerRadio?.props["aria-disabled"]).toBe(true);
    expect(workerRadio?.props["disabled"]).toBe(false);
    expect(workerRadio?.props["onClick"]).toBeUndefined();
  });

  it("disables both radios while a config change is in flight or the thread is unavailable", () => {
    const busy = collectByAttribute(
      WorkjetRoleControl({ ...baseProps, busy: true }),
      "data-workjet-role",
    );
    expect(busy.map((radio) => radio.props["disabled"])).toEqual([true, true]);
    expect(busy.map((radio) => radio.props["aria-busy"])).toEqual([true, true]);

    const disabled = collectByAttribute(
      WorkjetRoleControl({ ...baseProps, disabled: true }),
      "data-workjet-role",
    );
    expect(disabled.map((radio) => radio.props["disabled"])).toEqual([true, true]);
  });

  it("renders a settings gear that opens the existing Workjet settings surface", () => {
    const onOpenSettings = vi.fn();
    const markup = renderControl(baseProps);
    expect(markup).toContain('data-workjet-settings-gear="true"');
    expect(markup).toContain('aria-label="Workjet settings"');

    const [gear, ...rest] = collectByAttribute(
      WorkjetRoleControl({ ...baseProps, onOpenSettings }),
      "data-workjet-settings-gear",
    );
    expect(rest).toEqual([]);
    (gear?.props["onClick"] as () => void)();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    // The gear leads to the one existing surface, never a second one.
    expect(WORKJET_SETTINGS_ROUTE).toBe("/settings/workjet");
  });
});

describe("WorkjetRoleControl compact variant", () => {
  it("delegates to the menu content used by the compact composer footer", () => {
    const compact = WorkjetRoleControl({ ...baseProps, compact: true }) as InspectableElement;

    expect(compact.type).toBe(WorkjetRoleMenuContent);
    expect(compact.props["role"]).toBe("standard");
    expect(compact.props["onRoleChange"]).toBe(baseProps.onRoleChange);
    expect(compact.props["onOpenSettings"]).toBe(baseProps.onOpenSettings);
  });

  it("offers both roles, the next-session hint, the settings item and a working switch", () => {
    const onRoleChange = vi.fn();
    const onOpenSettings = vi.fn();
    const content = WorkjetRoleMenuContent({ ...baseProps, onRoleChange, onOpenSettings });
    const text = textContent(content);

    expect(text).toContain("Workjet");
    expect(text).toContain("Code");
    expect(text).toContain("Orchestrator");
    expect(text).not.toContain("Worker");
    expect(text).toContain(WORKJET_ROLE_NEXT_SESSION_HINT);
    expect(text).toContain("Workjet settings");

    const [radioGroup] = collectByAttribute(content, "onValueChange");
    (radioGroup?.props["onValueChange"] as (value: string) => void)("orchestrator");
    expect(onRoleChange).toHaveBeenCalledExactlyOnceWith("orchestrator");

    const [settingsItem] = collectByAttribute(content, "onClick");
    (settingsItem?.props["onClick"] as () => void)();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps the worker state read-only in the compact menu too", () => {
    const onRoleChange = vi.fn();
    const content = WorkjetRoleMenuContent({
      ...baseProps,
      role: "worker",
      onRoleChange,
    });
    const text = textContent(content);

    expect(text).toContain("Worker");
    expect(text).toContain(WORKJET_WORKER_ROLE_REASON);

    const [radioGroup] = collectByAttribute(content, "onValueChange");
    (radioGroup?.props["onValueChange"] as (value: string) => void)("orchestrator");
    expect(onRoleChange).not.toHaveBeenCalled();
  });
});
