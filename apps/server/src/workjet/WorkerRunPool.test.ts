// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { describe, expect, it } from "@effect/vitest";
import {
  WorkjetConfiguration,
  WorkjetGatewayCatalog,
  WorkjetGatewayHealth,
  WorkjetGatewayModelChecks,
  WorkjetGatewayAccountModels,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import { qualifiedWorkerCandidates, type WorkerRunPoolEvidence } from "./WorkerRunPool.ts";
import { worker } from "./nativeWorkerOutcomeFixture.ts";
const now = 1_000_000;
const model = worker.modelSelection.model;
const configuration = Schema.decodeUnknownSync(WorkjetConfiguration)({
  computers: [
    {
      id: "computer",
      label: "Fixture",
      environmentId: worker.parent.environmentId,
      presentationKind: "local",
      harnesses: [{ harness: "codex-cli", available: true }],
    },
  ],
  workerProfiles: [
    {
      id: "worker-a",
      name: "Worker A",
      computerId: "computer",
      harness: "codex-cli",
      llmRouteId: "route-a",
      modelId: model,
      reasoning: "automatic",
    },
    {
      id: "worker-b",
      name: "Worker B",
      computerId: "computer",
      harness: "codex-cli",
      llmRouteId: "route-a",
      modelId: model,
      reasoning: "automatic",
    },
  ],
  llmRoutes: [{ id: "route-a", label: "Fixture route", gatewayAccountId: "account-a" }],
});
const evidence: WorkerRunPoolEvidence = {
  catalog: Schema.decodeUnknownSync(WorkjetGatewayCatalog)({
    schemaVersion: 1,
    accounts: [
      {
        id: "account-a",
        label: "Fixture",
        provider: "codex",
        enabled: true,
        priority: 0,
        weight: 1,
        modelIds: [model],
      },
    ],
    pools: [],
    routes: [],
    models: [],
  }),
  health: Schema.decodeUnknownSync(WorkjetGatewayHealth)({
    schemaVersion: 1,
    observedAtMs: now,
    activeProvider: null,
    providers: [],
    accountHealth: "reported",
    capacity: "not-reported-by-host",
    accounts: [
      {
        accountId: "account-a",
        provider: "codex",
        authentication: "authenticated",
        disabled: false,
        usable: true,
        cooldownUntilMs: null,
        errorCode: null,
        httpStatus: 200,
        observedAtMs: now,
        quota: [],
        quotaSupported: false,
        quotaRefreshing: false,
        quotaError: null,
      },
    ],
  }),
  checks: Schema.decodeUnknownSync(WorkjetGatewayModelChecks)({
    schemaVersion: 1,
    checks: [
      {
        accountId: "account-a",
        modelId: model,
        status: "ok",
        errorClass: null,
        checkedAtMs: now,
        latencyMs: 1,
        httpStatus: 200,
      },
    ],
    pending: [],
    deferredCount: 0,
  }),
  accountModels: [
    Schema.decodeUnknownSync(WorkjetGatewayAccountModels)({
      accountId: "account-a",
      checkedAtMs: now,
      state: "observed",
      reason: null,
      modelIds: [model],
    }),
  ],
  reachable: new Map(
    configuration.workerProfiles.map((profile) => [profile.id, worker.modelSelection.instanceId]),
  ),
  nowMs: now,
};
describe("official coding-worker qualification", () => {
  it("draws unique models uniformly rather than giving duplicated profiles extra chances", () => {
    expect(
      qualifiedWorkerCandidates(configuration, evidence).map((entry) => entry.profile.id),
    ).toEqual(["worker-a"]);
    expect(qualifiedWorkerCandidates(configuration, evidence, false)).toHaveLength(2);
  });
  it("requires a fresh authenticated live list, health check and reachable native harness", () => {
    for (const altered of [
      { ...evidence, reachable: new Map() },
      { ...evidence, nowMs: now + 300_001 },
      { ...evidence, accountModels: [] },
      { ...evidence, checks: { ...evidence.checks, checks: [] } },
      {
        ...evidence,
        health: {
          ...evidence.health,
          accounts: evidence.health.accounts.map((account) => ({ ...account, usable: false })),
        },
      },
    ])
      expect(qualifiedWorkerCandidates(configuration, altered)).toEqual([]);
  });
  it("refuses GPT in another harness and refuses disabled or inactive entries", () => {
    for (const altered of [
      {
        ...configuration,
        workerProfiles: configuration.workerProfiles.map((profile) => ({
          ...profile,
          harness: "claude-code" as const,
        })),
      },
      {
        ...configuration,
        computers: configuration.computers.map((computer) => ({
          ...computer,
          metadata: {
            connection: null,
            facts: null,
            roles: { build: true, storage: false },
            active: false,
            hostKeyFingerprint: null,
            identityFiles: [],
            status: "unverified" as const,
            error: null,
            previousIds: [],
            legacyRecords: [],
          },
        })),
      },
    ])
      expect(qualifiedWorkerCandidates(altered, evidence)).toEqual([]);
    expect(
      qualifiedWorkerCandidates(configuration, {
        ...evidence,
        catalog: {
          ...evidence.catalog,
          accounts: evidence.catalog.accounts.map((account) => ({ ...account, enabled: false })),
        },
      }),
    ).toEqual([]);
  });
});
