import {
  CommandId,
  type CtoxComputerEndpoint,
  type CtoxComputerOperationalCapability,
  type CtoxWorkjetComputerControlRequest,
  type CtoxWorkjetComputerControlResult,
  type CtoxWorkjetComputerProjection,
} from "@workjet/contracts";

export interface OperationalComputerEnrollment {
  readonly computerId: string;
  readonly displayName: string;
  readonly hostingMode: "workstation" | "self_hosted";
  readonly agentless: boolean;
  readonly agentCapabilities: readonly string[];
  readonly capabilityConfig: readonly CtoxComputerOperationalCapability[];
  readonly endpoint: { readonly ref: string; readonly connection: CtoxComputerEndpoint } | null;
}

/** Each step uses the selected instance's native policy and correlated command receipt. */
export async function enrollOperationalComputer(
  enrollment: OperationalComputerEnrollment,
  control: (request: CtoxWorkjetComputerControlRequest) => Promise<CtoxWorkjetComputerControlResult>,
  newCommandId: () => CommandId,
  isCurrent: () => boolean,
): Promise<CtoxWorkjetComputerProjection> {
  if (!isCurrent()) throw new Error("The selected Business OS changed. Reopen Add computer.");
  const { capabilityConfig, endpoint } = enrollment;
  const requiresEndpoint = capabilityConfig.some((capability) => capability.kind !== "gpu");
  if (enrollment.agentless && (enrollment.hostingMode !== "self_hosted" ||
    enrollment.agentCapabilities.length > 0 || capabilityConfig.length !== 1 ||
    capabilityConfig[0]?.kind !== "storage")) {
    throw new Error("A storage-only computer needs one storage capability.");
  }
  if (requiresEndpoint !== (endpoint !== null)) {
    throw new Error("Choose an endpoint for the build or storage capability.");
  }
  for (const capability of capabilityConfig) {
    if (capability.kind === "build" && (endpoint?.connection.protocol !== "ssh" ||
      capability.ssh_endpoint_ref !== endpoint.ref)) {
      throw new Error("Build computers require their assigned SSH endpoint.");
    }
    if (capability.kind === "storage" && (capability.endpoint_ref !== endpoint?.ref ||
      capability.protocol !== endpoint.connection.protocol)) {
      throw new Error("Storage needs its assigned endpoint and protocol.");
    }
  }
  const assignment = await control({
    action: "computer.assign",
    commandId: newCommandId(),
    computerId: enrollment.computerId,
    displayName: enrollment.displayName,
    hostingMode: enrollment.hostingMode,
    capabilities: enrollment.agentCapabilities,
    capabilityConfig,
    agentless: enrollment.agentless,
    selfHostedColocation: false,
  });
  if (!isCurrent()) throw new Error("The selected Business OS changed. Reopen Add computer.");
  if (assignment._tag !== "completed" || assignment.response.action !== "computer.assign" ||
    assignment.response.computer.id !== enrollment.computerId ||
    assignment.response.computer.status !== "assigned" ||
    assignment.response.computer.hostingMode !== enrollment.hostingMode ||
    !capabilityConfig.every((capability) =>
      assignment.response.action === "computer.assign" &&
      assignment.response.computer.capabilities.includes(capability.kind))) {
    throw new Error("The Business OS did not confirm this computer.");
  }
  if (endpoint !== null) {
    const result = await control({
      action: "computer.endpoint.upsert",
      commandId: newCommandId(),
      computerId: enrollment.computerId,
      endpointRef: endpoint.ref,
      connection: endpoint.connection,
    });
    if (!isCurrent()) throw new Error("The selected Business OS changed. Reopen Add computer.");
    if (result._tag !== "completed" || result.response.action !== "computer.endpoint.upsert" ||
      result.response.computerId !== enrollment.computerId ||
      result.response.endpointRef !== endpoint.ref || !result.response.enabled) {
      throw new Error("Computer registered; its access endpoint still needs confirmation. Retry.");
    }
  }
  return assignment.response.computer;
}
