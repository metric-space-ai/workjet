import { describe, expect, it } from "@effect/vitest";

import {
  WorkjetGatewayAccountId,
  WorkjetGatewayPoolId,
  WorkjetGatewayRouteId,
  type WorkjetGatewayCatalog,
  type WorkjetGatewayProvider,
} from "./workjet.ts";
import {
  matchesWorkjetGatewayModelPattern,
  resolveWorkjetGatewayModelRoute,
  workjetGatewayModelRouteTable,
} from "./workjetGatewayRouting.ts";

const account = (
  id: string,
  provider: WorkjetGatewayProvider,
  modelIds: ReadonlyArray<string>,
  enabled = true,
): WorkjetGatewayCatalog["accounts"][number] => ({
  id: WorkjetGatewayAccountId.make(id),
  label: id,
  provider,
  enabled,
  priority: 0,
  weight: 1,
  modelIds,
  credentialSuffix: null,
});

const pool = (
  id: string,
  provider: WorkjetGatewayProvider,
  modelIds: ReadonlyArray<string>,
  accountIds: ReadonlyArray<string> = [],
): WorkjetGatewayCatalog["pools"][number] => ({
  id: WorkjetGatewayPoolId.make(id),
  label: id,
  provider,
  accountIds: accountIds.map((accountId) => WorkjetGatewayAccountId.make(accountId)),
  modelIds,
});

const route = (
  id: string,
  poolId: string,
  provider: WorkjetGatewayProvider,
  modelIds: ReadonlyArray<string>,
): WorkjetGatewayCatalog["routes"][number] => ({
  id: WorkjetGatewayRouteId.make(id),
  label: id,
  poolId: WorkjetGatewayPoolId.make(poolId),
  provider,
  modelIds,
});

const catalog = (parts: Partial<WorkjetGatewayCatalog> = {}): WorkjetGatewayCatalog => ({
  schemaVersion: 1,
  accounts: [],
  pools: [],
  routes: [],
  models: [],
  ...parts,
});

describe("matchesWorkjetGatewayModelPattern", () => {
  it("matches an exact id case-insensitively and a `*` glob", () => {
    expect(matchesWorkjetGatewayModelPattern("gpt-5.4", "GPT-5.4")).toBe(true);
    expect(matchesWorkjetGatewayModelPattern("claude-*", "claude-opus-4")).toBe(true);
    expect(matchesWorkjetGatewayModelPattern("*-mini", "gpt-5-mini")).toBe(true);
    expect(matchesWorkjetGatewayModelPattern("claude-*", "gpt-5.4")).toBe(false);
  });

  it("treats regex metacharacters in a pattern as literals", () => {
    // `.` must not match `-`, or `gpt-5.4` would silently claim `gpt-5x4`.
    expect(matchesWorkjetGatewayModelPattern("gpt-5.4", "gpt-5x4")).toBe(false);
  });
});

describe("resolveWorkjetGatewayModelRoute", () => {
  it("prefers a route over the pool and account fallbacks", () => {
    const resolved = resolveWorkjetGatewayModelRoute({
      model: "claude-opus-4",
      catalog: catalog({
        accounts: [account("codex_1", "codex", ["claude-opus-4"])],
        pools: [pool("codex_pool", "codex", ["claude-opus-4"])],
        routes: [route("opus", "claude_pool", "claude", ["claude-opus-4"])],
      }),
    });

    expect(resolved).toMatchObject({
      outcome: "resolved",
      provider: "claude",
      poolId: "claude_pool",
      routeId: "opus",
      via: "route",
    });
  });

  it("lets the more specific route pattern win over a catch-all", () => {
    const resolved = resolveWorkjetGatewayModelRoute({
      model: "claude-opus-4",
      catalog: catalog({
        pools: [pool("fallback", "codex", []), pool("opus_pool", "claude", [])],
        routes: [
          route("catch-all", "fallback", "codex", ["*"]),
          route("opus", "opus_pool", "claude", ["claude-opus-*"]),
        ],
      }),
    });

    expect(resolved).toMatchObject({ outcome: "resolved", routeId: "opus", provider: "claude" });
  });

  it("fails typed when equally specific routes point at different pools", () => {
    const failed = resolveWorkjetGatewayModelRoute({
      model: "gpt-5.4",
      catalog: catalog({
        pools: [pool("a", "codex", []), pool("b", "claude", [])],
        routes: [
          route("left", "a", "codex", ["gpt-5.4"]),
          route("right", "b", "claude", ["gpt-5.4"]),
        ],
      }),
    });

    expect(failed).toMatchObject({ outcome: "failed", reason: "route-ambiguous" });
    if (failed.outcome === "failed") expect(failed.detail).toContain("gpt-5.4");
  });

  it("falls back to the pool that lists the model when no route matches", () => {
    const resolved = resolveWorkjetGatewayModelRoute({
      model: "glm-5.3",
      catalog: catalog({
        pools: [pool("zai_pool", "zai", ["glm-5.3"], ["zai_1"])],
        routes: [route("other", "zai_pool", "zai", ["kimi-*"])],
      }),
    });

    expect(resolved).toMatchObject({
      outcome: "resolved",
      provider: "zai",
      poolId: "zai_pool",
      routeId: null,
      via: "pool",
    });
  });

  it("falls back to the provider whose account catalog lists the model", () => {
    const resolved = resolveWorkjetGatewayModelRoute({
      model: "gpt-5.4",
      catalog: catalog({
        accounts: [account("codex_1", "codex", ["gpt-5.4"]), account("zai_1", "zai", ["glm-5.3"])],
      }),
    });

    expect(resolved).toMatchObject({
      outcome: "resolved",
      provider: "codex",
      poolId: null,
      routeId: null,
      via: "account",
    });
  });

  it("ignores a disabled account, because routing to it would fail upstream", () => {
    const failed = resolveWorkjetGatewayModelRoute({
      model: "gpt-5.4",
      catalog: catalog({
        accounts: [
          account("codex_1", "codex", ["gpt-5.4"], false),
          account("zai_1", "zai", ["glm-5.3"]),
        ],
      }),
    });

    expect(failed).toMatchObject({ outcome: "failed", reason: "model-unrouted" });
  });

  it("fails typed when accounts of two providers both list the model", () => {
    const failed = resolveWorkjetGatewayModelRoute({
      model: "kimi-k3-256k",
      catalog: catalog({
        accounts: [
          account("kimi_1", "kimi", ["kimi-k3-256k"]),
          account("zai_1", "zai", ["kimi-k3-256k"]),
        ],
      }),
    });

    expect(failed).toMatchObject({ outcome: "failed", reason: "model-ambiguous" });
  });

  it("fails typed for a model nothing serves, never a silent default", () => {
    const failed = resolveWorkjetGatewayModelRoute({
      model: "made-up-model",
      catalog: catalog({ accounts: [account("codex_1", "codex", ["gpt-5.4"])] }),
    });

    expect(failed).toMatchObject({ outcome: "failed", reason: "model-unrouted" });
    if (failed.outcome === "failed") expect(failed.detail).toContain("made-up-model");
  });

  it("skips rather than fails when no model is pinned", () => {
    for (const model of [undefined, null, "   "]) {
      expect(
        resolveWorkjetGatewayModelRoute({
          model,
          catalog: catalog({ accounts: [account("codex_1", "codex", ["gpt-5.4"])] }),
        }),
      ).toMatchObject({ outcome: "skipped", reason: "model-unspecified" });
    }
  });

  it("skips when the catalog declares no models at all", () => {
    // Nothing to route by: failing here would break every routed session on a
    // gateway whose accounts simply list no models.
    expect(
      resolveWorkjetGatewayModelRoute({
        model: "gpt-5.4",
        catalog: catalog({ accounts: [account("codex_1", "codex", [])] }),
      }),
    ).toMatchObject({ outcome: "skipped", reason: "catalog-empty" });
  });
});

describe("workjetGatewayModelRouteTable", () => {
  it("resolves every catalog model, sorted, including the failures", () => {
    const table = workjetGatewayModelRouteTable(
      catalog({
        accounts: [
          account("codex_1", "codex", ["gpt-5.4"]),
          account("kimi_1", "kimi", ["shared"]),
          account("zai_1", "zai", ["shared"]),
        ],
        models: [
          { id: "shared", displayName: "shared", providers: ["kimi", "zai"], accountIds: [] },
          { id: "gpt-5.4", displayName: "gpt-5.4", providers: ["codex"], accountIds: [] },
        ],
      }),
    );

    expect(table.map((entry) => entry.model)).toStrictEqual(["gpt-5.4", "shared"]);
    expect(table[0]).toMatchObject({ outcome: "resolved", provider: "codex" });
    expect(table[1]).toMatchObject({ outcome: "failed", reason: "model-ambiguous" });
  });
});
