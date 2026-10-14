import type {
  WorkjetConfiguration,
  WorkjetGatewayAccountModels,
  WorkjetGatewayCatalog,
  WorkjetGatewayHealth,
  WorkjetGatewayModelChecks,
  WorkjetHarnessAvailabilitySnapshot,
  WorkjetOfficialCodingModelExport,
} from "@workjet/contracts";

/**
 * A live account list is the only source of model IDs. Profiles provide an
 * explicit coding route, never additional model IDs. Missing observations
 * remain visible but cannot enter a worker draw.
 */
export function officialCodingModelExport(input: {
  catalog: WorkjetGatewayCatalog;
  health: WorkjetGatewayHealth;
  checks: WorkjetGatewayModelChecks;
  accountModels: ReadonlyArray<WorkjetGatewayAccountModels>;
  workjet: WorkjetConfiguration;
  harnesses: WorkjetHarnessAvailabilitySnapshot;
  observedAtMs: number;
}): WorkjetOfficialCodingModelExport {
  const { catalog, health, checks, accountModels, workjet, harnesses, observedAtMs } = input;
  const lists = new Map(accountModels.map((list) => [list.accountId, list]));
  const healthById = new Map(health.accounts.map((account) => [account.accountId, account]));
  const checked = new Map(
    checks.checks.map((check) => [`${check.accountId}\0${check.modelId}`, check]),
  );
  const routes = new Map(workjet.llmRoutes.map((route) => [route.id, route]));
  const computers = new Map(workjet.computers.map((computer) => [computer.id, computer]));
  const probes = new Map(harnesses.harnesses.map((harness) => [harness.harness, harness]));
  const models: WorkjetOfficialCodingModelExport["models"][number][] = [];
  const unverifiedAccounts: WorkjetOfficialCodingModelExport["unverifiedAccounts"][number][] = [];

  for (const account of catalog.accounts) {
    const list = lists.get(account.id);
    if (list?.state !== "observed") {
      unverifiedAccounts.push({
        accountId: account.id,
        provider: account.provider,
        reason: list?.reason ?? "catalog-unavailable",
      });
      continue;
    }
    const accountHealth = healthById.get(account.id);
    const providerHealth = health.providers.find((entry) => entry.provider === account.provider);
    for (const modelId of list.modelIds) {
      const profiles = workjet.workerProfiles.filter((profile) => {
        const route = routes.get(profile.llmRouteId);
        return profile.modelId === modelId && route?.gatewayAccountId === account.id;
      });
      const profileRows = profiles.length > 0 ? profiles : [undefined];
      for (const profile of profileRows) {
        const computer = profile === undefined ? undefined : computers.get(profile.computerId);
        const probe = profile === undefined ? undefined : probes.get(profile.harness);
        const check = checked.get(`${account.id}\0${modelId}`);
        const homeValid =
          profile !== undefined &&
          (account.provider === "codex"
            ? profile.harness === "codex-cli"
            : account.provider === "claude"
              ? profile.harness === "claude-code"
              : profile.harness !== "codex-cli" && profile.harness !== "claude-code");
        const coding = profile !== undefined && homeValid;
        const poolSelectable = catalog.providerPools.some(
          (pool) =>
            pool.provider === account.provider &&
            pool.members.some((member) => member.accountId === account.id && member.selectable),
        );
        const enabled =
          account.enabled &&
          account.modelIds.includes(modelId) &&
          !account.excludedModelIds?.includes(modelId) &&
          poolSelectable &&
          computer?.harnesses.some(
            (harness) => harness.harness === profile?.harness && harness.available,
          ) === true;
        const available =
          coding &&
          enabled &&
          computer?.presentationKind === "local" &&
          probe?.availability === "available" &&
          health.accountHealth === "reported" &&
          accountHealth?.usable === true &&
          accountHealth.authentication === "authenticated" &&
          accountHealth.disabled === false &&
          providerHealth?.phase === "ready" &&
          check?.status === "ok" &&
          check.checkedAtMs <= observedAtMs &&
          observedAtMs - check.checkedAtMs <= 15 * 60 * 1000;
        models.push({
          provider: account.provider,
          modelId,
          accountId: account.id,
          modelListCheckedAtMs: list.checkedAtMs,
          enabled,
          coding,
          available,
          routeId: profile?.llmRouteId ?? null,
          harness: profile?.harness ?? null,
          homeHarness: homeValid ? (profile?.harness ?? null) : null,
          computerId: profile?.computerId ?? null,
          reason: !coding
            ? "coding-route-unverified"
            : !enabled
              ? "route-disabled"
              : computer?.presentationKind !== "local" || probe?.availability !== "available"
                ? "harness-unavailable"
                : health.accountHealth !== "reported" ||
                    accountHealth?.usable !== true ||
                    accountHealth.authentication !== "authenticated" ||
                    accountHealth.disabled
                  ? "account-unavailable"
                  : providerHealth?.phase !== "ready"
                    ? "provider-unavailable"
                    : check?.status !== "ok" ||
                        check.checkedAtMs > observedAtMs ||
                        observedAtMs - check.checkedAtMs > 15 * 60 * 1000
                      ? "model-check-unverified"
                      : null,
        });
      }
    }
  }
  models.sort((a, b) =>
    `${a.provider}\0${a.modelId}\0${a.accountId}\0${a.routeId ?? ""}`.localeCompare(
      `${b.provider}\0${b.modelId}\0${b.accountId}\0${b.routeId ?? ""}`,
    ),
  );
  return {
    schemaVersion: 1,
    observedAtMs,
    healthObservedAtMs: health.observedAtMs,
    harnessProbedAt: harnesses.probedAt,
    models,
    unverifiedAccounts,
  };
}
