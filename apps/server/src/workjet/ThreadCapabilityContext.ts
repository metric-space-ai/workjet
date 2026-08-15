import {
  compileCapabilityPrompt,
  defaultCapabilityRegistry,
  type CapabilityRegistry,
} from "@metric-space-ai/workjet-capabilities";
import type {
  WorkjetCapabilityId,
  WorkjetThreadConfig,
  WorkjetThreadRole,
} from "@t3tools/contracts";

export interface ThreadCapabilityContext {
  readonly workjetRole: WorkjetThreadRole;
  readonly mcpCapabilityIds: ReadonlyArray<WorkjetCapabilityId>;
  readonly promptCapabilityIds: ReadonlyArray<WorkjetCapabilityId>;
  readonly compiledManagedPrompt: string;
}

export function resolveThreadCapabilityContext(
  workjetConfig: WorkjetThreadConfig,
  registry: CapabilityRegistry = defaultCapabilityRegistry,
): ThreadCapabilityContext {
  const mcpManifests = registry.resolveEnabled(workjetConfig.enabledCapabilityIds, "t3-mcp");
  const promptManifests = registry.resolveEnabled(workjetConfig.enabledCapabilityIds, "t3-prompt");

  return Object.freeze({
    workjetRole: workjetConfig.role,
    mcpCapabilityIds: Object.freeze(mcpManifests.map((manifest) => manifest.id)),
    promptCapabilityIds: Object.freeze(promptManifests.map((manifest) => manifest.id)),
    compiledManagedPrompt: compileCapabilityPrompt({
      role: workjetConfig.role,
      managedInstructions: workjetConfig.managedInstructions,
      manifests: promptManifests,
    }),
  });
}
