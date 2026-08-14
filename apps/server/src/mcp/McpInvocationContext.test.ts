import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "./McpInvocationContext.ts";

it.effect("reports the scoped credential context when preview capability is unavailable", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(),
    activeWorkjetMcpCapabilityIds: new Set(["greppy"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    expect(error).toMatchObject({
      capability: "preview",
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
    expect(error.message).toBe("MCP credential does not grant the preview capability.");
  });
});

it.effect("keeps Workjet grants independent from tool-specific cwd requirements", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["preview"]),
    activeWorkjetMcpCapabilityIds: new Set(["web-search"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    expect(McpInvocationContext.hasActiveWorkjetMcpCapability(invocation, "web-search")).toBe(true);
    expect(McpInvocationContext.readMcpSessionCwd(invocation)).toBeUndefined();

    const granted = yield* McpInvocationContext.requireActiveWorkjetMcpCapability(
      "web-search",
    ).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, invocation));
    expect(granted).toBe(invocation);

    const cwdError = yield* McpInvocationContext.requireMcpSessionCwd().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );
    expect(cwdError).toBeInstanceOf(McpInvocationContext.McpSessionCwdUnavailableError);
    expect(cwdError.message).toBe("This MCP tool requires a provider session working directory.");
  });
});

it.effect("denies an ungranted Workjet MCP capability without consulting cwd", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["preview"]),
    activeWorkjetMcpCapabilityIds: new Set(),
    cwd: "/workspace/project",
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireActiveWorkjetMcpCapability("greppy").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );
    expect(error).toBeInstanceOf(McpInvocationContext.WorkjetMcpCapabilityUnavailableError);
    expect(error.message).toBe("MCP credential does not grant the greppy capability.");
  });
});
