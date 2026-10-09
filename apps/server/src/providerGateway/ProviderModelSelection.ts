import type { WorkjetGatewayProviderModelSelection } from "@workjet/contracts";
import type { GatewayAccount, ProviderGatewayConfiguration } from "./ProviderGatewayConfig.ts";

export function providerModelSelections(configuration: ProviderGatewayConfiguration): ReadonlyArray<WorkjetGatewayProviderModelSelection> {
  return configuration.providerModels ?? [...new Set(configuration.accounts.map(account => account.provider))]
    .map(provider => ({ provider, modelIds: [...new Set(configuration.accounts
      .filter(account => account.provider === provider).flatMap(account => account.models))] }));
}

/** Preserve legacy effective lists when adopting provider-wide selection. */
export function adoptProviderModelSelection(configuration: ProviderGatewayConfiguration): ProviderGatewayConfiguration {
  if (configuration.providerModels !== undefined) return configuration;
  const providerModels = providerModelSelections(configuration);
  return { ...configuration, providerModels, accounts: configuration.accounts.map(account => ({
    ...account,
    legacyModelIds: account.models,
    excludedModels: providerModels.find(entry => entry.provider === account.provider)!.modelIds
      .filter(id => !account.models.includes(id)),
  })) };
}

export function applyProviderModelSelection(
  configuration: ProviderGatewayConfiguration,
  updates: ReadonlyArray<WorkjetGatewayProviderModelSelection>,
): ProviderGatewayConfiguration {
  const adopted = adoptProviderModelSelection(configuration);
  const providerModels = [...adopted.providerModels!];
  for (const update of updates) {
    const index = providerModels.findIndex(entry => entry.provider === update.provider);
    if (index < 0) providerModels.push(update);
    else providerModels[index] = update;
  }
  return projectProviderModelSelection({ ...adopted, providerModels });
}

/** A provider-wide live union does not prove access for an unknown account. */
export function projectProviderModelSelection(configuration: ProviderGatewayConfiguration): ProviderGatewayConfiguration {
  if (configuration.providerModels === undefined) return configuration;
  return { ...configuration, accounts: configuration.accounts.map(account => {
    const selection = configuration.providerModels!.find(entry => entry.provider === account.provider);
    if (selection === undefined) return account;
    const access = account.availableModelIds ?? account.legacyModelIds ?? account.models;
    const excluded = new Set(account.excludedModels ?? []);
    return { ...account, models: selection.modelIds.filter(id => access.includes(id) && !excluded.has(id)) };
  }) };
}

/** Observed new accounts inherit selection; credential replacements retain exclusions. */
export function retainProviderModelSelection(
  existing: ProviderGatewayConfiguration,
  accounts: ReadonlyArray<GatewayAccount>,
): ProviderGatewayConfiguration {
  if (existing.providerModels === undefined) return { ...existing, accounts };
  const providerModels = [...existing.providerModels];
  for (const account of accounts) {
    if (!providerModels.some(entry => entry.provider === account.provider)) {
      providerModels.push({ provider: account.provider, modelIds: account.models });
    }
  }
  return projectProviderModelSelection({ ...existing, providerModels, accounts });
}

/** Only substitutions already confirmed by an account's real model-list repair. */
export function reconcileAccountModelRepairs(configuration: ProviderGatewayConfiguration, accounts: ReadonlyArray<GatewayAccount>): ProviderGatewayConfiguration {
  if (configuration.providerModels === undefined) return { ...configuration, accounts };
  const replacements = new Map<string, Map<string, string>>();
  for (const before of configuration.accounts) {
    const after = accounts.find(account => account.id === before.id);
    if (before.provider !== "claude" || after === undefined) continue;
    for (const id of before.models) {
      const canonical = id.replace(/\.(?=\d)/g, "-");
      if (canonical !== id && after.models.includes(canonical)) {
        const changes = replacements.get(before.provider) ?? new Map<string, string>();
        changes.set(id, canonical); replacements.set(before.provider, changes);
      }
    }
  }
  const repair = (provider: string, ids: ReadonlyArray<string>) =>
    [...new Set(ids.map(id => replacements.get(provider)?.get(id) ?? id))];
  return projectProviderModelSelection({
    ...configuration,
    providerModels: configuration.providerModels.map(entry => ({ ...entry, modelIds: repair(entry.provider, entry.modelIds) })),
    accounts: accounts.map(account => ({
      ...account,
      ...(account.legacyModelIds === undefined ? {} : { legacyModelIds: repair(account.provider, account.legacyModelIds) }),
      ...(account.excludedModels === undefined ? {} : { excludedModels: repair(account.provider, account.excludedModels) }),
    })),
  });
}
