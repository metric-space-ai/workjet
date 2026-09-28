import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  normalizeWorkjetThreadConfig,
  WorkjetConnectionId,
} from "@workjet/contracts";
import { resolveThreadCapabilityContext } from "./ThreadCapabilityContext.ts";

const connectionId = WorkjetConnectionId.make("ctox-a");
const config = {
  ...normalizeWorkjetThreadConfig(DEFAULT_WORKJET_THREAD_CONFIG),
  enabledCapabilityIds: ["ctox-business-os"] as const,
  capabilityBindings: [
    {
      capabilityId: "ctox-business-os" as const,
      target: {
        kind: "ctox-connection" as const,
        connectionId,
        instanceId: "instance-a",
      },
    },
  ],
};
const connections = {
  knownConnectionIds: new Set([connectionId]),
  reachableConnectionIds: new Set([connectionId]),
  connectionInstances: new Map([[connectionId, "instance-a"]]),
};

describe("CTOX capability context", () => {
  it("delivers one bound instance with the app instructions to each harness session", () => {
    const context = resolveThreadCapabilityContext(config, undefined, connections);
    expect(context.mcpCapabilityIds).toEqual(["ctox-business-os"]);
    expect(context.promptCapabilityIds).toEqual(["ctox-business-os"]);
    expect(context.ctoxBusinessOsBinding).toEqual({ connectionId, instanceId: "instance-a" });
    expect(context.compiledManagedPrompt).toContain("read_app_skill_resource");
    expect(context.compiledManagedPrompt).toContain("get_command_status");
  });
  it("does not grant tools or instructions for a missing, foreign or offline binding", () => {
    for (const available of [
      { ...connections, reachableConnectionIds: new Set<string>() },
      { ...connections, knownConnectionIds: new Set<string>() },
      { ...connections, connectionInstances: new Map([[connectionId, "instance-b"]]) },
    ]) {
      const context = resolveThreadCapabilityContext(config, undefined, available);
      expect(context.mcpCapabilityIds).toEqual([]);
      expect(context.ctoxBusinessOsBinding).toBeUndefined();
      expect(context.compiledManagedPrompt).not.toContain("read_app_skill_resource");
    }
  });
});
