import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const primaryEnvironmentId = EnvironmentId.make("primary");
const remoteEnvironmentId = EnvironmentId.make("remote");

const environmentState = vi.hoisted(() => ({
  environments: [] as ReadonlyArray<unknown>,
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
  useEnvironments: () => ({ environments: environmentState.environments, isReady: true }),
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
});
