import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  WorkjetDecisionHubEscalationInput,
  WorkjetDecisionHubProvisionInput,
} from "./workjetDecisionHub.ts";

const decodeEscalation = Schema.decodeUnknownSync(WorkjetDecisionHubEscalationInput, {
  onExcessProperty: "error",
});

const valid = {
  decisionKey: "database-choice-v1",
  title: "Choose the storage engine",
  question: "Which storage engine should own the durable state?",
  context: "Both variants satisfy the functional contract.",
  options: [
    { id: "sqlite", label: "SQLite", description: "Local and simple." },
    { id: "postgres", label: "Postgres", description: "Shared and scalable." },
  ],
  recommendationOptionId: "sqlite",
  urgency: "high",
} as const;

describe("Decision Hub wire bounds", () => {
  it("accepts a bounded escalation and rejects model-controlled routing fields", () => {
    expect(decodeEscalation(valid).decisionKey).toBe(valid.decisionKey);
    expect(() => decodeEscalation({ ...valid, environmentId: "foreign" })).toThrow();
    expect(() => decodeEscalation({ ...valid, options: [valid.options[0]] })).toThrow();
    expect(() =>
      decodeEscalation({
        ...valid,
        options: Array.from({ length: 9 }, (_, index) => ({
          id: `option-${index}`,
          label: `Option ${index}`,
          description: "Bounded",
        })),
      }),
    ).toThrow();
  });

  it("keeps raw endpoint and token confined to the write-only provisioning input", () => {
    const decoded = Schema.decodeUnknownSync(WorkjetDecisionHubProvisionInput)({
      connectionId: "connection-1",
      instanceId: "instance-1",
      displayName: "Owner CTOX",
      source: "ctox_dev",
      endpoint: "https://gateway.ctox.dev/instances/one/mcp",
      token: "ctox_mcp_secret",
    });
    expect(decoded.token).toBe("ctox_mcp_secret");
    expect(Object.keys(decoded)).toContain("endpoint");
  });
});
