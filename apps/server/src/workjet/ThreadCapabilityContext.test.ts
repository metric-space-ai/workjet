import {
  builtInCapabilityManifests,
  createCapabilityRegistry,
  WORKJET_COLLECTIVE_SYSTEM_PROMPT,
} from "@metric-space-ai/workjet-capabilities";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  WorkjetConnectionId,
  type WorkjetThreadConfig,
} from "@t3tools/contracts";
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
  it("resolves the default config to the collective prompt baseline", () => {
    expect(resolveThreadCapabilityContext(DEFAULT_WORKJET_THREAD_CONFIG)).toEqual({
      workjetRole: "standard",
      mcpCapabilityIds: [],
      promptCapabilityIds: [],
      compiledManagedPrompt: WORKJET_COLLECTIVE_SYSTEM_PROMPT,
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

    expect(context.workjetRole).toBe("standard");
    expect(context.mcpCapabilityIds).toEqual(["web-search", "web-stack-browser"]);
    expect(context.promptCapabilityIds).toEqual(["greppy", "web-stack-browser"]);
    expect(context.compiledManagedPrompt).toBe(
      [
        WORKJET_COLLECTIVE_SYSTEM_PROMPT,
        "## Managed Instructions\n\nApply the configured workflow.",
        "## Capability: greppy@1.0.0\n\nUse Greppy to locate relevant text in files when repository or document search would help answer the task.",
        "## Capability: web-stack-browser@1.0.0\n\nUse Web Stack Browser for tasks that require interacting with or inspecting a rendered web page. Supply only its finite structured actions, never JavaScript, shell commands, paths, environment variables, or secrets, and report observed outcomes.",
      ].join("\n\n"),
    );
  });

  it("keeps search, direct read, and deep research under the one web-search thread grant", () => {
    const webSearch = builtInCapabilityManifests.filter(({ id }) => id === "web-search");
    expect(webSearch).toHaveLength(1);
    expect(webSearch[0]?.version).toBe("1.0.0");
    expect(webSearch[0]?.metadata.description).toContain("reads specific pages");
    expect(webSearch[0]?.metadata.description).toContain("deep research");

    const config = {
      schemaVersion: 1,
      role: "standard",
      parent: null,
      managedInstructions: "",
      enabledCapabilityIds: ["web-search"],
    } as WorkjetThreadConfig;
    expect(resolveThreadCapabilityContext(config, registry)).toMatchObject({
      mcpCapabilityIds: ["web-search"],
      promptCapabilityIds: [],
    });
  });

  it("places global managed policy before thread-specific instructions", () => {
    const context = resolveThreadCapabilityContext(
      {
        ...DEFAULT_WORKJET_THREAD_CONFIG,
        managedInstructions: "Thread-specific policy.",
      },
      undefined,
      undefined,
      "Collective-wide policy.",
    );

    expect(context.compiledManagedPrompt.indexOf("Collective-wide policy.")).toBeLessThan(
      context.compiledManagedPrompt.indexOf("Thread-specific policy."),
    );
  });

  it("projects orchestrator and worker roles into the managed prompt", () => {
    const orchestrator = resolveThreadCapabilityContext({
      schemaVersion: 1,
      role: "orchestrator",
      parent: null,
      managedInstructions: "Coordinate carefully.",
      enabledCapabilityIds: [],
    });
    expect(orchestrator.workjetRole).toBe("orchestrator");
    expect(orchestrator.compiledManagedPrompt).toContain("## Workjet Role: Orchestrator");
    expect(orchestrator.compiledManagedPrompt).toContain("## Managed Instructions");

    const worker = resolveThreadCapabilityContext({
      schemaVersion: 1,
      role: "worker",
      parent: {
        environmentId: "environment-1" as never,
        threadId: "thread-parent" as never,
      },
      managedInstructions: "",
      enabledCapabilityIds: [],
    });
    expect(worker.workjetRole).toBe("worker");
    expect(worker.compiledManagedPrompt).toContain("Do not dispatch more workers");
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

  it("fails closed for unknown and unavailable Decision Hub bindings", () => {
    const config = {
      schemaVersion: 2,
      role: "standard",
      parent: null,
      managedInstructions: "",
      enabledCapabilityIds: ["decision-hub"],
      capabilityBindings: [
        {
          capabilityId: "decision-hub",
          target: {
            kind: "ctox-connection",
            connectionId: WorkjetConnectionId.make("foreign-connection"),
          },
        },
      ],
    } as WorkjetThreadConfig;

    const context = resolveThreadCapabilityContext(config, undefined, {
      knownConnectionIds: new Set(),
      reachableConnectionIds: new Set(),
    });

    expect(context.mcpCapabilityIds).not.toContain("decision-hub");
    expect(context.promptCapabilityIds).not.toContain("decision-hub");
    expect(context.decisionHubConnectionId).toBeUndefined();
  });
});
