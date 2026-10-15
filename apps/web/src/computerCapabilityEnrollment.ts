import {
  type CommandId,
  type CtoxComputerEndpoint,
  type CtoxComputerOperationalCapability,
  type CtoxWorkjetComputerControlRequest,
  type CtoxWorkjetComputerControlResult,
  type CtoxWorkjetComputerProjection,
  type CtoxWorkjetComputerSshKey,
} from "@workjet/contracts";

type SshEndpoint = Extract<CtoxComputerEndpoint, { readonly protocol: "ssh" }>;
type EnrollmentEndpoint =
  | {
      readonly ref: string;
      readonly connection: CtoxComputerEndpoint;
      readonly createNativeKey?: false;
    }
  | {
      readonly ref: string;
      readonly connection: Omit<SshEndpoint, "private_key" | "passphrase">;
      readonly createNativeKey: true;
    };

export interface OperationalComputerEnrollment {
  readonly computerId: string;
  readonly displayName: string;
  readonly hostingMode: "workstation" | "self_hosted";
  readonly agentless: boolean;
  readonly agentCapabilities: readonly string[];
  readonly capabilityConfig: readonly CtoxComputerOperationalCapability[];
  readonly preserveOperationalCapabilities?: boolean;
  readonly endpoint: EnrollmentEndpoint | null;
}

/** Each step uses the selected instance's native policy and correlated command receipt. */
export async function enrollOperationalComputer(
  enrollment: OperationalComputerEnrollment,
  control: (
    request: CtoxWorkjetComputerControlRequest,
  ) => Promise<CtoxWorkjetComputerControlResult>,
  newCommandId: () => CommandId,
  isCurrent: () => boolean,
  onSshKeyReady?: (key: CtoxWorkjetComputerSshKey) => void,
): Promise<CtoxWorkjetComputerProjection> {
  if (!isCurrent()) throw new Error("Instanz gewechselt. Rechner erneut hinzufügen.");
  const { capabilityConfig, endpoint } = enrollment;
  if (
    enrollment.preserveOperationalCapabilities &&
    (enrollment.agentless || capabilityConfig.length > 0 || endpoint !== null)
  ) {
    throw new Error("Gespeicherte Rollen behalten oder ersetzen, nicht beides.");
  }
  if (endpoint?.createNativeKey && endpoint.connection.protocol !== "ssh") {
    throw new Error("SSH-Schlüssel braucht einen SSH-Zugang.");
  }
  const requiresEndpoint = capabilityConfig.some((capability) => capability.kind !== "gpu");
  if (
    enrollment.agentless &&
    (enrollment.hostingMode !== "self_hosted" ||
      enrollment.agentCapabilities.length > 0 ||
      capabilityConfig.length !== 1 ||
      capabilityConfig[0]?.kind !== "storage")
  ) {
    throw new Error("Reiner Speicher-Rechner braucht eine Speicherrolle.");
  }
  if (requiresEndpoint !== (endpoint !== null)) {
    throw new Error("Zugang für Build oder Speicher wählen.");
  }
  for (const capability of capabilityConfig) {
    if (
      capability.kind === "build" &&
      (endpoint?.connection.protocol !== "ssh" || capability.ssh_endpoint_ref !== endpoint.ref)
    ) {
      throw new Error("Build-Rechner braucht seinen SSH-Zugang.");
    }
    if (
      capability.kind === "storage" &&
      (endpoint === null ||
        capability.endpoint_ref !== endpoint.ref ||
        capability.protocol !== endpoint.connection.protocol)
    ) {
      throw new Error("Speicher braucht Zugang und Protokoll.");
    }
  }
  const assignment = await control({
    action: "computer.assign",
    commandId: newCommandId(),
    computerId: enrollment.computerId,
    displayName: enrollment.displayName,
    hostingMode: enrollment.hostingMode,
    capabilities: enrollment.agentCapabilities,
    ...(enrollment.preserveOperationalCapabilities ? {} : { capabilityConfig }),
    agentless: enrollment.agentless,
    selfHostedColocation: false,
  });
  if (!isCurrent()) throw new Error("Instanz gewechselt. Rechner erneut hinzufügen.");
  if (
    assignment._tag !== "completed" ||
    assignment.response.action !== "computer.assign" ||
    assignment.response.computer.id !== enrollment.computerId ||
    assignment.response.computer.status !== "assigned" ||
    assignment.response.computer.hostingMode !== enrollment.hostingMode ||
    !capabilityConfig.every(
      (capability) =>
        assignment.response.action === "computer.assign" &&
        assignment.response.computer.capabilities.includes(capability.kind),
    )
  ) {
    throw new Error("Instanz hat den Rechner nicht bestätigt.");
  }
  let sshKey: CtoxWorkjetComputerSshKey | undefined;
  if (endpoint !== null) {
    let connection: CtoxComputerEndpoint;
    if (endpoint.createNativeKey) {
      const result = await control({
        action: "computer.ssh_key.ensure",
        commandId: newCommandId(),
        computerId: enrollment.computerId,
      });
      if (!isCurrent()) throw new Error("Instanz gewechselt. Rechner erneut hinzufügen.");
      if (
        result._tag !== "completed" ||
        result.response.action !== "computer.ssh_key.ensure" ||
        result.response.computerId !== enrollment.computerId
      ) {
        throw new Error("Rechner angelegt, SSH-Schlüssel noch unbestätigt. Erneut versuchen.");
      }
      const response = result.response;
      sshKey = {
        contract: response.contract,
        computerId: response.computerId,
        privateKey: response.privateKey,
        publicKey: response.publicKey,
        publicKeySha256: response.publicKeySha256,
      };
      connection = { ...endpoint.connection, private_key: sshKey.privateKey, passphrase: null };
    } else {
      connection = endpoint.connection;
    }
    const result = await control({
      action: "computer.endpoint.upsert",
      commandId: newCommandId(),
      computerId: enrollment.computerId,
      endpointRef: endpoint.ref,
      connection,
    });
    if (!isCurrent()) throw new Error("Instanz gewechselt. Rechner erneut hinzufügen.");
    if (
      result._tag !== "completed" ||
      result.response.action !== "computer.endpoint.upsert" ||
      result.response.computerId !== enrollment.computerId ||
      result.response.endpointRef !== endpoint.ref ||
      !result.response.enabled
    ) {
      throw new Error("Rechner angelegt, Zugang noch unbestätigt. Erneut versuchen.");
    }
  }
  if (sshKey) onSshKeyReady?.(sshKey);
  return assignment.response.computer;
}
