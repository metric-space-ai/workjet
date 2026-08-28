import { WorkjetConnectionId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveDelegatedCapabilities, validateCapabilityActivation } from "./activation.ts";

const decisionBinding = {
  capabilityId: "decision-hub",
  target: {
    kind: "ctox-connection",
    connectionId: WorkjetConnectionId.make("connection-1"),
  },
} as const;

describe("capability activation policy", () => {
  it("requires one known reachable Decision Hub binding on a root thread", () => {
    const validation = validateCapabilityActivation({
      config: {
        schemaVersion: 2,
        role: "orchestrator",
        parent: null,
        managedInstructions: "",
        enabledCapabilityIds: ["decision-hub"],
        capabilityBindings: [decisionBinding],
      },
      knownConnectionIds: new Set(["connection-1"]),
      reachableConnectionIds: new Set(["connection-1"]),
    });
    expect(validation.issues).toEqual([]);
    expect(validation.config.capabilityBindings).toEqual([decisionBinding]);
  });

  it("fails closed for missing, foreign, or unreachable bindings", () => {
    const base = {
      schemaVersion: 2,
      role: "standard",
      parent: null,
      managedInstructions: "",
      enabledCapabilityIds: ["decision-hub"],
    } as const;
    expect(
      validateCapabilityActivation({ config: { ...base, capabilityBindings: [] } }).issues,
    ).toContainEqual({ capabilityId: "decision-hub", code: "binding-required" });
    expect(
      validateCapabilityActivation({
        config: { ...base, capabilityBindings: [decisionBinding] },
        knownConnectionIds: new Set(),
      }).issues,
    ).toContainEqual({ capabilityId: "decision-hub", code: "binding-foreign" });
    expect(
      validateCapabilityActivation({
        config: { ...base, capabilityBindings: [decisionBinding] },
        knownConnectionIds: new Set(["connection-1"]),
        reachableConnectionIds: new Set(),
      }).issues,
    ).toContainEqual({ capabilityId: "decision-hub", code: "binding-unreachable" });
  });

  it("drops orphan bindings", () => {
    const validation = validateCapabilityActivation({
      config: {
        schemaVersion: 2,
        role: "standard",
        parent: null,
        managedInstructions: "",
        enabledCapabilityIds: [],
        capabilityBindings: [decisionBinding],
      },
    });
    expect(validation.config.capabilityBindings).toEqual([]);
  });

  it("never implicitly delegates Decision Hub and rejects an explicit request", () => {
    expect(
      resolveDelegatedCapabilities({
        parentCapabilityIds: ["greppy", "decision-hub"],
      }),
    ).toEqual({ capabilityIds: ["greppy"], issues: [] });
    expect(
      resolveDelegatedCapabilities({
        parentCapabilityIds: ["greppy", "decision-hub"],
        requestedCapabilityIds: ["decision-hub"],
      }),
    ).toEqual({
      capabilityIds: [],
      issues: [{ capabilityId: "decision-hub", code: "child-delegation-forbidden" }],
    });
  });
});
