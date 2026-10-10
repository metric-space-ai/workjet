import {
  compileCapabilityPrompt,
  bindingForCapability,
  defaultCapabilityRegistry,
  validateCapabilityActivation,
  type CapabilityRegistry,
} from "@metric-space-ai/workjet-capabilities";
import {
  workjetExecutionRole,
  type WorkjetCapabilityId,
  type WorkjetConnectionId,
  type WorkjetThreadConfig,
  type WorkjetThreadRole,
} from "@workjet/contracts";

export interface ThreadCapabilityContext {
  readonly workjetRole: WorkjetThreadRole;
  readonly mcpCapabilityIds: ReadonlyArray<WorkjetCapabilityId>;
  readonly promptCapabilityIds: ReadonlyArray<WorkjetCapabilityId>;
  readonly compiledManagedPrompt: string;
  readonly decisionHubConnectionId?: WorkjetConnectionId;
  readonly ctoxBusinessOsBinding?: {
    readonly connectionId: WorkjetConnectionId;
    readonly instanceId: string;
  };
}

export function resolveThreadCapabilityContext(
  workjetConfig: WorkjetThreadConfig,
  registry: CapabilityRegistry = defaultCapabilityRegistry,
  connections?: {
    readonly knownConnectionIds: ReadonlySet<string>;
    readonly reachableConnectionIds: ReadonlySet<string>;
    readonly connectionInstances?: ReadonlyMap<string, string>;
  },
  globalManagedInstructions = "",
): ThreadCapabilityContext {
  const activation = validateCapabilityActivation({
    config: workjetConfig,
    registry,
    ...connections,
  });
  const blocked = new Set(activation.issues.map(({ capabilityId }) => capabilityId));
  const enabled = activation.config.enabledCapabilityIds.filter(
    (capabilityId) => !blocked.has(capabilityId),
  );
  const mcpManifests = registry.resolveEnabled(enabled, "workjet-mcp");
  const promptManifests = registry.resolveEnabled(enabled, "workjet-prompt");
  const decisionHubBinding = bindingForCapability(
    activation.config.capabilityBindings,
    "decision-hub",
  );
  const team = workjetConfig.schemaVersion === 2 ? workjetConfig.team : undefined;

  const ctoxBinding = bindingForCapability(
    activation.config.capabilityBindings,
    "ctox-business-os",
  );
  return Object.freeze({
    workjetRole: workjetExecutionRole(workjetConfig),
    mcpCapabilityIds: Object.freeze(mcpManifests.map((manifest) => manifest.id)),
    promptCapabilityIds: Object.freeze(promptManifests.map((manifest) => manifest.id)),
    compiledManagedPrompt: compileCapabilityPrompt({
      role: workjetExecutionRole(workjetConfig),
      ...(team
        ? {
            team:
              workjetConfig.schemaVersion === 2 && workjetConfig.goal
                ? { ...team, goal: workjetConfig.goal.objective }
                : team,
          }
        : {}),
      managedInstructions: [
        globalManagedInstructions.trim(),
        workjetConfig.managedInstructions.trim(),
        ...(workjetConfig.schemaVersion === 2 && workjetConfig.goal
          ? [
              `Durable Workjet goal status: ${workjetConfig.goal.status}. ${workjetConfig.goal.reason ?? ""} Do not reactivate a paused goal; only an explicit Owner resume may do that.`,
              ...(workjetConfig.team?.role === "specialist" && workjetConfig.goal.kanban
                ? [
                    "Retained mini-kanban (update first at the next iteration):",
                    ...workjetConfig.goal.kanban.cards.map(
                      (card) =>
                        `${card.id}: ${card.status} — ${card.title}${card.evidence ? ` (${card.evidence})` : ""}`,
                    ),
                  ]
                : []),
            ]
          : []),
      ]
        .filter((value) => value.length > 0)
        .join("\n\n"),
      manifests: promptManifests,
    }),
    ...(enabled.includes("decision-hub") && decisionHubBinding !== undefined
      ? { decisionHubConnectionId: decisionHubBinding.target.connectionId }
      : {}),
    ...(enabled.includes("ctox-business-os") && ctoxBinding?.target.instanceId
      ? {
          ctoxBusinessOsBinding: Object.freeze({
            connectionId: ctoxBinding.target.connectionId,
            instanceId: ctoxBinding.target.instanceId,
          }),
        }
      : {}),
  });
}
