import {
  WorkjetGatewayAccessError,
  WorkjetGatewayAccountId,
  WorkjetGatewayGrantTarget,
  type WorkjetGatewayCatalog,
  type WorkjetGatewayScopedCatalog,
  type WorkjetGatewaySetGrantInput,
  type WorkjetGatewaySetGrantResult,
} from "@workjet/contracts";
import type { EnvironmentId } from "@workjet/contracts";
import * as Schema from "effect/Schema";

const GrantRecord = Schema.Struct({
  target: WorkjetGatewayGrantTarget,
  accountId: WorkjetGatewayAccountId,
});

const GrantsFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  grants: Schema.Array(GrantRecord),
});

type GrantsFile = typeof GrantsFile.Type;
const emptyGrants: GrantsFile = { schemaVersion: 1, grants: [] };
const MAX_GRANTS = 128;
const onlyKeys = (value: unknown, keys: ReadonlyArray<string>): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));

const sameTarget = (left: WorkjetGatewayGrantTarget, right: WorkjetGatewayGrantTarget) =>
  left.connectionId === right.connectionId &&
  left.instanceId === right.instanceId &&
  left.computerId === right.computerId;

export const decodeGatewayGrants = (input: unknown): GrantsFile => {
  try {
    if (!onlyKeys(input, ["schemaVersion", "grants"]) || !Array.isArray(input.grants)) {
      throw new Error("invalid grant file");
    }
    for (const entry of input.grants) {
      if (
        !onlyKeys(entry, ["target", "accountId"]) ||
        !onlyKeys(entry.target, ["connectionId", "instanceId", "computerId"])
      ) {
        throw new Error("unexpected grant field");
      }
    }
    const decoded = Schema.decodeUnknownSync(GrantsFile)(input);
    if (decoded.grants.length > MAX_GRANTS) throw new Error("too many grants");
    const seen = new Set<string>();
    for (const grant of decoded.grants) {
      const target = grant.target;
      const key = JSON.stringify([
        target.connectionId,
        target.instanceId,
        target.computerId,
        grant.accountId,
      ]);
      if (seen.has(key)) throw new Error("duplicate grant");
      seen.add(key);
    }
    return decoded;
  } catch {
    throw new WorkjetGatewayAccessError({ reason: "grants-unavailable" });
  }
};

export const emptyGatewayGrants = (): GrantsFile => emptyGrants;

export const scopeGatewayCatalog = (
  catalog: WorkjetGatewayCatalog,
  grants: GrantsFile,
  target: WorkjetGatewayGrantTarget,
  environmentId: EnvironmentId,
): WorkjetGatewayScopedCatalog => {
  const allowed = new Set(
    grants.grants
      .filter((grant) => sameTarget(grant.target, target))
      .map((grant) => grant.accountId),
  );
  return {
    schemaVersion: 1,
    target,
    accounts: catalog.accounts
      .filter((account) => allowed.has(account.id) && account.enabled)
      .map((account) => ({
        credentialRef: { environmentId, accountId: account.id },
        providerRef: { environmentId, provider: account.provider },
        label: account.label,
        modelRefs: account.modelIds.map((modelId) => ({
          environmentId,
          provider: account.provider,
          modelId,
        })),
      })),
  };
};

export const setGatewayGrant = (
  grants: GrantsFile,
  input: WorkjetGatewaySetGrantInput,
  catalog: WorkjetGatewayCatalog,
): { readonly file: GrantsFile; readonly result: WorkjetGatewaySetGrantResult } => {
  if (!catalog.accounts.some((account) => account.id === input.accountId)) {
    throw new WorkjetGatewayAccessError({ reason: "account-unavailable" });
  }
  const retained = grants.grants.filter(
    (grant) => !(sameTarget(grant.target, input.target) && grant.accountId === input.accountId),
  );
  const next: GrantsFile = {
    schemaVersion: 1,
    grants: input.granted
      ? [...retained, { target: input.target, accountId: input.accountId }]
      : retained,
  };
  if (next.grants.length > MAX_GRANTS) {
    throw new WorkjetGatewayAccessError({ reason: "grants-unavailable" });
  }
  return {
    file: next,
    result: {
      schemaVersion: 1,
      target: input.target,
      accountId: input.accountId,
      granted: input.granted,
    },
  };
};

export const removeGatewayAccountGrants = (
  grants: GrantsFile,
  accountId: WorkjetGatewayAccountId,
): GrantsFile => ({
  schemaVersion: 1,
  grants: grants.grants.filter((grant) => grant.accountId !== accountId),
});
