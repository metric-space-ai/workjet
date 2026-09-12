import { DEFAULT_WORKJET_THREAD_CONFIG, WorkjetConnectionId } from "@workjet/contracts";
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

it("keeps native Crew chat references and rejects foreign app-MCP routes", () => {
  const ctoxCrewChat = {
    instanceId: "crew-instance",
    connectionId: WorkjetConnectionId.make("crew-connection"),
    chatId: "workjet_private_chat",
  };
  const validate = (instanceId: string, connectionId: string) =>
    validateCapabilityActivation({
      config: {
        ...DEFAULT_WORKJET_THREAD_CONFIG,
        ctoxCrewChat,
        enabledCapabilityIds: ["ctox-business-os"],
        capabilityBindings: [
          {
            capabilityId: "ctox-business-os",
            target: {
              kind: "ctox-connection",
              instanceId,
              connectionId: WorkjetConnectionId.make(connectionId),
            },
          },
        ],
      },
      knownConnectionIds: new Set([connectionId]),
      reachableConnectionIds: new Set([connectionId]),
      connectionInstances: new Map([[connectionId, instanceId]]),
    });
  const matching = validate("crew-instance", "crew-connection");
  expect(matching.issues).toEqual([]);
  expect(matching.config.ctoxCrewChat).toEqual(ctoxCrewChat);
  for (const [instance, connection] of [
    ["foreign-instance", "crew-connection"],
    ["crew-instance", "foreign-connection"],
  ]) {
    expect(validate(instance!, connection!).issues).toContainEqual({
      capabilityId: "ctox-business-os",
      code: "binding-foreign",
    });
  }
  const crewOnly = validateCapabilityActivation({
    config: { ...DEFAULT_WORKJET_THREAD_CONFIG, ctoxCrewChat },
  });
  expect(crewOnly.config.ctoxCrewChat).toEqual(ctoxCrewChat);
  expect(crewOnly.config.enabledCapabilityIds).toEqual([]);
  expect(crewOnly.issues).toEqual([]);
});
