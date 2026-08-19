import type { ReactElement, ReactNode } from "react";
import { Children, isValidElement } from "react";
import { EnvironmentId, ThreadId, type WorkjetThreadConfig } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { MenuGroup } from "../ui/menu";

import {
  executeWorkjetCapabilityToggle,
  GREPPY_CAPABILITY_ID,
  setWorkjetCapabilityEnabled,
  WorkjetCapabilityMenu,
  WorkjetCapabilityMenuContent,
  WORKJET_GREPPY_FAILURE_TOAST,
  type WorkjetCapabilityMenuProps,
} from "./WorkjetCapabilityMenu";

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

function elementChildren(element: InspectableElement): InspectableElement[] {
  return Children.toArray(element.props.children).filter(isValidElement) as InspectableElement[];
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join("");
  if (isValidElement(node)) {
    return textContent((node as InspectableElement).props.children);
  }
  return "";
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
  it("exposes enabled and disabled Greppy switch states with shared-store copy", () => {
    const enabledContent = WorkjetCapabilityMenuContent({
      ...baseMenuProps,
      greppyEnabled: true,
    }) as InspectableElement;
    const enabledChildren = elementChildren(enabledContent);
    const enabledSwitch = enabledChildren[1];
    const explanation = enabledChildren[2];

    expect(enabledSwitch?.props.checked).toBe(true);
    expect(enabledSwitch?.props.disabled).toBe(false);
    expect(enabledSwitch?.props["aria-label"]).toBe("Greppy for this thread");
    expect(enabledContent.type).toBe(MenuGroup);
    expect(textContent(explanation)).toContain("activated only for this thread");
    expect(textContent(explanation)).toContain(
      "runtime and store are shared by all threads on this server",
    );
    expect(textContent(explanation)).not.toContain("/greppy");

    const disabledContent = WorkjetCapabilityMenuContent({
      ...baseMenuProps,
      disabled: true,
    }) as InspectableElement;
    const disabledSwitch = elementChildren(disabledContent)[1];
    expect(disabledSwitch?.props.checked).toBe(false);
    expect(disabledSwitch?.props.disabled).toBe(true);
  });

  it("marks the trigger busy and disables the switch during an in-flight toggle", () => {
    const menu = WorkjetCapabilityMenu({
      ...baseMenuProps,
      busy: true,
    }) as InspectableElement;
    const [trigger] = elementChildren(menu);
    const triggerControl = trigger?.props.render as InspectableElement;
    const busyContent = WorkjetCapabilityMenuContent({
      ...baseMenuProps,
      busy: true,
    }) as InspectableElement;
    const busySwitch = elementChildren(busyContent)[1];

    expect(trigger?.props["aria-busy"]).toBe(true);
    expect(trigger?.props.disabled).toBe(true);
    expect(triggerControl.props["aria-label"]).toBe("Thread tools");
    expect(busySwitch?.props.disabled).toBe(true);
    expect(busySwitch?.props["aria-busy"]).toBe(true);
  });

  it("uses the same content component in compact layouts", () => {
    const compact = WorkjetCapabilityMenu({
      ...baseMenuProps,
      compact: true,
      greppyEnabled: true,
    }) as InspectableElement;

    expect(compact.type).toBe(WorkjetCapabilityMenuContent);
    expect(compact.props.greppyEnabled).toBe(true);
    expect(compact.props.onGreppyEnabledChange).toBe(baseMenuProps.onGreppyEnabledChange);
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
      title: "Could not update Greppy",
      description: "Greppy was left unchanged for this thread.",
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
