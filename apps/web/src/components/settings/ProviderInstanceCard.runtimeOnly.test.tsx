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
import { getProviderRuntimeSummary } from "./providerStatus";

const instanceId = ProviderInstanceId.make("claude");

function liveProvider(): ServerProvider {
  const checkedAt = new Date().toISOString();
  return {
    instanceId,
    driver: ProviderDriverKind.make("claude"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    // The exact shape the Codex row had on screen: an authenticated account
    // with an email, a plan label, and an auth-flavoured server message.
    auth: {
      status: "authenticated",
      email: "person@example.com",
      label: "ChatGPT Pro 20x Subscription",
    },
    message: "5 upstream providers connected through OpenCode.",
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

function renderCard(
  provider: ServerProvider | undefined,
  runtimeOnly: boolean,
): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  return ProviderInstanceCard({
    runtimeOnly,
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

/** Every string anywhere in the rendered tree, flattened. */
function allText(tree: unknown): string {
  const parts: string[] = [];
  visitElements(tree, (element) => {
    const children = (element.props as { children?: unknown }).children;
    const collect = (value: unknown) => {
      if (typeof value === "string") parts.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
    };
    collect(children);
    for (const value of Object.values(element.props as Record<string, unknown>)) {
      if (typeof value === "string") parts.push(value);
    }
    return false;
  });
  return parts.join(" | ");
}

describe("harness cards show runtime state, never login state", () => {
  beforeEach(() => {
    hooks.reset();
  });

  // The Harnesses page answers "is this CLI installed". It showed
  // "Authenticated as <email> · ChatGPT Pro 20x Subscription" instead, mixing
  // an account question into a runtime list.
  it("omits the account, the plan and the auth-flavoured server message", () => {
    const text = allText(renderCard(liveProvider(), true));

    expect(text).not.toContain("Authenticated");
    expect(text).not.toContain("person@example.com");
    expect(text).not.toContain("ChatGPT Pro 20x Subscription");
    expect(text).not.toContain("upstream providers connected");
    expect(text).toContain("Installed");
  });

  it("still shows all of it on the account surface", () => {
    const text = allText(renderCard(liveProvider(), false));

    expect(text).toContain("Authenticated");
  });

  it("reports runtime facts only, never the server message", () => {
    const base = { installed: true, enabled: true, message: "Authenticated as someone" };

    expect(getProviderRuntimeSummary({ ...base } as unknown as ServerProvider)).toEqual({
      headline: "Installed",
      detail: null,
    });
    expect(
      getProviderRuntimeSummary({ ...base, enabled: false } as unknown as ServerProvider),
    ).toEqual({ headline: "Disabled", detail: "Not offered for new sessions." });
    expect(
      getProviderRuntimeSummary({ ...base, installed: false } as unknown as ServerProvider),
    ).toEqual({ headline: "Not installed", detail: "CLI not detected on PATH." });
  });
});
