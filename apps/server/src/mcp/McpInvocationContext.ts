import {
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
  WorkjetCapabilityId,
  type WorkjetConnectionId,
  type WorkjetThreadRole,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type McpCapability = "preview";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly activeWorkjetMcpCapabilityIds?: ReadonlySet<WorkjetCapabilityId>;
  readonly workjetRole?: WorkjetThreadRole;
  readonly decisionHubConnectionId?: WorkjetConnectionId;
  readonly cwd?: string;
  readonly issuedAt: number;
}

export class WorkjetMcpCapabilityUnavailableError extends Schema.TaggedErrorClass<WorkjetMcpCapabilityUnavailableError>()(
  "WorkjetMcpCapabilityUnavailableError",
  {
    capabilityId: WorkjetCapabilityId,
  },
) {
  override get message(): string {
    return `MCP credential does not grant the ${this.capabilityId} capability.`;
  }
}

export class WorkjetOrchestratorUnavailableError extends Schema.TaggedErrorClass<WorkjetOrchestratorUnavailableError>()(
  "WorkjetOrchestratorUnavailableError",
  {},
) {
  override get message(): string {
    return "This MCP credential is not authorized to dispatch Workjet workers.";
  }
}

export class WorkjetMemberUnavailableError extends Schema.TaggedErrorClass<WorkjetMemberUnavailableError>()(
  "WorkjetMemberUnavailableError",
  {},
) {
  override get message(): string {
    return "This MCP credential is not bound to a Workjet collective member thread.";
  }
}

export class McpSessionCwdUnavailableError extends Schema.TaggedErrorClass<McpSessionCwdUnavailableError>()(
  "McpSessionCwdUnavailableError",
  {},
) {
  override get message(): string {
    return "This MCP tool requires a provider session working directory.";
  }
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: McpCapability,
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});

export const hasActiveWorkjetMcpCapability = (
  invocation: McpInvocationScope,
  capabilityId: WorkjetCapabilityId,
): boolean => invocation.activeWorkjetMcpCapabilityIds?.has(capabilityId) === true;

export const readMcpSessionCwd = (invocation: McpInvocationScope): string | undefined => {
  const cwd = invocation.cwd?.trim();
  return cwd ? cwd : undefined;
};

export const requireActiveWorkjetMcpCapability = Effect.fn("mcp.requireActiveWorkjetCapability")(
  function* (capabilityId: WorkjetCapabilityId) {
    const invocation = yield* McpInvocationContext;
    if (!hasActiveWorkjetMcpCapability(invocation, capabilityId)) {
      return yield* new WorkjetMcpCapabilityUnavailableError({ capabilityId });
    }
    return invocation;
  },
);

export const isWorkjetMember = (invocation: McpInvocationScope): boolean =>
  invocation.workjetRole === "standard" ||
  invocation.workjetRole === "orchestrator" ||
  invocation.workjetRole === "worker";

export const requireWorkjetMember = Effect.fn("mcp.requireWorkjetMember")(function* () {
  const invocation = yield* McpInvocationContext;
  if (!isWorkjetMember(invocation)) {
    return yield* new WorkjetMemberUnavailableError();
  }
  return invocation;
});

export const isWorkjetOrchestrator = (invocation: McpInvocationScope): boolean =>
  invocation.workjetRole === "orchestrator";

export const requireWorkjetOrchestrator = Effect.fn("mcp.requireWorkjetOrchestrator")(function* () {
  const invocation = yield* McpInvocationContext;
  if (!isWorkjetOrchestrator(invocation)) {
    return yield* new WorkjetOrchestratorUnavailableError();
  }
  return invocation;
});

export const requireMcpSessionCwd = Effect.fn("mcp.requireSessionCwd")(function* () {
  const invocation = yield* McpInvocationContext;
  const cwd = readMcpSessionCwd(invocation);
  if (!cwd) {
    return yield* new McpSessionCwdUnavailableError();
  }
  return cwd;
});
