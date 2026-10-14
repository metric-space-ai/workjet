import { assert, it } from "@effect/vitest";
import { officialCodingModelExport } from "./OfficialCodingModelExport.ts";

const fixture = (): Parameters<typeof officialCodingModelExport>[0] =>
  ({
    observedAtMs: 1_000_000,
    catalog: {
      schemaVersion: 1,
      accounts: [
        { id: "account-1", provider: "claude", enabled: true, label: "Test", priority: 0, weight: 1, modelIds: ["live-model"], credentialSuffix: null },
      ],
      pools: [], routes: [], models: [], routingStrategy: "fill-first", providerPools: [{ provider: "claude", strategy: "fill-first", weightHonored: true, priorityExclusive: true, members: [{ accountId: "account-1", label: "Test", enabled: true, priority: 0, weight: 1, selectable: true }] }],
    },
    health: {
      schemaVersion: 1,
      observedAtMs: 999_000,
      activeProvider: "claude",
      providers: [{ provider: "claude", accountCount: 1, enabledAccountCount: 1, modelIds: ["live-model"], phase: "ready" }],
      accountHealth: "reported",
      accounts: [{ accountId: "account-1", provider: "claude", authentication: "authenticated", disabled: false, usable: true, cooldownUntilMs: null, errorCode: null, httpStatus: null, generationHttpStatus: null, observedAtMs: 999_000, quota: [], balance: null, quotaSupported: false, quotaRefreshing: false, quotaError: null }],
      capacity: "not-reported-by-host",
    },
    checks: {
      schemaVersion: 1,
      checks: [{ accountId: "account-1", modelId: "live-model", status: "ok", errorClass: null, checkedAtMs: 999_000, latencyMs: 10, httpStatus: 200 }],
      pending: [], deferredCount: 0,
    },
    accountModels: [{ accountId: "account-1", checkedAtMs: 999_500, state: "observed", reason: null, modelIds: ["live-model", "unrouted-live-model"] }],
    workjet: {
      schemaVersion: 4,
      computers: [{ id: "local", label: "Local", environmentId: "env", presentationKind: "local", harnesses: [{ harness: "claude-code", available: true }] }],
      selectedComputerId: "local", modelPrompts: [],
      llmRoutes: [{ id: "route-1", label: "Claude", gatewayAccountId: "account-1" }],
      workerProfiles: [{ id: "worker-1", name: "Worker", computerId: "local", harness: "claude-code", llmRouteId: "route-1", modelId: "live-model", reasoning: "medium", role: "standard", capabilityIds: [], capabilityBindings: [] }],
      workerGraph: { positions: [], dependencies: [] },
      managedSystemPrompt: "", managerThreadReference: "",
      telemetry: { claudeCodeEvents: true, sidecarEvents: true, retentionDays: 14 },
      execution: { probeTimeoutSeconds: 120, turnTimeoutSeconds: 5400, degradationAllowed: true },
    },
    harnesses: { schemaVersion: 1, probedAt: "2026-10-14T00:00:00Z", harnesses: [{ harness: "claude-code", availability: "available", executablePath: "/usr/bin/claude" }] },
  }) as unknown as Parameters<typeof officialCodingModelExport>[0];

it("exports only a live, checked model with its registered and probed home route as available", () => {
  const result = officialCodingModelExport(fixture());
  assert.equal(result.models.length, 2);
  assert.equal(result.models[0]?.modelId, "live-model");
  assert.equal(result.models[0]?.available, true);
  assert.equal(result.models[0]?.homeHarness, "claude-code");
  assert.equal(result.models[1]?.modelId, "unrouted-live-model");
  assert.equal(result.models[1]?.available, false);
  assert.equal(result.models[1]?.reason, "coding-route-unverified");
});

it("fails closed when a model check is stale or the account list is unavailable", () => {
  const input = fixture();
  const stale = officialCodingModelExport({ ...input, observedAtMs: 2_000_000 });
  assert.equal(stale.models[0]?.available, false);
  assert.equal(stale.models[0]?.reason, "model-check-unverified");
  const missing = officialCodingModelExport({
    ...input,
    accountModels: [{ accountId: input.catalog.accounts[0]!.id, checkedAtMs: 999_500, state: "unavailable", reason: "catalog-unavailable", modelIds: [] }],
  });
  assert.equal(missing.models.length, 0);
  assert.equal(missing.unverifiedAccounts[0]?.reason, "catalog-unavailable");
});
