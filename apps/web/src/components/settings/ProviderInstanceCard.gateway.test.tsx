import type { ReactElement } from "react";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

// Uses React.useEffect, which has no dispatcher when a component is invoked
// as a plain function. The card's copy affordance is irrelevant here.
vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), copiedId: null }),
}));

import { ProviderInstanceCard } from "./ProviderInstanceCard";

const instanceId = ProviderInstanceId.make("codex_work");

const ROUTE_TOGGLE_LABEL = "Route Codex Work via Workjet gateway";

function renderCard(
  instance: ProviderInstanceConfig,
  onUpdate: (next: ProviderInstanceConfig) => void,
): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return ProviderInstanceCard({
    instanceId,
    instance,
    driverOption: undefined,
    liveProvider: undefined,
    isExpanded: true,
    onExpandedChange: vi.fn(),
    onUpdate,
    hiddenModels: [],
    favoriteModels: [],
    modelOrder: [],
    onHiddenModelsChange: vi.fn(),
    onFavoriteModelsChange: vi.fn(),
    onModelOrderChange: vi.fn(),
  }) as ReactElement<Record<string, unknown>>;
}

function findRouteToggle(tree: unknown): ReactElement<Record<string, unknown>> | null {
  return visitElements(tree, (element) => element.props["aria-label"] === ROUTE_TOGGLE_LABEL);
}

function baseInstance(overrides?: Partial<ProviderInstanceConfig>): ProviderInstanceConfig {
  return {
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex Work",
    ...overrides,
  } as ProviderInstanceConfig;
}

describe("ProviderInstanceCard gateway routing toggle", () => {
  beforeEach(() => {
    hooks.reset();
  });

  it("renders the toggle off for an instance that never opted in", () => {
    const toggle = findRouteToggle(renderCard(baseInstance(), vi.fn()));

    expect(toggle).not.toBeNull();
    expect(toggle?.props["checked"]).toBe(false);
  });

  it("reflects a persisted opt-in", () => {
    const toggle = findRouteToggle(renderCard(baseInstance({ routeViaGateway: true }), vi.fn()));

    expect(toggle?.props["checked"]).toBe(true);
  });

  it("writes routeViaGateway: true when switched on", () => {
    const onUpdate = vi.fn();
    const toggle = findRouteToggle(renderCard(baseInstance(), onUpdate));

    (toggle?.props["onCheckedChange"] as (checked: boolean) => void)(true);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({ routeViaGateway: true });
  });

  it("drops the key entirely when switched off", () => {
    const onUpdate = vi.fn();
    const toggle = findRouteToggle(renderCard(baseInstance({ routeViaGateway: true }), onUpdate));

    (toggle?.props["onCheckedChange"] as (checked: boolean) => void)(false);

    const next = onUpdate.mock.calls[0]?.[0] as ProviderInstanceConfig;
    // Persisting `false` would rewrite envelopes that never opted in; absence
    // is the same thing and keeps them byte-identical.
    expect(next).not.toHaveProperty("routeViaGateway");
    expect(next.displayName).toBe("Codex Work");
  });
});
