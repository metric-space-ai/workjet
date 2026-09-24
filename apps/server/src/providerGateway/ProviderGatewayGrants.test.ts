import {
  EnvironmentId,
  WorkjetComputerId,
  WorkjetConnectionId,
  WorkjetGatewayAccountId,
  WorkjetGatewayAccessError,
  type WorkjetGatewayCatalog,
} from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decodeGatewayGrants,
  emptyGatewayGrants,
  removeGatewayAccountGrants,
  scopeGatewayCatalog,
  setGatewayGrant,
} from "./ProviderGatewayGrants.ts";

const environmentId = EnvironmentId.make("host-a");
const accountId = WorkjetGatewayAccountId.make("codex-primary");
const firstTarget = {
  connectionId: WorkjetConnectionId.make("ctox-welsch"),
  instanceId: "welsch",
  computerId: WorkjetComputerId.make("gpu1-a6000"),
};
const secondTarget = {
  ...firstTarget,
  computerId: WorkjetComputerId.make("gpu3-a4500"),
};
const catalog: WorkjetGatewayCatalog = {
  schemaVersion: 1,
  accounts: [
    {
      id: accountId,
      label: "Primary Codex",
      provider: "codex",
      enabled: true,
      priority: 0,
      weight: 1,
      modelIds: ["gpt-test"],
      credentialSuffix: "1234",
    },
  ],
  pools: [],
  routes: [],
  models: [],
  routingStrategy: "round-robin",
  providerPools: [],
};

describe("ProviderGatewayGrants", () => {
  it("keeps logical credential and model references scoped to one selected instance/computer", () => {
    const empty = emptyGatewayGrants();
    expect(scopeGatewayCatalog(catalog, empty, firstTarget, environmentId).accounts).toEqual([]);
    expect(scopeGatewayCatalog(catalog, empty, secondTarget, environmentId).accounts).toEqual([]);

    const granted = setGatewayGrant(
      empty,
      { target: firstTarget, accountId, granted: true },
      catalog,
    );
    const restored = decodeGatewayGrants(JSON.parse(JSON.stringify(granted.file)));
    expect(scopeGatewayCatalog(catalog, restored, secondTarget, environmentId).accounts).toEqual(
      [],
    );
    const visible = scopeGatewayCatalog(catalog, restored, firstTarget, environmentId);
    expect(visible.accounts).toEqual([
      {
        credentialRef: { environmentId, accountId },
        providerRef: { environmentId, provider: "codex" },
        label: "Primary Codex",
        modelRefs: [{ environmentId, provider: "codex", modelId: "gpt-test" }],
      },
    ]);
    expect(JSON.stringify(visible)).not.toContain("1234");
    expect(JSON.stringify(visible)).not.toContain("provider-secret");

    const revoked = setGatewayGrant(
      restored,
      { target: firstTarget, accountId, granted: false },
      catalog,
    );
    expect(scopeGatewayCatalog(catalog, revoked.file, firstTarget, environmentId).accounts).toEqual(
      [],
    );
    expect(removeGatewayAccountGrants(restored, accountId).grants).toEqual([]);
  });

  it("rejects unknown accounts and malformed or duplicate persisted grants", () => {
    expect(() =>
      setGatewayGrant(
        emptyGatewayGrants(),
        {
          target: firstTarget,
          accountId: WorkjetGatewayAccountId.make("missing"),
          granted: true,
        },
        catalog,
      ),
    ).toThrow(WorkjetGatewayAccessError);
    expect(() =>
      decodeGatewayGrants({
        schemaVersion: 1,
        grants: [
          { target: firstTarget, accountId },
          { target: firstTarget, accountId },
        ],
      }),
    ).toThrow(WorkjetGatewayAccessError);
    expect(() =>
      decodeGatewayGrants({
        schemaVersion: 1,
        grants: [{ target: firstTarget, accountId, secret: "leak" }],
      }),
    ).toThrow(WorkjetGatewayAccessError);
  });
});
