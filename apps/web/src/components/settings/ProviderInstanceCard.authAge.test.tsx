import type { ReactElement } from "react";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
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

vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), copiedId: null }),
}));

import { ProviderInstanceCard } from "./ProviderInstanceCard";
import { providerCheckedAgeLabel } from "./providerStatus";

const instanceId = ProviderInstanceId.make("claude");

function liveProvider(checkedAt: string): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("claude"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "current",
      currentVersion: "1.0.0",
      latestVersion: "1.0.0",
      updateCommand: null,
      canUpdate: false,
      checkedAt,
      message: null,
    },
  } as unknown as ServerProvider;
}

function renderCard(provider: ServerProvider | undefined): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return ProviderInstanceCard({
    instanceId,
    instance: {
      driver: ProviderDriverKind.make("claude"),
      displayName: "Claude",
    } as ProviderInstanceConfig,
    driverOption: undefined,
    liveProvider: provider,
    isExpanded: false,
    onExpandedChange: vi.fn(),
    onUpdate: vi.fn(),
    hiddenModels: [],
    favoriteModels: [],
    modelOrder: [],
    onHiddenModelsChange: vi.fn(),
    onFavoriteModelsChange: vi.fn(),
    onModelOrderChange: vi.fn(),
  }) as ReactElement<Record<string, unknown>>;
}

function findText(tree: unknown, text: string) {
  return visitElements(tree, (element) => element.props.children === text);
}

describe("provider health-claim age", () => {
  beforeEach(() => {
    hooks.reset();
  });

  it("labels the age of the probe that produced the claim", () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
    expect(providerCheckedAgeLabel(oneHourAgo)).toBe("checked 1h ago");
    expect(providerCheckedAgeLabel(new Date().toISOString())).toBe("checked just now");
    expect(providerCheckedAgeLabel(null)).toBe("never checked");
    expect(providerCheckedAgeLabel("not-a-date")).toBe("check time unknown");
  });

  it("renders the age beside a cached Authenticated claim", () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
    const card = renderCard(liveProvider(oneHourAgo));

    // An hour-old "Authenticated" must not read as a live fact.
    expect(findText(card, "Authenticated")).not.toBeNull();
    expect(findText(card, "· checked 1h ago")).not.toBeNull();
  });

  it("omits the age when the server has not reported the provider at all", () => {
    const card = renderCard(undefined);

    expect(findText(card, "· never checked")).toBeNull();
  });
});
