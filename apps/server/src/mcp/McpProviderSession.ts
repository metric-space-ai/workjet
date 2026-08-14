import type {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  WorkjetCapabilityId,
} from "@t3tools/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  readonly activeWorkjetMcpCapabilityIds: ReadonlyArray<WorkjetCapabilityId>;
  readonly compiledManagedPrompt: string;
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(
    config.threadId,
    Object.freeze({
      ...config,
      activeWorkjetMcpCapabilityIds: Object.freeze([...config.activeWorkjetMcpCapabilityIds]),
    }),
  );
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
