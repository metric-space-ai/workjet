import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  WorkjetConfiguration,
  WorkjetGatewayAccountId,
  type WorkjetComputer,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  LEGACY_WORKJET_FIELD_PATHS,
  readLegacyWorkjetConfig,
  type LegacyWorkjetConfig,
} from "./LegacyWorkjetConfig.ts";
import {
  composeManagedSystemPrompt,
  EMPTY_LEGACY_WORKJET_BINDINGS,
  LEGACY_WORKJET_MAPPED_FIELD_PATHS,
  LEGACY_WORKJET_MAPPING_TABLE,
  legacyWorkjetFieldsWithoutDecision,
  mapLegacyWorkjetConfig,
  type LegacyWorkjetDecision,
  type LegacyWorkjetImportBindings,
} from "./LegacyWorkjetMapping.ts";
import goldenSample from "./testFixtures/legacyWorkjetConfig.v1.json" with { type: "json" };

const encodeWorkjetConfiguration = Schema.encodeUnknownSync(WorkjetConfiguration);
const decodeWorkjetConfiguration = Schema.decodeUnknownSync(WorkjetConfiguration);

const LOCAL = "00000000-0000-0000-0000-000000000001";
const TAILNET = "00000000-0000-0000-0000-000000000002";
const SSH_BOX = "00000000-0000-0000-0000-000000000003";
const ZAI = "14F384A7-0D3F-45D1-9CF9-8962A3B28739";
const XAI = "C6E95930-179B-4CDB-9A00-197E21906EF2";
const KIMI = "64ECBBC6-361B-459D-A675-E4358F7F3E5E";

const readGolden = (mutate: (document: Record<string, unknown>) => void = () => {}) => {
  const document = structuredClone(goldenSample) as Record<string, unknown>;
  mutate(document);
  const result = readLegacyWorkjetConfig(document);
  if (result._tag !== "read") throw new Error(`fixture must read: ${result.failure.detail}`);
  return result;
};

const FULL_BINDINGS: LegacyWorkjetImportBindings = {
  environmentByComputerId: {
    [LOCAL]: EnvironmentId.make("env-local"),
    [TAILNET]: EnvironmentId.make("env-tailnet"),
    [SSH_BOX]: EnvironmentId.make("env-build-box"),
  },
  gatewayAccountByProviderId: {
    [KIMI]: WorkjetGatewayAccountId.make("kimi-primary"),
    [ZAI]: WorkjetGatewayAccountId.make("zai-z.ai-key"),
    [XAI]: WorkjetGatewayAccountId.make("xai-oauth"),
  },
  gatewayAccountByProviderPool: { OpenAI: WorkjetGatewayAccountId.make("codex-primary") },
};

const mapGolden = (
  bindings: LegacyWorkjetImportBindings,
  mutate?: (document: Record<string, unknown>) => void,
) => {
  const read = readGolden(mutate);
  return mapLegacyWorkjetConfig({
    config: read.config,
    unknownFields: read.unknownFields,
    bindings,
  });
};

const decisionsFor = (
  decisions: readonly LegacyWorkjetDecision[],
  source: string,
): readonly LegacyWorkjetDecision[] => decisions.filter((entry) => entry.source === source);

describe("the mapping table", () => {
  it("gives every modelled legacy field exactly one decision", () => {
    assert.deepEqual([...legacyWorkjetFieldsWithoutDecision()], []);
    assert.strictEqual(
      new Set(LEGACY_WORKJET_MAPPED_FIELD_PATHS).size,
      LEGACY_WORKJET_MAPPED_FIELD_PATHS.length,
      "a field appears twice in the table",
    );
    assert.deepEqual(
      [...LEGACY_WORKJET_MAPPED_FIELD_PATHS].sort(),
      [...LEGACY_WORKJET_FIELD_PATHS],
      "the table and the reader disagree about the field universe",
    );
  });

  it("states a reason for every entry and a destination for everything not dropped", () => {
    for (const decision of LEGACY_WORKJET_MAPPING_TABLE) {
      assert.isAbove(decision.reason.length, 20, `${decision.source} needs a real reason`);
      if (decision.outcome === "dropped" || decision.outcome === "consumed") {
        assert.isNull(
          decision.destination,
          `${decision.source} is dropped but names a destination`,
        );
        continue;
      }
      assert.isNotNull(decision.destination, `${decision.source} has no destination`);
    }
  });
});

describe("mapLegacyWorkjetConfig without bindings", () => {
  it("imports nothing that would need an invented reference, and says why", () => {
    const result = mapGolden(EMPTY_LEGACY_WORKJET_BINDINGS);

    assert.deepEqual(result.counts, {
      computersImported: 0,
      computersTotal: 3,
      llmRoutesImported: 0,
      workersImported: 0,
      workersTotal: 4,
    });
    assert.deepEqual(result.configuration.computers, []);
    assert.deepEqual(result.configuration.llmRoutes, []);
    assert.deepEqual(result.configuration.workerProfiles, []);
  });

  it("still imports every setting that has a real destination", () => {
    const result = mapGolden(EMPTY_LEGACY_WORKJET_BINDINGS);
    assert.strictEqual(result.configuration.schemaVersion, 2);
    assert.deepEqual(result.configuration.telemetry, {
      claudeCodeEvents: true,
      sidecarEvents: false,
      retentionDays: 14,
    });
    assert.deepEqual(result.configuration.execution, {
      probeTimeoutSeconds: 120,
      turnTimeoutSeconds: 5400,
      degradationAllowed: true,
    });
    assert.include(result.configuration.managedSystemPrompt, "You are the sole orchestrator.");
  });

  it("reports every record that needs an operator binding, with recognizable evidence", () => {
    const result = mapGolden(EMPTY_LEGACY_WORKJET_BINDINGS);

    assert.deepEqual(
      result.pending
        .filter((entry) => entry._tag === "computer-environment")
        .map((entry) => ({
          id: entry.computerId,
          transport: entry.transport,
        })),
      [
        { id: LOCAL, transport: "Lokal" },
        { id: TAILNET, transport: "Tailscale" },
        { id: SSH_BOX, transport: "SSH" },
      ],
    );

    const kimi = result.pending.find(
      (entry) => entry._tag === "provider-account" && entry.providerId === KIMI,
    );
    assert.deepEqual(kimi, {
      _tag: "provider-account",
      providerId: KIMI,
      providerName: "Kimi 1",
      modelProvider: "Kimi",
      accountLabel: "Kimi · …ab1234",
      externalCredentialId:
        "account-0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff",
      modelIds: ["kimi-k3", "kimi-k3-256k"],
    });

    assert.deepEqual(
      result.pending.filter((entry) => entry._tag === "provider-pool-account"),
      [
        {
          _tag: "provider-pool-account",
          pool: "OpenAI",
          workerIds: [
            "00000000-0000-0000-0000-000000000011",
            "00000000-0000-0000-0000-000000000024",
          ],
        },
      ],
    );

    // Every worker is blocked, and by its computer rather than by its route:
    // the computer is resolved first, so that is the honest first cause.
    assert.deepEqual(
      result.pending.filter((entry) => entry._tag === "worker").map((entry) => entry.blockedBy),
      ["computer", "computer", "computer", "computer"],
    );
  });
});

describe("mapLegacyWorkjetConfig with bindings", () => {
  it("produces a configuration the contract accepts", () => {
    const result = mapGolden(FULL_BINDINGS);
    const encoded = encodeWorkjetConfiguration(result.configuration);
    assert.deepEqual(decodeWorkjetConfiguration(encoded), result.configuration);
  });

  it("imports every computer and derives its harness list from the workers", () => {
    const result = mapGolden(FULL_BINDINGS);
    assert.strictEqual(result.counts.computersImported, 3);

    const byId = new Map(result.configuration.computers.map((entry) => [String(entry.id), entry]));
    const local = byId.get(LOCAL) as WorkjetComputer;
    assert.strictEqual(local.label, "Local");
    assert.strictEqual(local.presentationKind, "local");
    assert.strictEqual(String(local.environmentId), "env-local");
    assert.deepEqual(
      local.harnesses.map((entry) => [entry.harness, entry.available, entry.executableOverride]),
      [
        ["claude-code", false, "/opt/homebrew/bin/claude"],
        ["codex-cli", false, "/opt/homebrew/bin/codex"],
      ],
    );

    // Presentation only: the SSH host, user, port, and key paths are gone.
    const sshBox = byId.get(SSH_BOX) as WorkjetComputer;
    assert.strictEqual(sshBox.presentationKind, "ssh");
    assert.deepEqual(Object.keys(sshBox).sort(), [
      "environmentId",
      "harnesses",
      "id",
      "label",
      "presentationKind",
    ]);
    // No worker targets it, so it declares no harness rather than guessing one.
    assert.deepEqual(sshBox.harnesses, []);
  });

  it("turns each bound provider into a route and each bound pool into one narrowed route", () => {
    const result = mapGolden(FULL_BINDINGS);
    assert.deepEqual(
      result.configuration.llmRoutes.map((route) => [
        String(route.id),
        route.label,
        String(route.gatewayAccountId),
      ]),
      [
        [KIMI, "Kimi 1", "kimi-primary"],
        [ZAI, "Z.ai 1", "zai-z.ai-key"],
        [XAI, "xAI", "xai-oauth"],
        ["pool:OpenAI", "OpenAI (pool)", "codex-primary"],
      ],
    );

    const narrowing = decisionsFor(result.decisions, "workers[providerPool=OpenAI]");
    assert.strictEqual(narrowing.length, 1);
    assert.strictEqual(narrowing[0]?.outcome, "derived");
    assert.include(narrowing[0]?.reason ?? "", "Pool failover");
  });

  it("imports every worker with its capabilities, reasoning, and route", () => {
    const result = mapGolden(FULL_BINDINGS);
    assert.strictEqual(result.counts.workersImported, 4);
    assert.deepEqual(
      result.configuration.workerProfiles.map((profile) => [
        profile.name,
        profile.harness,
        String(profile.llmRouteId),
        profile.modelId,
        profile.reasoning,
        [...profile.capabilityIds],
      ]),
      [
        [
          "Sol · Completion",
          "claude-code",
          "pool:OpenAI",
          "gpt-5.6-sol",
          "high",
          ["greppy", "web-search"],
        ],
        ["Prototype C · GLM", "claude-code", ZAI, "glm-5.3", "medium", ["greppy"]],
        [
          "Web Research · Terra",
          "codex-cli",
          "pool:OpenAI",
          "gpt-5.6-terra",
          "automatic",
          ["web-search"],
        ],
        [
          "Standard Worker (remote)",
          "claude-code",
          XAI,
          "grok-4.6",
          "automatic",
          ["greppy", "web-search"],
        ],
      ],
    );
    assert.strictEqual(
      result.configuration.workerProfiles[1]?.instructions,
      "Produce a bounded disposable prototype. Do not attempt the final production solution.",
    );
  });

  it("keeps a worker out when only part of its references resolve", () => {
    const result = mapGolden({
      ...FULL_BINDINGS,
      environmentByComputerId: { [LOCAL]: EnvironmentId.make("env-local") },
    });
    assert.strictEqual(result.counts.computersImported, 1);
    assert.strictEqual(result.counts.workersImported, 3);
    assert.deepEqual(
      result.pending
        .filter((entry) => entry._tag === "worker")
        .map((entry) => [entry.workerName, entry.blockedBy]),
      [["Standard Worker (remote)", "computer"]],
    );
  });

  it("keeps a pool worker out when its pool has no account", () => {
    const result = mapGolden({ ...FULL_BINDINGS, gatewayAccountByProviderPool: {} });
    assert.strictEqual(result.counts.workersImported, 2);
    assert.deepEqual(
      result.pending
        .filter((entry) => entry._tag === "worker")
        .map((entry) => [entry.workerName, entry.blockedBy]),
      [
        ["Sol · Completion", "llm-route"],
        ["Web Research · Terra", "llm-route"],
      ],
    );
  });
});

describe("mapLegacyWorkjetConfig reports the awkward cases", () => {
  it("drops a per-computer executable override when the workers disagree", () => {
    const result = mapGolden(FULL_BINDINGS, (document) => {
      const workers = document["workers"] as Record<string, unknown>[];
      const invocation = workers[1]?.["invocation"] as Record<string, unknown>;
      invocation["executable"] = "/usr/local/bin/claude";
    });

    const local = result.configuration.computers.find((entry) => String(entry.id) === LOCAL);
    const claude = local?.harnesses.find((entry) => entry.harness === "claude-code");
    assert.isUndefined(claude?.executableOverride);
    const conflict = result.decisions.find(
      (entry) =>
        entry.source === `workers[computerID=${LOCAL},harness=claude-code].invocation.executable`,
    );
    assert.strictEqual(conflict?.outcome, "dropped");
    assert.include(conflict?.reason ?? "", "2 different executables");
  });

  it("reports an unrecognized skill id rather than enabling a plausible capability", () => {
    const result = mapGolden(FULL_BINDINGS, (document) => {
      const workers = document["workers"] as Record<string, unknown>[];
      const skillOverrides = workers[1]?.["skillOverrides"] as Record<string, unknown>;
      skillOverrides["web-stack"] = true;
    });
    const decision = result.decisions.find(
      (entry) =>
        entry.source ===
        "workers[id=00000000-0000-0000-0000-000000000023].skillOverrides.web-stack",
    );
    assert.strictEqual(decision?.outcome, "unmapped-field");
    const profile = result.configuration.workerProfiles.find(
      (entry) => entry.name === "Prototype C · GLM",
    );
    assert.deepEqual([...(profile?.capabilityIds ?? [])], ["greppy"]);
  });

  it("carries an unmodelled document field into the decision list", () => {
    const result = mapGolden(FULL_BINDINGS, (document) => {
      document["futureRootSetting"] = 7;
    });
    const decision = result.decisions.find((entry) => entry.source === "futureRootSetting");
    assert.strictEqual(decision?.outcome, "unmapped-field");
    assert.isNull(decision?.destination ?? null);
  });

  it("falls back to the typed default when a timeout is not a positive integer", () => {
    const result = mapGolden(FULL_BINDINGS, (document) => {
      document["turnTimeoutSeconds"] = 0;
      document["telemetryRetentionDays"] = 3.5;
    });
    assert.strictEqual(result.configuration.execution.turnTimeoutSeconds, 5400);
    assert.strictEqual(result.configuration.telemetry.retentionDays, 14);
    for (const source of ["turnTimeoutSeconds", "telemetryRetentionDays"]) {
      const defaulted = decisionsFor(result.decisions, source).find(
        (entry) => entry.outcome === "defaulted",
      );
      assert.isDefined(defaulted, source);
    }
  });
});

describe("composeManagedSystemPrompt", () => {
  const base = (): LegacyWorkjetConfig => readGolden().config;

  it("keeps every authored block, including the per-model rules", () => {
    const prompt = composeManagedSystemPrompt(base());
    assert.isTrue(prompt.startsWith("You are the sole orchestrator."));
    assert.include(prompt, "## Progress board");
    assert.include(prompt, "## Ad-hoc learnings");
    assert.include(prompt, "## Technical rules");
    assert.include(prompt, "## Model rules (imported from the legacy Workjet configuration)");
    assert.include(prompt, "### Sol");
    assert.include(prompt, "### grok-4.6");
    assert.include(prompt, "Grok is one independent discovery worker");
  });

  it("omits empty blocks and orders model rules deterministically", () => {
    const config: LegacyWorkjetConfig = {
      ...base(),
      progressBoardRules: "   ",
      adHocLearnings: "",
      technicalRules: "",
      modelPrompts: { zeta: "z", alpha: "a", blank: "  " },
    };
    assert.strictEqual(
      composeManagedSystemPrompt(config),
      [
        "You are the sole orchestrator. Own decomposition, routing, synthesis, integration, cleanup, and final verification. Worker reports are claims, never proof.",
        "## Model rules (imported from the legacy Workjet configuration)\n\n### alpha\n\na\n\n### zeta\n\nz",
      ].join("\n\n"),
    );
  });
});
