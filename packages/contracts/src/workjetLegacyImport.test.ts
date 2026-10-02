// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_WORKJET_LEGACY_IMPORT_BINDINGS,
  WORKJET_LEGACY_IMPORT_BINDABLE_KINDS,
  WORKJET_LEGACY_IMPORT_MAX_BINDINGS,
  WORKJET_LEGACY_IMPORT_SCHEMA_VERSION,
  WorkjetLegacyImportBindings,
  WorkjetLegacyImportDecideInput,
  WorkjetLegacyImportDecisionResult,
  WorkjetLegacyImportError,
  WorkjetLegacyImportInspection,
  WorkjetLegacyImportPendingPool,
} from "./workjetLegacyImport.ts";

const decodeInspection = Schema.decodeUnknownSync(WorkjetLegacyImportInspection);
const encodeInspection = Schema.encodeUnknownSync(WorkjetLegacyImportInspection);
const decodeDecide = Schema.decodeUnknownSync(WorkjetLegacyImportDecideInput);
const decodeResult = Schema.decodeUnknownSync(WorkjetLegacyImportDecisionResult);
const decodeBindings = Schema.decodeUnknownSync(WorkjetLegacyImportBindings);
const decodePool = Schema.decodeUnknownSync(WorkjetLegacyImportPendingPool);

const version = WORKJET_LEGACY_IMPORT_SCHEMA_VERSION;
const control = String.fromCharCode(0);

const offer = {
  schemaVersion: version,
  state: "offer",
  legacyPath: "/Users/me/Library/Application Support/Workjet/config.v1.json",
  settingsPath: "/Users/me/.t3/settings.json",
  summary: {
    computersImported: 0,
    computersTotal: 3,
    llmRoutesImported: 0,
    workersImported: 0,
    workersTotal: 12,
    pendingTotal: 14,
    dropTotal: 51,
  },
  pending: [
    {
      kind: "computer-environment",
      computerId: "00000000-0000-0000-0000-000000000001",
      computerName: "Local",
      transport: "Lokal",
      host: null,
    },
    {
      kind: "provider-pool-account",
      pool: "OpenAI",
      workerIds: ["worker-1", "worker-2"],
      failoverLoss: true,
    },
  ],
  pendingTruncated: false,
  drops: [
    {
      kind: "dropped",
      source: "computers[].host",
      reason: "Transport detail. Computers reference a Code environment instead.",
    },
  ],
  dropsTruncated: false,
  bindable: {
    environments: [{ environmentId: "env-self", isSelf: true, referencedByConfiguration: false }],
    gatewayAccounts: [
      { accountId: "zai-key", label: "Z.ai", provider: "zai", credentialSuffix: "1234" },
    ],
    gatewayCatalogAvailable: true,
  },
} as const;

describe("legacy Workjet import inspection", () => {
  it("round-trips a full offer", () => {
    expect(encodeInspection(decodeInspection(offer))).toEqual(offer);
  });

  it("keeps the four honest states distinguishable", () => {
    expect(decodeInspection({ schemaVersion: version, state: "nothing-to-import" }).state).toBe(
      "nothing-to-import",
    );
    const decided = decodeInspection({
      schemaVersion: version,
      state: "already-decided",
      outcome: "declined",
      decidedAt: "2026-08-19T10:00:00.000Z",
      legacyPath: "/Users/me/config.v1.json",
      importedComputers: 0,
      importedLlmRoutes: 0,
      importedWorkerProfiles: 0,
      pendingAtImport: 0,
    });
    // A decline must carry its DATE: the panel has to say when, not just that.
    expect(decided.state === "already-decided" && decided.decidedAt).toBe(
      "2026-08-19T10:00:00.000Z",
    );
    const unreadable = decodeInspection({
      schemaVersion: version,
      state: "unreadable",
      legacyPath: "/Users/me/config.v1.json",
      failure: { reason: "unsupported-version", path: "version", detail: "Version 2 is unknown." },
    });
    expect(unreadable.state === "unreadable" && unreadable.failure?.reason).toBe(
      "unsupported-version",
    );
    // A document that could not be read AT ALL is not a reader refusal.
    const unreadableFile = decodeInspection({
      schemaVersion: version,
      state: "unreadable",
      legacyPath: "/Users/me/config.v1.json",
      failure: null,
    });
    expect(unreadableFile.state === "unreadable" && unreadableFile.failure).toBeNull();
  });

  it("states the failover loss on the pool record itself, not in prose", () => {
    expect(
      decodePool({
        kind: "provider-pool-account",
        pool: "OpenAI",
        workerIds: [],
        failoverLoss: true,
      }).failoverLoss,
    ).toBe(true);
    // The narrowing is not something a caller may claim did not happen.
    expect(() =>
      decodePool({
        kind: "provider-pool-account",
        pool: "OpenAI",
        workerIds: [],
        failoverLoss: false,
      }),
    ).toThrow();
  });

  it("refuses control characters and unbounded text in operator-authored fields", () => {
    expect(() =>
      decodeInspection({
        ...offer,
        pending: [{ ...offer.pending[0], computerName: `Local${control}` }],
      }),
    ).toThrow();
    expect(() => decodeInspection({ ...offer, legacyPath: "/".padEnd(2048, "x") })).toThrow();
  });
});

describe("legacy Workjet import decision", () => {
  it("lets decline carry no bindings at all", () => {
    const declined = decodeDecide({ action: "decline" });
    expect(declined.action).toBe("decline");
    expect("bindings" in declined).toBe(false);
  });

  it("carries an acknowledged failover loss with every pool binding", () => {
    const accepted = decodeDecide({
      action: "accept",
      bindings: {
        ...EMPTY_WORKJET_LEGACY_IMPORT_BINDINGS,
        pools: [{ pool: "OpenAI", gatewayAccountId: "openai-1", acknowledgeFailoverLoss: true }],
      },
    });
    expect(accepted.action === "accept" && accepted.bindings.pools.length).toBe(1);
    // An unacknowledged pool binding is not expressible.
    expect(() =>
      decodeDecide({
        action: "accept",
        bindings: {
          ...EMPTY_WORKJET_LEGACY_IMPORT_BINDINGS,
          pools: [{ pool: "OpenAI", gatewayAccountId: "openai-1", acknowledgeFailoverLoss: false }],
        },
      }),
    ).toThrow();
  });

  it("bounds every binding list", () => {
    const many = Array.from({ length: WORKJET_LEGACY_IMPORT_MAX_BINDINGS + 1 }, (_, index) =>
      String(index + 1),
    );
    expect(() =>
      decodeBindings({ ...EMPTY_WORKJET_LEGACY_IMPORT_BINDINGS, skippedComputerIds: many }),
    ).toThrow();
  });

  it("reports every outcome the runner can produce", () => {
    const outcomes = [
      {
        schemaVersion: version,
        outcome: "imported",
        legacyPath: "/Users/me/config.v1.json",
        importedComputers: 1,
        importedLlmRoutes: 2,
        importedWorkerProfiles: 3,
        pending: [],
      },
      { schemaVersion: version, outcome: "declined" },
      { schemaVersion: version, outcome: "already-decided", previousOutcome: "imported" },
      { schemaVersion: version, outcome: "nothing-to-import" },
      {
        schemaVersion: version,
        outcome: "unreadable",
        legacyPath: "/Users/me/config.v1.json",
        failure: { reason: "not-json", path: "<document>", detail: "Not JSON." },
      },
      {
        schemaVersion: version,
        outcome: "not-persisted",
        legacyPath: "/Users/me/config.v1.json",
        detail: "The settings store rejected the patch.",
      },
    ] as const;
    for (const outcome of outcomes) {
      expect(decodeResult(outcome).outcome).toBe(outcome.outcome);
    }
  });

  it("names the three records an operator can actually answer", () => {
    expect([...WORKJET_LEGACY_IMPORT_BINDABLE_KINDS]).toEqual([
      "computer-environment",
      "provider-account",
      "provider-pool-account",
    ]);
  });

  it("says what it refused and which subject it refused", () => {
    const error = new WorkjetLegacyImportError({
      reason: "unknown-environment",
      subject: "env-nobody-has-ever-seen",
    });
    expect(error.message).toContain("env-nobody-has-ever-seen");
    expect(
      new WorkjetLegacyImportError({ reason: "gateway-unavailable", subject: null }).message,
    ).toContain("unavailable");
  });
});
