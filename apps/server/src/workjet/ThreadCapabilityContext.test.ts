import {
  builtInCapabilityManifests,
  createCapabilityRegistry,
} from "@metric-space-ai/workjet-capabilities";
import { DEFAULT_WORKJET_THREAD_CONFIG, type WorkjetThreadConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadCapabilityContext } from "./ThreadCapabilityContext.ts";

const registry = createCapabilityRegistry([
  {
    ...builtInCapabilityManifests[0]!,
    supportedAdapters: ["t3-prompt"],
  },
  {
    ...builtInCapabilityManifests[1]!,
    supportedAdapters: ["t3-mcp"],
  },
  {
    ...builtInCapabilityManifests[2]!,
    supportedAdapters: ["t3-mcp", "t3-prompt"],
  },
]);

describe("resolveThreadCapabilityContext", () => {
  it("resolves the default config to empty T3 capability context", () => {
    expect(resolveThreadCapabilityContext(DEFAULT_WORKJET_THREAD_CONFIG)).toEqual({
      mcpCapabilityIds: [],
      promptCapabilityIds: [],
      compiledManagedPrompt: "",
    });
  });

  it("resolves each T3 adapter independently with stable order and de-duplication", () => {
    const config = {
      schemaVersion: 1,
      role: "standard",
      parent: null,
      managedInstructions: "Apply the configured workflow.",
      enabledCapabilityIds: [
        "web-search",
        "greppy",
        "web-search",
        "unknown-capability",
        "web-stack-browser",
      ],
    } as unknown as WorkjetThreadConfig;

    const context = resolveThreadCapabilityContext(config, registry);

    expect(context.mcpCapabilityIds).toEqual(["web-search", "web-stack-browser"]);
    expect(context.promptCapabilityIds).toEqual(["greppy", "web-stack-browser"]);
    expect(context.compiledManagedPrompt).toBe(
      [
        "## Managed Instructions\n\nApply the configured workflow.",
        "## Capability: greppy@1.0.0\n\nUse Greppy to locate relevant text in files when repository or document search would help answer the task.",
        "## Capability: web-stack-browser@1.0.0\n\nUse Web Stack Browser for tasks that require interacting with or inspecting a rendered web page. Supply only its finite structured actions, never JavaScript, shell commands, paths, environment variables, or secrets, and report observed outcomes.",
      ].join("\n\n"),
    );
  });

  it("returns frozen copies that do not retain the config capability array", () => {
    const enabledCapabilityIds = ["greppy", "web-stack-browser"];
    const config = {
      schemaVersion: 1,
      role: "standard",
      parent: null,
      managedInstructions: "",
      enabledCapabilityIds,
    } as WorkjetThreadConfig;

    const context = resolveThreadCapabilityContext(config, registry);
    enabledCapabilityIds.push("web-search");

    expect(context.mcpCapabilityIds).toEqual(["web-stack-browser"]);
    expect(context.promptCapabilityIds).toEqual(["greppy", "web-stack-browser"]);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.mcpCapabilityIds)).toBe(true);
    expect(Object.isFrozen(context.promptCapabilityIds)).toBe(true);
  });
});
