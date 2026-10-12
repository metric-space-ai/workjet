import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { projectOverviewNeedsModelAccount } from "./projectModelAccountHint";

const account = (slug: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make("claude_personal"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [{ slug, name: slug, isCustom: false, isDefault: true, capabilities: {} }],
  slashCommands: [],
  skills: [],
});

describe("projectOverviewNeedsModelAccount", () => {
  it("stays quiet while no environment has delivered its configuration", () => {
    expect(projectOverviewNeedsModelAccount([])).toBe(false);
    expect(projectOverviewNeedsModelAccount([{ serverConfig: null }])).toBe(false);
  });

  it("asks for an account when no loaded environment has a concrete model", () => {
    expect(projectOverviewNeedsModelAccount([{ serverConfig: { providers: [] } }])).toBe(true);
    expect(
      projectOverviewNeedsModelAccount([{ serverConfig: { providers: [account("gpt-*")] } }]),
    ).toBe(true);
  });

  it("hides the hint once any environment has a usable account", () => {
    expect(
      projectOverviewNeedsModelAccount([
        { serverConfig: { providers: [] } },
        { serverConfig: { providers: [account("claude-opus-5-5")] } },
      ]),
    ).toBe(false);
  });
});
