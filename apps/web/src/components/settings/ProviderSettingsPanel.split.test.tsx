import { EnvironmentId } from "@workjet/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const primaryEnvironmentId = EnvironmentId.make("primary");
const remoteEnvironmentId = EnvironmentId.make("remote");

const environmentState = vi.hoisted(() => ({
  environments: [] as ReadonlyArray<unknown>,
  isReady: true,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: reactHookHarness.useEffect,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../state/environments", () => ({
  useBusinessOsScopedEnvironments: () => ({
    environments: environmentState.environments,
    isReady: environmentState.isReady,
  }),
  usePrimaryEnvironmentId: () => primaryEnvironmentId,
}));

import { ProviderSettingsPanel, WorkjetGatewayAccountsSection } from "./ProviderSettingsPanel";

function environment(environmentId: EnvironmentId, label: string, primary: boolean) {
  return {
    environmentId,
    label,
    entry: { target: { _tag: primary ? "PrimaryConnectionTarget" : "SshConnectionTarget" } },
    connection: { phase: "connected" },
    serverConfig: {},
    relayManaged: false,
    displayUrl: null,
  };
}

describe("harnesses and models are separate surfaces", () => {
  beforeEach(() => {
    hooks.reset();
    environmentState.environments = [environment(primaryEnvironmentId, "This device", true)];
    environmentState.isReady = true;
  });

  function render(sections: "harnesses" | "models") {
    hooks.beginRender();
    return ProviderSettingsPanel({ sections });
  }

  const harnessRuntimesOf = (panel: unknown, environmentId: EnvironmentId) =>
    visitElements(
      panel,
      (element) =>
        (element.props as { environment?: { environmentId?: EnvironmentId } }).environment
          ?.environmentId === environmentId,
    );
  const gatewayOf = (panel: unknown) =>
    visitElements(panel, (element) => element.type === WorkjetGatewayAccountsSection);

  // The two halves were merged onto one "Providers" page, and the LLM accounts
  // ended up below the fold with no menu entry of their own — unfindable in
  // practice. These tests pin the split: each page shows its own half and NOT
  // the other, so a future re-merge cannot pass silently.
  it("shows harness runtimes and no gateway accounts on the harnesses page", () => {
    const panel = render("harnesses");

    expect(harnessRuntimesOf(panel, primaryEnvironmentId)).not.toBeNull();
    expect(gatewayOf(panel)).toBeNull();
  });

  it("shows gateway accounts and no harness runtimes on the models page", () => {
    const panel = render("models");

    const gateway = gatewayOf(panel);
    expect(gateway).not.toBeNull();
    expect(gateway?.props.environmentId).toBe(primaryEnvironmentId);
    expect(harnessRuntimesOf(panel, primaryEnvironmentId)).toBeNull();
  });

  it("scopes the gateway section to the device the page is showing", () => {
    environmentState.environments = [environment(remoteEnvironmentId, "Remote device", false)];
    const panel = render("models");

    expect(gatewayOf(panel)?.props.environmentId).toBe(remoteEnvironmentId);
  });

  const withTitle = (panel: unknown, title: string) =>
    visitElements(panel, (element) => element.props.title === title);

  // grok-p1-045/-046: a load must end with a retry, and the page must not show
  // a device block and a model block for the same missing state.
  it("ends the device load on the harnesses page with a retryable status row", () => {
    environmentState.environments = [];
    environmentState.isReady = false;
    const panel = render("harnesses");

    const loading = withTitle(panel, "Rechner werden geladen");
    expect(loading).not.toBeNull();
    expect(typeof loading?.props.onRetry).toBe("function");
    expect(loading?.props.slowStatus).toBe("Rechner nicht geladen");
    expect(withTitle(panel, "Rechner")).toBeNull();
  });

  it("shows the device load only once on the models page", () => {
    environmentState.environments = [];
    environmentState.isReady = false;
    const panel = render("models");

    expect(withTitle(panel, "Rechner werden geladen")).toBeNull();
    expect(gatewayOf(panel)?.props.devicesLoading).toBe(true);
    expect(withTitle(panel, "Rechner")).toBeNull();
  });

  it("states a missing Code computer once on the models page", () => {
    environmentState.environments = [];
    const panel = render("models");

    expect(gatewayOf(panel)?.props.environmentId).toBeNull();
    expect(gatewayOf(panel)?.props.devicesLoading).toBe(false);
    expect(withTitle(panel, "Kein Rechner")).toBeNull();
    expect(withTitle(panel, "Rechner")).toBeNull();
  });
});
