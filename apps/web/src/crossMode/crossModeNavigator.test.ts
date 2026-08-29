import { describe, expect, it } from "vite-plus/test";

import type { WorkjetProductMode } from "@t3tools/contracts/settings";

import {
  clearCrossModeBusinessOsRequest,
  peekCrossModeBusinessOsRequest,
  requestCrossModeBusinessOsApp,
  requestCrossModeBusinessOsInstance,
  takeCrossModeBusinessOsRequest,
} from "./crossModeBusinessOsHandoff";
import {
  crossModeStepIndex,
  navigateToCrossModeTarget,
  type CrossModeNavigationOutcome,
  type CrossModeNavigatorDependencies,
} from "./crossModeNavigator";
import {
  createCrossModeSelectionMemory,
  resolveCrossModeSelection,
} from "./crossModeSelectionMemory";
import {
  crossModeTargetKey,
  decodeCrossModeTarget,
  normalizeCrossModeTarget,
  type CrossModeMode,
  type CrossModeTarget,
} from "./crossModeTarget";

const CODE_TARGET: CrossModeTarget = {
  mode: "code",
  environmentId: "environment-a",
  threadId: "thread-42",
};

const BUSINESS_OS_TARGET: CrossModeTarget = {
  mode: "business-os",
  ctoxInstanceId: "instance-alpha",
  businessOsObject: { kind: "deal", id: "deal-7", moduleId: "crm" },
};

interface Harness {
  readonly dependencies: CrossModeNavigatorDependencies;
  /** Every dependency call, in the order it actually happened. */
  readonly calls: readonly string[];
  readonly productMode: () => WorkjetProductMode;
}

function createHarness(options: {
  readonly initialMode: WorkjetProductMode;
  readonly teardownSucceeds?: boolean;
  readonly canHostBusinessOs?: boolean;
  readonly currentSelection?: Partial<Record<CrossModeMode, CrossModeTarget>>;
  readonly selectionMemory?: CrossModeNavigatorDependencies["selectionMemory"];
}): Harness {
  const calls: string[] = [];
  let productMode = options.initialMode;
  return {
    calls,
    productMode: () => productMode,
    dependencies: {
      readProductMode: () => productMode,
      setProductMode: (mode) => {
        calls.push(`set-product-mode:${mode}`);
        productMode = mode;
      },
      canHostBusinessOs: () => options.canHostBusinessOs ?? true,
      releaseBusinessOsSurface: async () => {
        calls.push("release-business-os-surface");
        return options.teardownSucceeds ?? true;
      },
      releaseCodeSurface: () => {
        calls.push("release-code-surface");
      },
      readCurrentSelection: (mode) => options.currentSelection?.[mode] ?? null,
      selectSidebarEntry: (target) => {
        calls.push(`select-sidebar-entry:${crossModeTargetKey(target)}`);
      },
      openMainSurface: (target) => {
        calls.push(`open-main-surface:${crossModeTargetKey(target)}`);
      },
      selectionMemory: options.selectionMemory ?? createCrossModeSelectionMemory(),
    },
  };
}

const before = (calls: readonly string[], earlier: string, later: string): boolean => {
  const earlierIndex = calls.indexOf(earlier);
  const laterIndex = calls.indexOf(later);
  return earlierIndex !== -1 && laterIndex !== -1 && earlierIndex < laterIndex;
};

const stepsBefore = (
  outcome: CrossModeNavigationOutcome,
  earlier: Parameters<typeof crossModeStepIndex>[1],
  later: Parameters<typeof crossModeStepIndex>[1],
): boolean => {
  const earlierIndex = crossModeStepIndex(outcome, earlier);
  const laterIndex = crossModeStepIndex(outcome, later);
  return earlierIndex !== -1 && laterIndex !== -1 && earlierIndex < laterIndex;
};

describe("navigateToCrossModeTarget — native surface detachment before mode paint", () => {
  it("detaches the CTOX guest view before Code mode is allowed to render", async () => {
    const harness = createHarness({ initialMode: "ctox" });

    const outcome = await navigateToCrossModeTarget(CODE_TARGET, harness.dependencies);

    expect(outcome.status).toBe("navigated");
    expect(outcome.switchedMode).toBe(true);
    // The native WebContentsView is gone before the product mode flips, so the
    // Code shell can never be painted underneath a live guest view.
    expect(before(harness.calls, "release-business-os-surface", "set-product-mode:code")).toBe(
      true,
    );
    // And the Code surface is only addressed after the switch.
    expect(
      before(
        harness.calls,
        "set-product-mode:code",
        `select-sidebar-entry:${crossModeTargetKey(CODE_TARGET)}`,
      ),
    ).toBe(true);
    expect(stepsBefore(outcome, "release-business-os-surface", "switch-product-mode")).toBe(true);
    expect(stepsBefore(outcome, "switch-product-mode", "select-sidebar-entry")).toBe(true);
    expect(stepsBefore(outcome, "select-sidebar-entry", "open-main-surface")).toBe(true);
    // Nothing released the Code surface: Code was the destination, not the source.
    expect(harness.calls).not.toContain("release-code-surface");
  });

  it("releases the Code thread view before anything can mount the guest", async () => {
    const harness = createHarness({ initialMode: "code" });

    const outcome = await navigateToCrossModeTarget(BUSINESS_OS_TARGET, harness.dependencies);

    expect(outcome.status).toBe("navigated");
    expect(before(harness.calls, "release-code-surface", "set-product-mode:ctox")).toBe(true);
    // Selecting the instance is what causes the guest to be created at all, so
    // it must come after the Code surface was given up.
    expect(
      before(
        harness.calls,
        "release-code-surface",
        `select-sidebar-entry:${crossModeTargetKey(BUSINESS_OS_TARGET)}`,
      ),
    ).toBe(true);
    expect(stepsBefore(outcome, "release-code-surface", "switch-product-mode")).toBe(true);
    expect(harness.calls).not.toContain("release-business-os-surface");
  });

  it("blocks the switch when the guest teardown is not confirmed", async () => {
    const harness = createHarness({ initialMode: "ctox", teardownSucceeds: false });

    const outcome = await navigateToCrossModeTarget(CODE_TARGET, harness.dependencies);

    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toBe("teardown-failed");
    expect(outcome.switchedMode).toBe(false);
    // Still in Business OS mode, with a guest that is still working.
    expect(harness.productMode()).toBe("ctox");
    expect(harness.calls).toEqual(["release-business-os-surface"]);
  });

  it("does not tear anything down for a same-mode navigation", async () => {
    const harness = createHarness({ initialMode: "code" });

    const outcome = await navigateToCrossModeTarget(
      { mode: "code", environmentId: "environment-b", threadId: "thread-9" },
      harness.dependencies,
    );

    expect(outcome.status).toBe("navigated");
    expect(outcome.switchedMode).toBe(false);
    expect(harness.calls).not.toContain("release-business-os-surface");
    expect(harness.calls).not.toContain("release-code-surface");
    expect(harness.calls).not.toContain("set-product-mode:code");
    expect(harness.calls).toEqual([
      "select-sidebar-entry:code:environment-b:thread-9",
      "open-main-surface:code:environment-b:thread-9",
    ]);
  });
});

describe("navigateToCrossModeTarget — sidebar entry and main surface per target kind", () => {
  it("addresses the Code environment and thread", async () => {
    const harness = createHarness({ initialMode: "code" });

    const outcome = await navigateToCrossModeTarget(CODE_TARGET, harness.dependencies);

    expect(outcome.target).toEqual(CODE_TARGET);
    expect(harness.calls).toEqual([
      "select-sidebar-entry:code:environment-a:thread-42",
      "open-main-surface:code:environment-a:thread-42",
    ]);
  });

  it("addresses the CTOX instance and its Business OS object", async () => {
    const harness = createHarness({ initialMode: "ctox" });

    const outcome = await navigateToCrossModeTarget(BUSINESS_OS_TARGET, harness.dependencies);

    expect(outcome.target).toEqual(BUSINESS_OS_TARGET);
    expect(harness.calls).toEqual([
      "select-sidebar-entry:business-os:instance-alpha:deal:deal-7",
      "open-main-surface:business-os:instance-alpha:deal:deal-7",
    ]);
  });

  it("strips fields that do not belong to the target's own mode", async () => {
    const harness = createHarness({ initialMode: "code" });

    const outcome = await navigateToCrossModeTarget(
      {
        mode: "code",
        environmentId: "environment-a",
        threadId: "thread-42",
        // A link minted for Code has no business addressing the CTOX sidebar.
        ctoxInstanceId: "instance-alpha",
        businessOsObject: { kind: "deal", id: "deal-7" },
      },
      harness.dependencies,
    );

    expect(outcome.target).toEqual(CODE_TARGET);
    expect(outcome.target).not.toHaveProperty("ctoxInstanceId");
    expect(outcome.target).not.toHaveProperty("businessOsObject");
  });

  it("blocks a value that is not a bounded target", async () => {
    const harness = createHarness({ initialMode: "code" });

    for (const invalid of [null, {}, { mode: "settings" }, { mode: "code", threadId: "a b c" }]) {
      const outcome = await navigateToCrossModeTarget(invalid, harness.dependencies);
      expect(outcome.status).toBe("blocked");
      expect(outcome.reason).toBe("invalid-target");
    }
    expect(harness.calls).toEqual([]);
  });

  it("blocks a Business OS target where Business OS cannot be hosted", async () => {
    const harness = createHarness({ initialMode: "code", canHostBusinessOs: false });

    const outcome = await navigateToCrossModeTarget(BUSINESS_OS_TARGET, harness.dependencies);

    expect(outcome.status).toBe("blocked");
    expect(outcome.reason).toBe("business-os-unavailable");
    expect(harness.calls).toEqual([]);
  });
});

describe("navigateToCrossModeTarget — context-preserving mode switch", () => {
  it("restores the previous Code selection when the user comes back", async () => {
    const memory = createCrossModeSelectionMemory();

    // The user is reading a thread in Code and switches to Business OS.
    const outbound = createHarness({
      initialMode: "code",
      currentSelection: { code: CODE_TARGET },
      selectionMemory: memory,
    });
    const toBusinessOs = await navigateToCrossModeTarget(
      { mode: "business-os", ctoxInstanceId: "instance-alpha" },
      outbound.dependencies,
    );
    expect(toBusinessOs.status).toBe("navigated");
    expect(toBusinessOs.steps).toContain("remember-source-selection");

    // Coming back with a bare mode link lands on the same thread again.
    const inbound = createHarness({ initialMode: "ctox", selectionMemory: memory });
    const backToCode = await navigateToCrossModeTarget({ mode: "code" }, inbound.dependencies);

    expect(backToCode.status).toBe("navigated");
    expect(backToCode.steps).toContain("restore-remembered-selection");
    expect(backToCode.target).toEqual(CODE_TARGET);
    expect(inbound.calls).toContain("select-sidebar-entry:code:environment-a:thread-42");
    expect(inbound.calls).toContain("open-main-surface:code:environment-a:thread-42");
  });

  it("restores the previous Business OS instance the same way", async () => {
    const memory = createCrossModeSelectionMemory();
    memory.remember({ mode: "business-os", ctoxInstanceId: "instance-alpha" });

    const harness = createHarness({ initialMode: "code", selectionMemory: memory });
    const outcome = await navigateToCrossModeTarget({ mode: "business-os" }, harness.dependencies);

    expect(outcome.target).toEqual({ mode: "business-os", ctoxInstanceId: "instance-alpha" });
    expect(harness.calls).toContain("select-sidebar-entry:business-os:instance-alpha::");
  });

  it("prefers an addressed link over the remembered selection", async () => {
    const memory = createCrossModeSelectionMemory();
    memory.remember(CODE_TARGET);

    const harness = createHarness({ initialMode: "code", selectionMemory: memory });
    const outcome = await navigateToCrossModeTarget(
      { mode: "code", environmentId: "environment-b", threadId: "thread-9" },
      harness.dependencies,
    );

    expect(outcome.steps).not.toContain("restore-remembered-selection");
    expect(outcome.target).toEqual({
      mode: "code",
      environmentId: "environment-b",
      threadId: "thread-9",
    });
    // …and the memory now holds the newer place.
    expect(memory.read("code")).toEqual(outcome.target);
  });

  it("keeps the memory bounded to addresses and to one slot per mode", () => {
    const memory = createCrossModeSelectionMemory();
    memory.remember(CODE_TARGET);
    memory.remember({ mode: "code", environmentId: "environment-b", threadId: "thread-9" });
    memory.remember(BUSINESS_OS_TARGET);

    expect(memory.read("code")).toEqual({
      mode: "code",
      environmentId: "environment-b",
      threadId: "thread-9",
    });
    expect(memory.read("business-os")).toEqual(BUSINESS_OS_TARGET);

    // A bare target is not worth remembering and must not erase what is there.
    memory.remember({ mode: "code" });
    expect(memory.read("code")).toEqual({
      mode: "code",
      environmentId: "environment-b",
      threadId: "thread-9",
    });

    memory.forget("code");
    expect(memory.read("code")).toBeNull();
    expect(resolveCrossModeSelection({ mode: "code" }, null)).toEqual({
      target: { mode: "code" },
      restored: false,
    });
  });
});

describe("navigateToCrossModeTarget — Business OS handoff slot", () => {
  it("files no guest request until the Code surface has been released", async () => {
    clearCrossModeBusinessOsRequest();
    const observed: Array<{ readonly after: string; readonly request: unknown }> = [];
    let productMode: WorkjetProductMode = "code";

    const outcome = await navigateToCrossModeTarget(BUSINESS_OS_TARGET, {
      readProductMode: () => productMode,
      setProductMode: (mode) => {
        productMode = mode;
        observed.push({ after: "set-product-mode", request: peekCrossModeBusinessOsRequest() });
      },
      canHostBusinessOs: () => true,
      releaseBusinessOsSurface: async () => true,
      releaseCodeSurface: () => {
        // This is the real production behaviour: drop anything left over, so
        // the only request the shell can honour is filed after this point.
        clearCrossModeBusinessOsRequest();
        observed.push({ after: "release-code-surface", request: peekCrossModeBusinessOsRequest() });
      },
      readCurrentSelection: () => null,
      selectSidebarEntry: requestCrossModeBusinessOsInstance,
      openMainSurface: requestCrossModeBusinessOsApp,
      selectionMemory: createCrossModeSelectionMemory(),
    });

    expect(outcome.status).toBe("navigated");
    // No guest could have been asked for while Code was still up.
    expect(observed).toEqual([
      { after: "release-code-surface", request: null },
      { after: "set-product-mode", request: null },
    ]);
    // The complete request is available to the shell that mounts next.
    expect(takeCrossModeBusinessOsRequest()).toEqual({
      instanceId: "instance-alpha",
      moduleId: "crm",
    });
    // One-shot: a second consumer gets nothing.
    expect(takeCrossModeBusinessOsRequest()).toBeNull();
  });

  it("ignores an app request that does not match the pending instance", () => {
    clearCrossModeBusinessOsRequest();
    requestCrossModeBusinessOsInstance({ mode: "business-os", ctoxInstanceId: "instance-alpha" });
    requestCrossModeBusinessOsApp({
      mode: "business-os",
      ctoxInstanceId: "instance-beta",
      businessOsObject: { kind: "deal", id: "deal-7", moduleId: "crm" },
    });

    expect(peekCrossModeBusinessOsRequest()).toEqual({ instanceId: "instance-alpha" });
    clearCrossModeBusinessOsRequest();
  });
});

describe("cross-mode target decoding", () => {
  it("drops excess keys instead of surfacing them", () => {
    const decoded = decodeCrossModeTarget({
      mode: "business-os",
      ctoxInstanceId: "instance-alpha",
      recordBody: { revenue: 1_000_000 },
      note: "customer is unhappy",
    });

    expect(decoded).toEqual({ mode: "business-os", ctoxInstanceId: "instance-alpha" });
    expect(JSON.stringify(decoded)).not.toContain("unhappy");
  });

  it("normalizes idempotently", () => {
    const once = normalizeCrossModeTarget(BUSINESS_OS_TARGET);
    expect(normalizeCrossModeTarget(once)).toEqual(once);
  });
});
