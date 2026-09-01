import {
  compileCapabilityPrompt,
  bindingForCapability,
  defaultCapabilityRegistry,
  validateCapabilityActivation,
  type CapabilityRegistry,
} from "@metric-space-ai/workjet-capabilities";
import type {
  WorkjetCapabilityId,
  WorkjetConnectionId,
  WorkjetThreadConfig,
  WorkjetThreadRole,
} from "@t3tools/contracts";

export interface ThreadCapabilityContext {
  readonly workjetRole: WorkjetThreadRole;
  readonly mcpCapabilityIds: ReadonlyArray<WorkjetCapabilityId>;
  readonly promptCapabilityIds: ReadonlyArray<WorkjetCapabilityId>;
  readonly compiledManagedPrompt: string;
  readonly decisionHubConnectionId?: WorkjetConnectionId;
}

export function resolveThreadCapabilityContext(
  workjetConfig: WorkjetThreadConfig,
  registry: CapabilityRegistry = defaultCapabilityRegistry,
  connections?: {
    readonly knownConnectionIds: ReadonlySet<string>;
    readonly reachableConnectionIds: ReadonlySet<string>;
  },
  globalManagedInstructions = "",
): ThreadCapabilityContext {
  const activation = validateCapabilityActivation({
    config: workjetConfig,
    registry,
    ...(connections ?? {}),
  });
  const blocked = new Set(activation.issues.map(({ capabilityId }) => capabilityId));
  const enabled = activation.config.enabledCapabilityIds.filter(
    (capabilityId) => !blocked.has(capabilityId),
  );
  const mcpManifests = registry.resolveEnabled(enabled, "t3-mcp");
  const promptManifests = registry.resolveEnabled(enabled, "t3-prompt");
  const decisionHubBinding = bindingForCapability(
    activation.config.capabilityBindings,
    "decision-hub",
  );

  return Object.freeze({
    workjetRole: workjetConfig.role,
    mcpCapabilityIds: Object.freeze(mcpManifests.map((manifest) => manifest.id)),
    promptCapabilityIds: Object.freeze(promptManifests.map((manifest) => manifest.id)),
    compiledManagedPrompt: compileCapabilityPrompt({
      role: workjetConfig.role,
      managedInstructions: [
        globalManagedInstructions.trim(),
        workjetConfig.managedInstructions.trim(),
      ]
        .filter((value) => value.length > 0)
        .join("\n\n"),
      manifests: promptManifests,
    }),
    ...(enabled.includes("decision-hub") && decisionHubBinding !== undefined
      ? { decisionHubConnectionId: decisionHubBinding.target.connectionId }
      : {}),
  });
}
