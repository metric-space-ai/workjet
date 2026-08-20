import { assert, describe, it } from "@effect/vitest";

import {
  LEGACY_WORKJET_CONFIG_VERSION,
  LEGACY_WORKJET_FIELD_PATHS,
  parseLegacyWorkjetConfig,
  readLegacyWorkjetConfig,
} from "./LegacyWorkjetConfig.ts";
import goldenSample from "./testFixtures/legacyWorkjetConfig.v1.json" with { type: "json" };

const golden = (): Record<string, unknown> =>
  structuredClone(goldenSample) as Record<string, unknown>;

const readGolden = (mutate: (document: Record<string, unknown>) => void = () => {}) => {
  const document = golden();
  mutate(document);
  return readLegacyWorkjetConfig(document);
};

describe("readLegacyWorkjetConfig", () => {
  it("reads the golden sample without losing a field", () => {
    const result = readGolden();
    assert.strictEqual(result._tag, "read");
    if (result._tag !== "read") return;

    assert.deepEqual([...result.unknownFields], []);
    const config = result.config;
    assert.strictEqual(config.version, LEGACY_WORKJET_CONFIG_VERSION);
    assert.strictEqual(config.computers.length, 3);
    assert.strictEqual(config.providers.length, 3);
    assert.strictEqual(config.workers.length, 4);
    assert.strictEqual(config.selectedComputerID, "00000000-0000-0000-0000-000000000001");
    assert.strictEqual(config.skillActivation, "Global");
    assert.strictEqual(config.probeTimeoutSeconds, 120);
    assert.strictEqual(config.turnTimeoutSeconds, 5400);
    assert.strictEqual(config.telemetryRetentionDays, 14);
    assert.isTrue(config.telemetryClaudeCodeEvents);
    assert.isFalse(config.telemetrySidecarEvents);
    assert.strictEqual(config.cliProxy.endpoint, "http://127.0.0.1:8317");
    assert.strictEqual(config.cliProxy.usageStatisticsEnabled, false);
    assert.deepEqual(Object.keys(config.modelPrompts).sort(), ["Sol", "grok-4.6"]);
  });

  it("keeps the optional keys the live document happens not to contain", () => {
    const result = readGolden();
    assert.strictEqual(result._tag, "read");
    if (result._tag !== "read") return;

    // Both come from the Swift binary's CodingKeys, not from the live sample.
    const sshComputer = result.config.computers[2];
    assert.strictEqual(
      sshComputer?.remoteSetupIssue,
      "Der Host akzeptiert den hinterlegten Schlüssel nicht.",
    );
    const xaiProvider = result.config.providers[2];
    assert.strictEqual(xaiProvider?.loginExecutable, "/opt/homebrew/bin/cliproxy");

    // …and leaves genuinely absent optionals absent rather than inventing them.
    const localComputer = result.config.computers[0];
    assert.isUndefined(localComputer?.tailscaleSSHEnabled);
    assert.isUndefined(localComputer?.lastSuccessfulDeploymentAt);
  });

  it("round-trips every worker field the mapping depends on", () => {
    const result = readGolden();
    assert.strictEqual(result._tag, "read");
    if (result._tag !== "read") return;

    const worker = result.config.workers[0];
    assert.deepEqual(worker, {
      id: "00000000-0000-0000-0000-000000000011",
      name: "Sol · Completion",
      model: "gpt-5.6-sol",
      instructions: "Treat the consolidated brief as a contract. Implement only whitelisted files.",
      reasoningEffort: "high",
      harness: "Claude Code",
      computerID: "00000000-0000-0000-0000-000000000001",
      providerID: undefined,
      providerPool: "OpenAI",
      skillOverrides: { greppy: true, "web-research": true },
      invocation: {
        executable: "/opt/homebrew/bin/claude",
        arguments: ["--bare", "-p", "<WORKJET_BRIEF>", "--allowedTools", "Read,Write,Edit"],
        capabilities: ["Bestehende Dateien präzise umsetzen"],
        options: { fastMode: "false" },
      },
      capacity: { variant: "unavailable" },
    });
  });

  it("reads an empty reasoning effort as the automatic selection's raw value", () => {
    const result = readGolden();
    assert.strictEqual(result._tag, "read");
    if (result._tag !== "read") return;
    assert.strictEqual(result.config.workers[2]?.reasoningEffort, "");
  });
});

describe("readLegacyWorkjetConfig surfaces unknown fields", () => {
  it("reports an unmodelled root key instead of dropping it", () => {
    const result = readGolden((document) => {
      document["futureRootSetting"] = 7;
    });
    assert.strictEqual(result._tag, "read");
    if (result._tag !== "read") return;
    assert.deepEqual([...result.unknownFields], ["futureRootSetting"]);
  });

  it("reports unmodelled keys nested in every collection, by path", () => {
    const result = readGolden((document) => {
      const computers = document["computers"] as Record<string, unknown>[];
      (computers[1] as Record<string, unknown>)["gpuReserved"] = true;
      const workers = document["workers"] as Record<string, unknown>[];
      (workers[0] as Record<string, unknown>)["mcpServers"] = [];
      const invocation = workers[0]?.["invocation"] as Record<string, unknown>;
      invocation["workingDirectory"] = "/tmp";
      const providers = document["providers"] as Record<string, unknown>[];
      (providers[0] as Record<string, unknown>)["organizationId"] = "org";
      const cliProxy = document["cliProxy"] as Record<string, unknown>;
      cliProxy["tlsFingerprint"] = "aa:bb";
    });
    assert.strictEqual(result._tag, "read");
    if (result._tag !== "read") return;
    assert.deepEqual(
      [...result.unknownFields],
      [
        "cliProxy.tlsFingerprint",
        "computers[1].gpuReserved",
        "providers[0].organizationId",
        "workers[0].invocation.workingDirectory",
        "workers[0].mcpServers",
      ],
    );
  });

  it("treats record keys as data, not as schema", () => {
    const result = readGolden((document) => {
      (document["modelPrompts"] as Record<string, unknown>)["a-new-model"] = "rules";
      const workers = document["workers"] as Record<string, unknown>[];
      (workers[0]?.["skillOverrides"] as Record<string, unknown>)["some-new-skill"] = true;
    });
    assert.strictEqual(result._tag, "read");
    if (result._tag !== "read") return;
    // Neither is an unknown FIELD: both live in open records. The unrecognized
    // skill id is a mapping decision, asserted in the mapping test.
    assert.deepEqual([...result.unknownFields], []);
  });
});

describe("readLegacyWorkjetConfig fails closed", () => {
  it("rejects text that is not JSON", () => {
    const result = parseLegacyWorkjetConfig("{ not json");
    assert.strictEqual(result._tag, "unreadable");
    if (result._tag !== "unreadable") return;
    assert.strictEqual(result.failure.reason, "not-json");
  });

  it("rejects a document that is not an object", () => {
    for (const document of [[], "config", 1, null]) {
      const result = readLegacyWorkjetConfig(document);
      assert.strictEqual(result._tag, "unreadable");
      if (result._tag !== "unreadable") continue;
      assert.strictEqual(result.failure.reason, "not-an-object");
    }
  });

  it("rejects a missing version", () => {
    const document = golden();
    delete document["version"];
    const result = readLegacyWorkjetConfig(document);
    assert.strictEqual(result._tag, "unreadable");
    if (result._tag !== "unreadable") return;
    assert.strictEqual(result.failure.reason, "missing-version");
    assert.strictEqual(result.failure.path, "version");
  });

  it("never rewrites an unsupported version", () => {
    const result = readGolden((document) => {
      document["version"] = 2;
    });
    assert.strictEqual(result._tag, "unreadable");
    if (result._tag !== "unreadable") return;
    assert.strictEqual(result.failure.reason, "unsupported-version");
  });

  it("rejects a wrongly typed value and names its path", () => {
    const result = readGolden((document) => {
      document["turnTimeoutSeconds"] = "5400";
    });
    assert.strictEqual(result._tag, "unreadable");
    if (result._tag !== "unreadable") return;
    assert.strictEqual(result.failure.reason, "invalid-type");
    assert.strictEqual(result.failure.path, "turnTimeoutSeconds");
  });

  it("rejects an enum value the Swift app cannot emit", () => {
    const cases: ReadonlyArray<readonly [string, (document: Record<string, unknown>) => void]> = [
      [
        "workers[0].harness",
        (document) => {
          const workers = document["workers"] as Record<string, unknown>[];
          (workers[0] as Record<string, unknown>)["harness"] = "Gemini CLI";
        },
      ],
      [
        "computers[0].transport",
        (document) => {
          const computers = document["computers"] as Record<string, unknown>[];
          (computers[0] as Record<string, unknown>)["transport"] = "Relay";
        },
      ],
      [
        "workers[0].reasoningEffort",
        (document) => {
          const workers = document["workers"] as Record<string, unknown>[];
          (workers[0] as Record<string, unknown>)["reasoningEffort"] = "gigathink";
        },
      ],
      [
        "providers[0].kind",
        (document) => {
          const providers = document["providers"] as Record<string, unknown>[];
          (providers[0] as Record<string, unknown>)["kind"] = "Local Ollama";
        },
      ],
      [
        "skillActivation",
        (document) => {
          document["skillActivation"] = "Nur Menüleiste";
        },
      ],
    ];

    for (const [path, mutate] of cases) {
      const result = readGolden(mutate);
      assert.strictEqual(result._tag, "unreadable", path);
      if (result._tag !== "unreadable") continue;
      assert.strictEqual(result.failure.reason, "invalid-enum", path);
      assert.strictEqual(result.failure.path, path);
    }
  });

  it("rejects a capacity envelope whose variant is unknown", () => {
    const result = readGolden((document) => {
      const providers = document["providers"] as Record<string, unknown>[];
      (providers[0] as Record<string, unknown>)["capacity"] = { throttled: { reason: "x" } };
    });
    assert.strictEqual(result._tag, "unreadable");
    if (result._tag !== "unreadable") return;
    assert.strictEqual(result.failure.reason, "invalid-enum");
    assert.strictEqual(result.failure.path, "providers[0].capacity");
  });

  it("reports only the first failure, so the cause is unambiguous", () => {
    const result = readGolden((document) => {
      document["providerSlots"] = "three";
      document["turnTimeoutSeconds"] = "5400";
    });
    assert.strictEqual(result._tag, "unreadable");
    if (result._tag !== "unreadable") return;
    assert.strictEqual(result.failure.path, "providerSlots");
  });
});

describe("LEGACY_WORKJET_FIELD_PATHS", () => {
  it("covers every key the golden sample actually contains", () => {
    const declared = new Set(LEGACY_WORKJET_FIELD_PATHS);
    const document = golden();
    const seen = new Set<string>();

    for (const key of Object.keys(document)) {
      if (["workers", "computers", "providers", "cliProxy"].includes(key)) continue;
      seen.add(key);
    }
    for (const computer of document["computers"] as Record<string, unknown>[]) {
      for (const key of Object.keys(computer)) seen.add(`computers[].${key}`);
    }
    for (const worker of document["workers"] as Record<string, unknown>[]) {
      for (const key of Object.keys(worker)) {
        if (key === "invocation") {
          for (const nested of Object.keys(worker["invocation"] as Record<string, unknown>)) {
            seen.add(`workers[].invocation.${nested}`);
          }
          continue;
        }
        seen.add(`workers[].${key}`);
      }
    }
    for (const provider of document["providers"] as Record<string, unknown>[]) {
      for (const key of Object.keys(provider)) seen.add(`providers[].${key}`);
    }
    for (const key of Object.keys(document["cliProxy"] as Record<string, unknown>)) {
      seen.add(`cliProxy.${key}`);
    }

    assert.deepEqual([...seen].filter((path) => !declared.has(path)).sort(), []);
  });

  it("is sorted and free of duplicates", () => {
    assert.deepEqual([...LEGACY_WORKJET_FIELD_PATHS], [...LEGACY_WORKJET_FIELD_PATHS].sort());
    assert.strictEqual(new Set(LEGACY_WORKJET_FIELD_PATHS).size, LEGACY_WORKJET_FIELD_PATHS.length);
  });
});
