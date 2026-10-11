import type {
  CtoxComputerOperationalCapability,
  CtoxWorkjetComputerProjection,
} from "@workjet/contracts";
import type { OperationalComputerEnrollment } from "../../computerCapabilityEnrollment";
import { randomUUID } from "../../lib/utils";
import { Checkbox } from "../ui/checkbox";

/**
 * Die drei Haken eines Rechners (Owner-Vorgabe): Build an, Speicher aus, GPU an,
 * sobald eine erkannt ist. Coding geht immer, ohne eigenen Haken. Alles andere
 * (Kapazität, Verzeichnis, Toolchains, Zugang) wird abgeleitet, nie abgefragt.
 */
export interface ComputerRoles {
  readonly build: boolean;
  readonly storage: boolean;
  readonly gpu: boolean;
}

export const DEFAULT_COMPUTER_ROLES: ComputerRoles = { build: true, storage: false, gpu: false };

/** Workjet-eigenes Verzeichnis auf dem Rechner; „auf dem Rechner entfernen“ fasst nur das an. */
export const WORKJET_COMPUTER_ROOT = "~/.workjet";

type BuildCapability = CtoxComputerOperationalCapability & { readonly kind: "build" };
type StorageCapability = CtoxComputerOperationalCapability & { readonly kind: "storage" };
type GpuCapability = CtoxComputerOperationalCapability & { readonly kind: "gpu" };

export function savedCapability<K extends CtoxComputerOperationalCapability["kind"]>(
  native: CtoxWorkjetComputerProjection | null | undefined,
  kind: K,
): Extract<CtoxComputerOperationalCapability, { kind: K }> | undefined {
  return native?.capabilityConfig?.find(
    (entry): entry is Extract<CtoxComputerOperationalCapability, { kind: K }> =>
      entry.kind === kind,
  );
}

/** Rollen einer bestehenden Zeile, aus der bestätigten Instanz-Projektion. */
export function computerRolesOf(
  native: CtoxWorkjetComputerProjection | null | undefined,
): ComputerRoles {
  const capabilities = native?.capabilities ?? [];
  return {
    build: capabilities.includes("build"),
    storage: capabilities.includes("storage"),
    gpu: capabilities.includes("gpu"),
  };
}

/** SSH-Zugang, den die App aus der Verbindung schon kennt. */
export interface ComputerSshAccess {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly hostKeySha256: string;
  readonly hostKeyAlgorithm: string | null;
}

const HOST_KEY_ALGORITHMS = [
  "ssh-ed25519",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "rsa-sha2-256",
  "rsa-sha2-512",
] as const;

function hostKeyAlgorithm(value: string | null): (typeof HOST_KEY_ALGORITHMS)[number] | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return (
    HOST_KEY_ALGORITHMS.find((entry) => entry === normalized) ??
    (normalized === "ed25519" ? "ssh-ed25519" : null)
  );
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

/**
 * Build-, Speicher- und GPU-Eintrag mit Standards. „Wenn Build, dann alle
 * CPUs“: `jobs` folgt der CPU-Zahl, sobald sie bekannt ist.
 */
export function buildRoleEnrollment(input: {
  readonly computerId: string;
  readonly displayName: string;
  readonly roles: ComputerRoles;
  readonly agentCapabilities: readonly string[];
  readonly access: ComputerSshAccess | null;
  readonly native?: CtoxWorkjetComputerProjection | null;
  readonly cpuCount?: number | null;
}): OperationalComputerEnrollment {
  const savedBuild = savedCapability(input.native, "build");
  const savedStorage = savedCapability(input.native, "storage");
  const savedGpu = savedCapability(input.native, "gpu");
  const endpointRef =
    savedBuild?.ssh_endpoint_ref ??
    (savedStorage?.protocol === "ssh" ? savedStorage.endpoint_ref : undefined) ??
    `endpoint-${randomUUID()}`;
  const capabilities: CtoxComputerOperationalCapability[] = [];
  if (input.roles.build) {
    const build: BuildCapability = {
      kind: "build",
      ssh_endpoint_ref: endpointRef,
      slots: savedBuild?.slots ?? 1,
      jobs:
        input.cpuCount && input.cpuCount > 0
          ? clampInteger(input.cpuCount, 1, 64)
          : (savedBuild?.jobs ?? 2),
      lane_root: savedBuild?.lane_root ?? `${WORKJET_COMPUTER_ROOT}/build`,
      disk_floor_gib: savedBuild?.disk_floor_gib ?? 20,
      toolchains: savedBuild?.toolchains ?? ["rust-stable"],
    };
    capabilities.push(build);
  }
  if (input.roles.storage) {
    const storage: StorageCapability = {
      kind: "storage",
      endpoint_ref: endpointRef,
      protocol: "ssh",
      root:
        savedStorage?.protocol === "ssh" ? savedStorage.root : `${WORKJET_COMPUTER_ROOT}/storage`,
      quota_gib: savedStorage?.quota_gib ?? null,
      purposes: savedStorage?.purposes ?? ["artifacts"],
    };
    capabilities.push(storage);
  }
  if (input.roles.gpu && savedGpu) {
    const gpu: GpuCapability = { ...savedGpu };
    capabilities.push(gpu);
  }
  const needsEndpoint = input.roles.build || input.roles.storage;
  if (needsEndpoint && input.access === null) {
    throw new Error("Build und Speicher brauchen einen SSH-Rechner.");
  }
  const access = input.access;
  const algorithm = hostKeyAlgorithm(access?.hostKeyAlgorithm ?? null);
  return {
    computerId: input.computerId,
    displayName: input.displayName,
    hostingMode: "workstation",
    agentless: false,
    agentCapabilities: input.agentCapabilities,
    capabilityConfig: capabilities,
    endpoint:
      needsEndpoint && access
        ? {
            ref: endpointRef,
            createNativeKey: true,
            connection: {
              protocol: "ssh",
              host: access.host,
              port: access.port,
              username: access.username,
              root: input.roles.build
                ? (savedBuild?.lane_root ?? `${WORKJET_COMPUTER_ROOT}/build`)
                : `${WORKJET_COMPUTER_ROOT}/storage`,
              host_key_sha256: access.hostKeySha256,
              ...(algorithm ? { host_key_algorithm: algorithm } : {}),
            },
          }
        : null,
  };
}

/** Die drei Haken. Kein Haken klappt weitere Felder auf. */
export function ComputerRoleCheckboxes({
  value,
  onChange,
  disabled = false,
  endpointAvailable,
  gpuAvailable,
}: {
  readonly value: ComputerRoles;
  readonly onChange: (next: ComputerRoles) => void;
  readonly disabled?: boolean;
  /** Build und Speicher brauchen SSH-Zugang (nicht „Local“). */
  readonly endpointAvailable: boolean;
  /** GPU nur, wenn eine erkannt oder schon gespeichert ist. */
  readonly gpuAvailable: boolean;
}) {
  const entries = [
    { key: "build", label: "Build", enabled: endpointAvailable },
    { key: "storage", label: "Speicher", enabled: endpointAvailable },
    { key: "gpu", label: "GPU", enabled: gpuAvailable },
  ] as const;
  return (
    <fieldset
      className="flex flex-wrap items-center gap-x-5 gap-y-2"
      data-slot="computer-roles"
      disabled={disabled}
    >
      <legend className="sr-only">Verwendung</legend>
      {entries.map((entry) => (
        <label
          key={entry.key}
          className="flex items-center gap-2 text-[13.5px] has-disabled:opacity-60"
          title={
            entry.enabled
              ? undefined
              : entry.key === "gpu"
                ? "Keine GPU erkannt"
                : "Nur per SSH oder Tailscale"
          }
        >
          <Checkbox
            checked={entry.enabled && value[entry.key]}
            disabled={disabled || !entry.enabled}
            data-computer-role={entry.key}
            onCheckedChange={(checked) => onChange({ ...value, [entry.key]: checked === true })}
          />
          {entry.label}
        </label>
      ))}
    </fieldset>
  );
}
