import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  normalizeWorkjetThreadConfig,
  WorkjetConnectionId,
} from "./workjet.ts";
import { retainWorkjetCtoxBinding } from "./workjetCtoxBinding.ts";
import { WorkjetCtoxBusinessOsInput } from "./workjetCtoxBusinessOs.ts";

const original = {
  ...normalizeWorkjetThreadConfig(DEFAULT_WORKJET_THREAD_CONFIG),
  enabledCapabilityIds: ["ctox-business-os"] as const,
  capabilityBindings: [
    {
      capabilityId: "ctox-business-os" as const,
      target: {
        kind: "ctox-connection" as const,
        connectionId: WorkjetConnectionId.make("connection-a"),
        instanceId: "instance-a",
      },
    },
  ],
};

describe("CTOX thread identity and typed app access", () => {
  it("retains identity when tools are disabled and rejects retargeting after reenabling", () => {
    const disabled = retainWorkjetCtoxBinding(original, {
      ...original,
      enabledCapabilityIds: [],
      capabilityBindings: [],
    });
    expect(disabled.error).toBeNull();
    expect(normalizeWorkjetThreadConfig(disabled.config).capabilityBindings).toEqual(
      original.capabilityBindings,
    );
    const different = {
      ...original,
      capabilityBindings: [
        {
          ...original.capabilityBindings[0]!,
          target: {
            kind: "ctox-connection" as const,
            connectionId: WorkjetConnectionId.make("connection-b"),
            instanceId: "instance-b",
          },
        },
      ],
    };
    expect(retainWorkjetCtoxBinding(disabled.config, different).error).not.toBeNull();
    expect(retainWorkjetCtoxBinding(disabled.config, original).error).toBeNull();
  });

  it("rejects a tool binding outside the registered CTOX session", () => {
    const session = {
      ...original,
      ctoxSession: { instanceId: "instance-b", sessionId: "session-b", fenceEpoch: 1 },
    };
    expect(retainWorkjetCtoxBinding(DEFAULT_WORKJET_THREAD_CONFIG, session).error).not.toBeNull();
  });

  it("allows typed source editing and skill retrieval while rejecting routing and identity overrides", () => {
    const decode = Schema.decodeUnknownSync(WorkjetCtoxBusinessOsInput, {
      onExcessProperty: "error",
    });
    expect(
      decode({
        request: {
          operation: "write_app_file",
          module_id: "app-a",
          path: "index.js",
          content: "export {};",
        },
      }).request.operation,
    ).toBe("write_app_file");
    expect(
      decode({
        request: {
          operation: "read_app_skill_resource",
          resource: "references/shell-v2-contract.md",
        },
      }).request.operation,
    ).toBe("read_app_skill_resource");
    for (const request of [
      { operation: "run_shell", command: "whoami" },
      { operation: "get_module", module_id: "app-a", endpoint: "https://other.example/mcp" },
      { operation: "get_module", module_id: "app-a", _context: { role: "chef" } },
      { operation: "write_app_file", module_id: "app-a", path: "index.js" },
    ])
      expect(() => decode({ request })).toThrow();
  });
});
