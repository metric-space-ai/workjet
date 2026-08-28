import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  WorkjetConnectionId,
} from "@t3tools/contracts";

import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import { isDecisionHubToolVisible } from "./DecisionHubTool.ts";

const invocation = (overrides: Partial<McpInvocationScope> = {}): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex-main"),
  capabilities: new Set(),
  workjetRole: "standard",
  activeWorkjetMcpCapabilityIds: new Set(["decision-hub"]),
  decisionHubConnectionId: WorkjetConnectionId.make("connection-1"),
  issuedAt: 1,
  ...overrides,
});

it("shows Decision Hub only to a bound root role with the active capability", () => {
  expect(isDecisionHubToolVisible(invocation())).toBe(true);
  expect(isDecisionHubToolVisible(invocation({ workjetRole: "orchestrator" }))).toBe(true);
  expect(isDecisionHubToolVisible(invocation({ workjetRole: "worker" }))).toBe(false);
  const { decisionHubConnectionId: _binding, ...unbound } = invocation();
  expect(isDecisionHubToolVisible(unbound)).toBe(false);
  expect(isDecisionHubToolVisible(invocation({ activeWorkjetMcpCapabilityIds: new Set() }))).toBe(
    false,
  );
});
