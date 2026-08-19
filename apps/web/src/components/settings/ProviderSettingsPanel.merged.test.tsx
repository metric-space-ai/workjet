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

describe("the single provider surface", () => {
  beforeEach(() => {
    hooks.reset();
    environmentState.environments = [environment(primaryEnvironmentId, "This device", true)];
  });

  function render() {
    hooks.beginRender();
    return ProviderSettingsPanel();
  }

  it("renders the harness runtimes and the Workjet gateway accounts on one page", () => {
    const panel = render();

    // Harness CLI runtimes for the selected device…
    const runtimes = visitElements(
      panel,
      (element) =>
        (element.props as { environment?: { environmentId?: EnvironmentId } }).environment
          ?.environmentId === primaryEnvironmentId,
    );
    expect(runtimes).not.toBeNull();

    // …and the gateway's LLM accounts directly beneath them, not on a second
    // competing settings page.
    const gateway = visitElements(
      panel,
      (element) => element.type === WorkjetGatewayAccountsSection,
    );
    expect(gateway).not.toBeNull();
    expect(gateway?.props.environmentId).toBe(primaryEnvironmentId);
  });

  it("scopes the gateway section to the device the page is showing", () => {
    environmentState.environments = [environment(remoteEnvironmentId, "Remote device", false)];
    const panel = render();

    const gateway = visitElements(
      panel,
      (element) => element.type === WorkjetGatewayAccountsSection,
    );
    expect(gateway?.props.environmentId).toBe(remoteEnvironmentId);
  });
});
