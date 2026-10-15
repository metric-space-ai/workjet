// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeCrypto from "node:crypto";
import {
  type EnvironmentId,
  type WorkjetConfiguration,
  type WorkjetGatewayAccountModels,
  type WorkjetGatewayCatalog,
  type WorkjetGatewayHealth,
  type WorkjetGatewayModelChecks,
  type WorkjetWorkerProfile,
  type ProviderInstanceId,
} from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ProviderGatewayService } from "../providerGateway/ProviderGatewayService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { WorkerRunDraw } from "./WorkerRunDraw.ts";
import { WorkerRunLedgerError } from "./WorkerRunLedger.ts";
import { workerSourceDriver } from "./WorkerSourceNativeProfile.ts";

export interface WorkerRunCandidate {
  readonly key: string;
  readonly provider: string;
  readonly profile: WorkjetWorkerProfile;
  readonly instanceId: ProviderInstanceId;
}
export interface WorkerRunPoolEvidence {
  readonly catalog: WorkjetGatewayCatalog;
  readonly health: WorkjetGatewayHealth;
  readonly checks: WorkjetGatewayModelChecks;
  readonly accountModels: ReadonlyArray<WorkjetGatewayAccountModels>;
  /** Positive live harness observations, never inferred from a saved profile. */
  readonly reachable: ReadonlyMap<string, ProviderInstanceId>;
  readonly nowMs: number;
}
const fresh = (at: number | null, now: number) =>
  at !== null && at <= now + 5_000 && at >= now - 300_000;

/** The lottery is uniform over unique provider/model identities, not over profiles or accounts. */
export function qualifiedWorkerCandidates(
  configuration: WorkjetConfiguration,
  evidence: WorkerRunPoolEvidence,
  deduplicate = true,
): ReadonlyArray<WorkerRunCandidate> {
  if (!fresh(evidence.health.observedAtMs, evidence.nowMs)) return [];
  const candidates = new Map<string, WorkerRunCandidate>();
  for (const profile of [...configuration.workerProfiles].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const instanceId = evidence.reachable.get(profile.id);
    const computer = configuration.computers.find((entry) => entry.id === profile.computerId);
    const route = configuration.llmRoutes.find((entry) => entry.id === profile.llmRouteId);
    if (!instanceId || !computer || computer.metadata?.active === false || !route?.gatewayAccountId)
      continue;
    const account = evidence.catalog.accounts.find((entry) => entry.id === route.gatewayAccountId);
    const health = evidence.health.accounts.find(
      (entry) => entry.accountId === route.gatewayAccountId,
    );
    const models = evidence.accountModels.find(
      (entry) => entry.accountId === route.gatewayAccountId,
    );
    const check = evidence.checks.checks.find(
      (entry) => entry.accountId === route.gatewayAccountId && entry.modelId === profile.modelId,
    );
    if (
      !account?.enabled ||
      !account.modelIds.includes(profile.modelId) ||
      account.excludedModelIds?.includes(profile.modelId) ||
      !health?.usable ||
      health.disabled ||
      health.authentication !== "authenticated" ||
      !fresh(health.observedAtMs, evidence.nowMs) ||
      (health.cooldownUntilMs !== null && health.cooldownUntilMs > evidence.nowMs) ||
      models?.state !== "observed" ||
      !fresh(models.checkedAtMs, evidence.nowMs) ||
      !models.modelIds.includes(profile.modelId) ||
      check?.status !== "ok" ||
      !fresh(check.checkedAtMs, evidence.nowMs)
    )
      continue;
    if (
      (account.provider === "codex" && profile.harness !== "codex-cli") ||
      (account.provider === "claude" && profile.harness !== "claude-code") ||
      workerSourceDriver(profile.harness) === undefined
    )
      continue;
    const key = `${account.provider}:${profile.modelId}${deduplicate ? "" : `:${profile.id}`}`;
    if (!candidates.has(key))
      candidates.set(key, { key, provider: account.provider, profile, instanceId });
  }
  return [...candidates.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export const make = Effect.gen(function* () {
  const gateway = yield* ProviderGatewayService;
  const providers = yield* ProviderRegistry;
  const draws = yield* WorkerRunDraw;
  const list = Effect.fn("WorkerRunPool.list")(function* (
    configuration: WorkjetConfiguration,
    environmentId: EnvironmentId,
    probe = false,
  ) {
    const catalog = yield* gateway.catalog();
    const health = yield* gateway.health();
    if (probe) {
      yield* gateway.checkModels({});
      const deadline = (yield* Clock.currentTimeMillis) + 120_000;
      while (
        (yield* gateway.modelChecks()).pending.length > 0 &&
        (yield* Clock.currentTimeMillis) < deadline
      )
        yield* Effect.sleep("500 millis");
    }
    const checks = yield* gateway.modelChecks();
    const snapshots = yield* providers.refresh();
    const reachable = new Map<string, ProviderInstanceId>();
    for (const profile of configuration.workerProfiles) {
      const computer = configuration.computers.find((entry) => entry.id === profile.computerId);
      // Remote availability needs a live target observation. Configuration alone
      // cannot qualify it; normal dispatch still supports explicit remote workers.
      if (computer?.environmentId !== environmentId) continue;
      const driver = workerSourceDriver(profile.harness);
      const live = snapshots.filter(
        (entry) =>
          entry.driver === driver &&
          entry.enabled &&
          entry.installed &&
          entry.availability !== "unavailable" &&
          entry.status === "ready",
      );
      if (live.length === 1) reachable.set(profile.id, live[0]!.instanceId);
    }
    const readings = yield* Effect.forEach(
      catalog.accounts.filter((account) => account.enabled),
      (account) => gateway.accountModels({ accountId: account.id }).pipe(Effect.option),
      { concurrency: 2 },
    );
    const accountModels = readings.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []));
    const nowMs = yield* Clock.currentTimeMillis;
    const evidence = { catalog, health, checks, accountModels, reachable, nowMs };
    const candidates = qualifiedWorkerCandidates(configuration, evidence);
    const workers = qualifiedWorkerCandidates(configuration, evidence, false);
    const serialized = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
      catalog,
      health,
      checks,
      accountModels,
      reachable: [...reachable],
    });
    return {
      schemaVersion: 1 as const,
      observedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      healthSnapshotSha256: NodeCrypto.createHash("sha256").update(serialized).digest("hex"),
      candidates,
      workers,
    };
  });
  const select = Effect.fn("WorkerRunPool.select")(function* (
    configuration: WorkjetConfiguration,
    environmentId: EnvironmentId,
    brief: string,
  ) {
    const pool = yield* list(configuration, environmentId);
    const briefSha256 = NodeCrypto.createHash("sha256").update(brief, "utf8").digest("hex");
    const draw = yield* draws.select({
      briefSha256,
      pool: { ...pool, candidates: pool.candidates.map((entry) => entry.key) },
    });
    const selected = pool.candidates.find((entry) => entry.key === draw.selected);
    if (!selected)
      return yield* new WorkerRunLedgerError({
        detail:
          "The immutable worker draw is currently unavailable; retry it without drawing again",
      });
    return { ...selected, draw };
  });
  return { list, select };
});
export class WorkerRunPool extends Context.Service<WorkerRunPool, Effect.Success<typeof make>>()(
  "workjet/workjet/WorkerRunPool",
) {}
export const layer = Layer.effect(WorkerRunPool, make);
