import type { ServerProvider } from "@workjet/contracts";
import { resolveProjectTeamModelSelection } from "./providerInstances";

/**
 * Hinweis oben in der Projektübersicht, wenn keine erreichbare Umgebung ein
 * Modell-Konto mit konkretem Modell hat. Solange keine Umgebung ihre
 * Konfiguration geliefert hat, gibt es keinen Hinweis (kein Fehlalarm beim Laden).
 */
export function projectOverviewNeedsModelAccount(
  environments: ReadonlyArray<{
    readonly serverConfig?: { readonly providers?: ReadonlyArray<ServerProvider> } | null;
  }>,
): boolean {
  const loaded = environments.filter((environment) => environment.serverConfig?.providers);
  return (
    loaded.length > 0 &&
    loaded.every(
      (environment) =>
        resolveProjectTeamModelSelection(environment.serverConfig?.providers ?? []) === null,
    )
  );
}
