import type {
  WorkjetCapabilityBinding,
  WorkjetThreadConfig,
  WorkjetThreadConfigV2,
  WorkjetThreadRole,
} from "@t3tools/contracts";
import { normalizeWorkjetThreadConfig } from "@t3tools/contracts";

import { defaultCapabilityRegistry, type CapabilityRegistry } from "./registry.ts";

export type CapabilityActivationIssueCode =
  | "unknown-capability"
  | "role-forbidden"
  | "child-delegation-forbidden"
  | "binding-required"
  | "binding-duplicated"
  | "binding-foreign"
  | "binding-unreachable";

export type CapabilityActivationIssue = {
  readonly capabilityId: string;
  readonly code: CapabilityActivationIssueCode;
};

export type CapabilityActivationValidation = {
  readonly config: WorkjetThreadConfigV2;
  readonly issues: ReadonlyArray<CapabilityActivationIssue>;
};

export function validateCapabilityActivation(input: {
  readonly config: WorkjetThreadConfig;
  readonly knownConnectionIds?: ReadonlySet<string>;
  readonly reachableConnectionIds?: ReadonlySet<string>;
  readonly registry?: CapabilityRegistry;
}): CapabilityActivationValidation {
  const config = normalizeWorkjetThreadConfig(input.config);
  const registry = input.registry ?? defaultCapabilityRegistry;
  const enabled = Array.from(new Set(config.enabledCapabilityIds));
  const enabledSet = new Set(enabled);
  const bindings = config.capabilityBindings.filter((binding) =>
    enabledSet.has(binding.capabilityId),
  );
  const issues: CapabilityActivationIssue[] = [];

  for (const capabilityId of enabled) {
    const manifest = registry.find(capabilityId);
    if (!manifest) {
      issues.push({ capabilityId, code: "unknown-capability" });
      continue;
    }
    if (!manifest.activationPolicy.allowedRoles.includes(config.role)) {
      issues.push({ capabilityId, code: "role-forbidden" });
    }
    if (config.role === "worker" && manifest.activationPolicy.childDelegation === "forbidden") {
      issues.push({ capabilityId, code: "child-delegation-forbidden" });
    }
    if (manifest.activationPolicy.requiredBinding === "ctox-connection") {
      const matching = bindings.filter((binding) => binding.capabilityId === capabilityId);
      if (matching.length === 0) {
        issues.push({ capabilityId, code: "binding-required" });
      } else if (matching.length !== 1) {
        issues.push({ capabilityId, code: "binding-duplicated" });
      } else {
        const connectionId = matching[0]!.target.connectionId;
        if (input.knownConnectionIds && !input.knownConnectionIds.has(connectionId)) {
          issues.push({ capabilityId, code: "binding-foreign" });
        } else if (
          input.reachableConnectionIds &&
          !input.reachableConnectionIds.has(connectionId)
        ) {
          issues.push({ capabilityId, code: "binding-unreachable" });
        }
      }
    }
  }

  return {
    config: { ...config, enabledCapabilityIds: enabled, capabilityBindings: bindings },
    issues,
  };
}

export function resolveDelegatedCapabilities(input: {
  readonly parentCapabilityIds: ReadonlyArray<string>;
  readonly requestedCapabilityIds?: ReadonlyArray<string>;
  readonly targetRole?: WorkjetThreadRole;
  readonly registry?: CapabilityRegistry;
}): {
  readonly capabilityIds: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<CapabilityActivationIssue>;
} {
  const registry = input.registry ?? defaultCapabilityRegistry;
  const parent = new Set(input.parentCapabilityIds);
  const explicit = input.requestedCapabilityIds !== undefined;
  const candidates = explicit ? input.requestedCapabilityIds : input.parentCapabilityIds;
  const resolved: string[] = [];
  const issues: CapabilityActivationIssue[] = [];
  for (const capabilityId of Array.from(new Set(candidates))) {
    const manifest = registry.find(capabilityId);
    if (!manifest || !parent.has(capabilityId)) continue;
    const forbidden = manifest.activationPolicy.childDelegation === "forbidden";
    const roleForbidden = !manifest.activationPolicy.allowedRoles.includes(
      input.targetRole ?? "worker",
    );
    if (forbidden || roleForbidden) {
      if (explicit) {
        issues.push({ capabilityId, code: "child-delegation-forbidden" });
      }
      continue;
    }
    resolved.push(capabilityId);
  }
  return { capabilityIds: resolved, issues };
}

export function bindingForCapability(
  bindings: ReadonlyArray<WorkjetCapabilityBinding>,
  capabilityId: string,
) {
  return bindings.find((binding) => binding.capabilityId === capabilityId);
}
