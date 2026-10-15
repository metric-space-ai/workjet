// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { ProviderGatewayService } from "../providerGateway/ProviderGatewayService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { make as makePool } from "./WorkerRunPool.ts";
import { WorkerRunDraw, layer as drawLayer } from "./WorkerRunDraw.ts";
import { assert, describe, expect, it } from "@effect/vitest";
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
it.effect(
  "qualifies a fake worker and commits its immutable draw before its execution callback",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      yield* runMigrations();
      let reachable = true;
      const gateway = {
        catalog: () => Effect.succeed(evidence.catalog),
        health: () => Effect.succeed(evidence.health),
        modelChecks: () => Effect.succeed(evidence.checks),
        accountModels: () => Effect.succeed(evidence.accountModels[0]!),
      } as unknown as ProviderGatewayService["Service"];
      const providers = {
        refresh: () =>
          Effect.succeed(
            reachable
              ? [
                  {
                    instanceId: worker.modelSelection.instanceId,
                    driver: "codex",
                    enabled: true,
                    installed: true,
                    status: "ready",
                    availability: "available",
                  },
                ]
              : [],
          ),
      } as unknown as ProviderRegistry["Service"];
      const pool = yield* makePool.pipe(
        Effect.provideService(ProviderGatewayService, gateway),
        Effect.provideService(ProviderRegistry, providers),
      );
      const selected = yield* pool.select(
        configuration,
        worker.parent.environmentId,
        "Fake worker assignment",
      );
      const saved = Option.getOrThrow(yield* (yield* WorkerRunDraw).get(selected.draw.briefSha256));
      const fakeWorker = () => {
        assert.deepEqual(saved, selected.draw);
        return selected.profile.harness;
      };
      assert.equal(fakeWorker(), "codex-cli");
      reachable = false;
      assert.equal(
        (yield* Effect.exit(
          pool.select(configuration, worker.parent.environmentId, "Fake worker assignment"),
        ))._tag,
        "Failure",
      );
      assert.deepEqual(
        Option.getOrThrow(yield* (yield* WorkerRunDraw).get(selected.draw.briefSha256)),
        saved,
      );
      reachable = true;
      assert.deepEqual(
        (yield* pool.select(configuration, worker.parent.environmentId, "Fake worker assignment"))
          .draw,
        saved,
      );
    }).pipe(Effect.provide(drawLayer.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())))),
);
