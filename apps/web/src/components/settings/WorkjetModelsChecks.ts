import type { WorkjetGatewayAccountSummary } from "@workjet/contracts";
import type { ModelsModelCheck } from "./WorkjetModelsProviders";

const key = (accountId: string, modelId: string) => JSON.stringify([accountId, modelId]);
export interface ModelCheckPass {
  readonly accountId: string | undefined;
  readonly force: boolean;
  readonly baseline: ReadonlyMap<string, number | undefined>;
}
export function createModelCheckPass(
  accounts: ReadonlyArray<WorkjetGatewayAccountSummary>,
  checks: ReadonlyArray<ModelsModelCheck>,
  now: number,
  accountId?: string,
  force = false,
): ModelCheckPass {
  const observations = new Map(
    checks.map((check) => [key(check.accountId, check.modelId), check.checkedAtMs]),
  );
  const baseline = new Map<string, number | undefined>();
  for (const account of accounts) {
    if (!account.enabled || (accountId !== undefined && account.id !== accountId)) continue;
    for (const model of account.modelIds) {
      const id = key(account.id, model);
      const previous = observations.get(id);
      if (force || previous === undefined || now < previous || now - previous >= 300_000)
        baseline.set(id, previous);
    }
  }
  return { accountId, force, baseline };
}
export function remainingModelChecks(
  pass: ModelCheckPass,
  accounts: ReadonlyArray<WorkjetGatewayAccountSummary>,
  checks: ReadonlyArray<ModelsModelCheck>,
): number {
  const eligible = new Set(
    accounts
      .filter((account) => account.enabled)
      .flatMap((account) => account.modelIds.map((model) => key(account.id, model))),
  );
  const observations = new Map(
    checks.map((check) => [key(check.accountId, check.modelId), check.checkedAtMs]),
  );
  let remaining = 0;
  for (const [id, previous] of pass.baseline) {
    if (eligible.has(id) && observations.get(id) === previous) remaining += 1;
  }
  return remaining;
}
