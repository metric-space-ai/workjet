import type {
  CtoxDecisionHubProvisionInput,
  EnvironmentId,
  WorkjetConnectionSummary,
  WorkjetThreadConfig,
} from "@workjet/contracts";
import { normalizeWorkjetThreadConfig, retainWorkjetCtoxBinding } from "@workjet/contracts";
import { ctoxConnectionMatchesSelectedInstance } from "./workjetCtoxConnections";

export function workerSourceProvisionRequest(
  environmentId: EnvironmentId,
  selectedInstanceId: string | null,
): CtoxDecisionHubProvisionInput | null {
  if (!selectedInstanceId?.startsWith("managed:")) return null;
  const tenantId = selectedInstanceId.slice("managed:".length);
  if (tenantId.length === 0) return null;
  return { environmentId, purpose: "worker_source", target: { _tag: "ctox_dev", tenantId } };
}

export function workerSourceConnectionForInstance(
  connections: readonly WorkjetConnectionSummary[],
  selectedInstanceId: string | null,
): WorkjetConnectionSummary | undefined {
  if (!selectedInstanceId?.startsWith("managed:")) return undefined;
  const prefix = `ctox-dev-worker-source:${selectedInstanceId.slice("managed:".length)}:`;
  const matching = connections.filter(
    (connection) =>
      connection.connectionId.startsWith(prefix) &&
      ctoxConnectionMatchesSelectedInstance(connection, selectedInstanceId),
  );
  const ready = matching.filter((connection) => connection.status === "ready");
  return ready.length === 1 ? ready[0] : ready.length > 1 ? undefined : matching[0];
}

/** Enrollment carries the native pin of one existing ready source, never the desktop tenant ID. */
export function workerSourceConnectionForEnrollment(
  connections: readonly WorkjetConnectionSummary[],
  selectedInstanceId: string | null,
): WorkjetConnectionSummary | undefined {
  const matching = connections.filter(
    (connection) =>
      connection.status === "ready" &&
      (selectedInstanceId?.startsWith("managed:")
        ? workerSourceConnectionForInstance([connection], selectedInstanceId) === connection
        : selectedInstanceId !== null && connection.instanceId === selectedInstanceId),
  );
  return matching.length === 1 ? matching[0] : undefined;
}

export function workerSourceIsBound(
  config: WorkjetThreadConfig,
  connection: WorkjetConnectionSummary,
): boolean {
  const normalized = normalizeWorkjetThreadConfig(config);
  return (
    connection.status === "ready" &&
    normalized.enabledCapabilityIds.includes("ctox-business-os") &&
    normalized.capabilityBindings.some(
      (binding) =>
        binding.capabilityId === "ctox-business-os" &&
        binding.target.connectionId === connection.connectionId &&
        binding.target.instanceId === connection.instanceId,
    )
  );
}

/** Save source authority while retaining durable turn state and other capabilities. */
export function withWorkerSourceConnection(
  config: WorkjetThreadConfig,
  selectedInstanceId: string | null,
  connection: WorkjetConnectionSummary,
): WorkjetThreadConfig | null {
  if (
    connection.status !== "ready" ||
    !workerSourceConnectionForInstance([connection], selectedInstanceId)
  )
    return null;
  const normalized = normalizeWorkjetThreadConfig(config);
  const next: WorkjetThreadConfig = {
    ...normalized,
    schemaVersion: 2,
    enabledCapabilityIds: normalized.enabledCapabilityIds.includes("ctox-business-os")
      ? normalized.enabledCapabilityIds
      : [...normalized.enabledCapabilityIds, "ctox-business-os"],
    capabilityBindings: [
      ...normalized.capabilityBindings.filter(
        (binding) => binding.capabilityId !== "ctox-business-os",
      ),
      {
        capabilityId: "ctox-business-os",
        target: {
          kind: "ctox-connection",
          connectionId: connection.connectionId,
          instanceId: connection.instanceId,
        },
      },
    ],
    ...(normalized.ctoxCrewChat &&
    normalized.ctoxCrewChat.connectionId ===
      normalized.capabilityBindings.find((binding) => binding.capabilityId === "ctox-business-os")
        ?.target.connectionId
      ? { ctoxCrewChat: { ...normalized.ctoxCrewChat, connectionId: connection.connectionId } }
      : {}),
  };
  return next;
}

export function workerSourceBindingFailure(error: unknown): {
  readonly message: string;
  readonly retryable: boolean;
} {
  if (error && typeof error === "object") {
    if ("_tag" in error && error._tag === "OrchestrationDispatchCommandError" && "cause" in error)
      return workerSourceBindingFailure(error.cause);
    if (
      "_tag" in error &&
      (error._tag === "OrchestrationCommandInvariantError" ||
        error._tag === "OrchestrationCommandPreviouslyRejectedError") &&
      "detail" in error &&
      typeof error.detail === "string"
    )
      return { message: error.detail, retryable: false };
  }
  return {
    message:
      "The server could not save the worker connection. Check the server connection and try again.",
    retryable: true,
  };
}

export function workerSourceBindingError(
  config: WorkjetThreadConfig,
  selectedInstanceId: string | null,
  connection: WorkjetConnectionSummary,
): string | null {
  const next = withWorkerSourceConnection(config, selectedInstanceId, connection);
  return next
    ? retainWorkjetCtoxBinding(config, next).error
    : "Select an authorized worker connection for this project's instance.";
}
