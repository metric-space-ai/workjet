import type {
  ProviderInstanceId,
  ServerProvider,
  WorkjetGatewayModelSummary,
} from "@workjet/contracts";

/** Native ACP discovery belongs to the exact selected computer/provider instance. */
export function getMiniMaxManualModelCatalog(
  providers: readonly ServerProvider[],
  instanceId: ProviderInstanceId,
) {
  const status = providers.find(
    (provider) => provider.instanceId === instanceId && provider.driver === "minimax",
  );
  const models: WorkjetGatewayModelSummary[] =
    status?.enabled && status.auth.status === "authenticated"
      ? status.models.map((model) => ({
          id: model.slug,
          displayName: model.name,
          providers: ["minimax"],
          accountIds: [],
        }))
      : [];
  return {
    models,
    unavailableReason:
      models.length === 0
        ? status?.enabled === false
          ? "MiniMax Code is disabled on this computer."
          : (status?.message ??
            "MiniMax Code has not reported models on this computer. Check its native profile in Harness runtimes.")
        : null,
  };
}
