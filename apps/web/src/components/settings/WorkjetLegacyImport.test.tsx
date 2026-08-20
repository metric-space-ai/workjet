import {
  EnvironmentId,
  WorkjetGatewayAccountId,
  type WorkjetLegacyImportBindings,
  type WorkjetLegacyImportInspection,
  type WorkjetLegacyImportPending,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  legacyImportAcceptState,
  legacyImportBindableRecords,
  legacyImportDecideBindings,
  legacyImportDecidedDescription,
  legacyImportRecordKey,
  WORKJET_LEGACY_IMPORT_FAILOVER_NOTICE,
  WORKJET_LEGACY_IMPORT_SKIP_NOTICE,
  WorkjetLegacyImportSectionView,
  type WorkjetLegacyImportDraft,
  type WorkjetLegacyImportSectionState,
} from "./WorkjetLegacyImport";
import { workjetLegacyImportFailureDescription } from "./useWorkjetLegacyImportSection";

const SELF = EnvironmentId.make("env-self");
const ACCOUNT = WorkjetGatewayAccountId.make("zai-key");

const COMPUTER: WorkjetLegacyImportPending = {
  kind: "computer-environment",
  computerId: "computer-1",
  computerName: "build-box",
  transport: "SSH",
  host: "build-box.example.internal",
};
const PROVIDER: WorkjetLegacyImportPending = {
  kind: "provider-account",
  providerId: "provider-1",
  providerName: "Z.ai 1",
  modelProvider: "Z.ai",
  accountLabel: "personal",
  externalCredentialId: "4f2c",
  modelIds: ["glm-5.3"],
};
const POOL: WorkjetLegacyImportPending = {
  kind: "provider-pool-account",
  pool: "OpenAI",
  workerIds: ["worker-1", "worker-2"],
  failoverLoss: true,
};
const WORKER: WorkjetLegacyImportPending = {
  kind: "worker",
  workerId: "worker-1",
  workerName: "Sol · Completion",
  blockedBy: "llm-route",
  detail: "The worker's provider account or pool has no bound gateway account.",
};

const PENDING = [COMPUTER, PROVIDER, POOL, WORKER] as const;

const OFFER: WorkjetLegacyImportInspection = {
  schemaVersion: 1,
  state: "offer",
  legacyPath: "/Users/me/Library/Application Support/Workjet/config.v1.json",
  settingsPath: "/Users/me/.t3/settings.json",
  summary: {
    computersImported: 0,
    computersTotal: 3,
    llmRoutesImported: 0,
    workersImported: 0,
    workersTotal: 4,
    pendingTotal: 4,
    dropTotal: 2,
  },
  pending: PENDING,
  pendingTruncated: false,
  drops: [
    {
      kind: "dropped",
      source: "computers[].host",
      reason: "Transport detail. Computers reference a Code environment instead.",
    },
    {
      kind: "unmapped-field",
      source: "workers[].futureField",
      reason: "Present in the document but not modelled by this reader.",
    },
  ],
  dropsTruncated: false,
  bindable: {
    environments: [{ environmentId: SELF, isSelf: true, referencedByConfiguration: false }],
    gatewayAccounts: [
      { accountId: ACCOUNT, label: "Z.ai key", provider: "zai", credentialSuffix: "1234" },
    ],
    gatewayCatalogAvailable: true,
  },
};

const state = (
  overrides: Partial<WorkjetLegacyImportSectionState> = {},
): WorkjetLegacyImportSectionState => ({
  inspection: OFFER,
  isInitialLoading: false,
  hasInspectFailure: false,
  isRefreshing: false,
  isDeciding: false,
  error: null,
  onRefresh: () => undefined,
  onAccept: () => undefined,
  onDecline: () => undefined,
  ...overrides,
});

const render = (
  overrides: Partial<WorkjetLegacyImportSectionState> = {},
  draft: WorkjetLegacyImportDraft = {},
) =>
  renderToStaticMarkup(
    <WorkjetLegacyImportSectionView
      state={state(overrides)}
      draft={draft}
      onAnswer={() => undefined}
    />,
  );

/** The opening tag of the accept button, so its disabled state is assertable. */
const importButtonTag = (markup: string): string => {
  const label = markup.indexOf("Import once");
  expect(label).toBeGreaterThan(0);
  return markup.slice(markup.lastIndexOf("<button", label), label);
};

const ANSWERED: WorkjetLegacyImportDraft = {
  [legacyImportRecordKey(COMPUTER)]: { _tag: "bind", targetId: SELF },
  [legacyImportRecordKey(PROVIDER)]: { _tag: "skip" },
  [legacyImportRecordKey(POOL)]: { _tag: "bind", targetId: ACCOUNT },
};

describe("legacy import accept gating", () => {
  it("counts only the records an operator can actually answer", () => {
    // The worker row is a consequence of the other three, so requiring an
    // answer for it would ask for a choice that does not exist.
    expect(legacyImportBindableRecords(PENDING).map((record) => record.kind)).toEqual([
      "computer-environment",
      "provider-account",
      "provider-pool-account",
    ]);
  });

  it("keeps accept disabled until every record is bound or explicitly skipped", () => {
    expect(legacyImportAcceptState(PENDING, {}).canAccept).toBe(false);
    expect(legacyImportAcceptState(PENDING, {}).unansweredCount).toBe(3);

    const partial: WorkjetLegacyImportDraft = {
      [legacyImportRecordKey(COMPUTER)]: { _tag: "bind", targetId: SELF },
      [legacyImportRecordKey(PROVIDER)]: { _tag: "skip" },
    };
    expect(legacyImportAcceptState(PENDING, partial).canAccept).toBe(false);
    expect(legacyImportAcceptState(PENDING, partial).unansweredCount).toBe(1);

    const full = legacyImportAcceptState(PENDING, ANSWERED);
    expect(full.canAccept).toBe(true);
    expect(full.boundCount).toBe(2);
    expect(full.skippedCount).toBe(1);
  });

  it("treats an explicit skip as an answer, never as a missing one", () => {
    const allSkipped: WorkjetLegacyImportDraft = Object.fromEntries(
      legacyImportBindableRecords(PENDING).map((record) => [
        legacyImportRecordKey(record),
        { _tag: "skip" } as const,
      ]),
    );
    expect(legacyImportAcceptState(PENDING, allSkipped).canAccept).toBe(true);
    expect(legacyImportAcceptState(PENDING, allSkipped).boundCount).toBe(0);
  });

  it("sends every record exactly once, as a binding or as a skip", () => {
    const bindings: WorkjetLegacyImportBindings = legacyImportDecideBindings(PENDING, ANSWERED);
    expect(bindings.computers).toEqual([{ computerId: "computer-1", environmentId: SELF }]);
    expect(bindings.skippedProviderIds).toEqual(["provider-1"]);
    // Choosing an account for a pool carries the acknowledged failover loss.
    expect(bindings.pools).toEqual([
      { pool: "OpenAI", gatewayAccountId: ACCOUNT, acknowledgeFailoverLoss: true },
    ]);
    expect(bindings.skippedComputerIds).toEqual([]);
    expect(bindings.skippedPools).toEqual([]);
    expect(bindings.providers).toEqual([]);
  });

  it("renders the accept button disabled while a record is unanswered", () => {
    const blocked = render();
    expect(blocked).toContain("Import once");
    expect(blocked).toContain(
      "Accept stays disabled until every record above is bound or explicitly skipped.",
    );
    expect(blocked).toContain("0/3 answered");
    expect(importButtonTag(blocked)).toContain('disabled=""');

    const ready = render({}, ANSWERED);
    expect(importButtonTag(ready)).not.toContain('disabled=""');
    expect(ready).toContain("3/3 answered");
    expect(ready).not.toContain("Accept stays disabled until every record above");
    expect(ready).toContain("2 record(s) bound, 1 skipped and not imported.");
  });
});

describe("legacy import offer surface", () => {
  it("states the failover loss at the pool control, not in a footnote", () => {
    const markup = render();
    // Rendered markup escapes the apostrophe, so match the plain span of the
    // sentence the notice is built from.
    const notice = "Binding this pool keeps only the account you choose";
    expect(WORKJET_LEGACY_IMPORT_FAILOVER_NOTICE).toContain(notice);
    expect(markup).toContain(notice);
    // It sits inside the pool row itself, before the account selector.
    const poolRowStart = markup.indexOf("Pool · OpenAI");
    const noticeAt = markup.indexOf(notice);
    const selectorAt = markup.indexOf("Gateway account for pool OpenAI");
    expect(poolRowStart).toBeGreaterThanOrEqual(0);
    expect(noticeAt).toBeGreaterThan(poolRowStart);
    expect(selectorAt).toBeGreaterThan(noticeAt);
  });

  it("says a skipped record will not be imported", () => {
    const markup = render({}, { [legacyImportRecordKey(PROVIDER)]: { _tag: "skip" } });
    expect(markup).toContain(WORKJET_LEGACY_IMPORT_SKIP_NOTICE);
  });

  it("shows every drop with the reason it will not come across", () => {
    const markup = render();
    expect(markup).toContain("What will not come across (2)");
    expect(markup).toContain("computers[].host");
    expect(markup).toContain("Transport detail.");
    expect(markup).toContain("workers[].futureField");
    expect(markup).toContain("(not modelled)");
  });

  it("shows the evidence needed to recognize a machine and an account", () => {
    const markup = render();
    expect(markup).toContain("build-box.example.internal");
    expect(markup).toContain("SSH");
    expect(markup).toContain("CLIProxy 4f2c");
    expect(markup).toContain("glm-5.3");
  });

  it("presents blocked workers as consequences, not as controls", () => {
    const markup = render();
    expect(markup).toContain("1 worker(s) follow from the choices above");
    expect(markup).toContain("its provider account or pool is not bound");
    expect(markup).not.toContain("Gateway account for Sol");
  });

  it("says the import is read-only and runs exactly once", () => {
    const markup = render();
    expect(markup).toContain("never modifies, moves, or deletes the legacy document");
    expect(markup).toContain("Declining is also final");
  });

  it("reports a server refusal as a refusal, with nothing written", () => {
    const markup = render({ error: "The provider gateway has no such account (nope)." });
    expect(markup).toContain("The server refused this import");
    expect(markup).toContain("no settings were changed and no decision was recorded");
  });
});

describe("legacy import honest states", () => {
  it("says there is nothing to import", () => {
    const markup = render({
      inspection: { schemaVersion: 1, state: "nothing-to-import" },
    });
    expect(markup).toContain("Nothing to import");
    expect(markup).not.toContain("Import once");
  });

  it("says what was imported, and when", () => {
    const markup = render({
      inspection: {
        schemaVersion: 1,
        state: "already-decided",
        outcome: "imported",
        decidedAt: "2026-08-19T10:00:00.000Z",
        legacyPath: "/Users/me/config.v1.json",
        importedComputers: 1,
        importedLlmRoutes: 2,
        importedWorkerProfiles: 3,
        pendingAtImport: 4,
      },
    });
    expect(markup).toContain("Already imported");
    expect(markup).toContain("2026-08-19T10:00:00.000Z");
    expect(markup).toContain("4 record(s) were left unbound and not imported");
    expect(markup).not.toContain("Import once");
  });

  it("says a decline is recorded, with its date", () => {
    const markup = render({
      inspection: {
        schemaVersion: 1,
        state: "already-decided",
        outcome: "declined",
        decidedAt: "2026-08-19T10:00:00.000Z",
        legacyPath: "/Users/me/config.v1.json",
        importedComputers: 0,
        importedLlmRoutes: 0,
        importedWorkerProfiles: 0,
        pendingAtImport: 0,
      },
    });
    expect(markup).toContain("Import declined");
    expect(markup).toContain("You declined this import on 2026-08-19T10:00:00.000Z");
    expect(markup).toContain("not shown again");
  });

  it("calls an unreadable document a defect, not a decision", () => {
    const markup = render({
      inspection: {
        schemaVersion: 1,
        state: "unreadable",
        legacyPath: "/Users/me/config.v1.json",
        failure: {
          reason: "unsupported-version",
          path: "version",
          detail: "This reader accepts version 1 only.",
        },
      },
    });
    expect(markup).toContain("could not be read");
    expect(markup).toContain("Refused: unsupported-version");
    expect(markup).toContain("no marker was written and nothing was");
    expect(markup).not.toContain("Import once");
  });

  it("distinguishes a file it could not read from a document it refused", () => {
    const markup = render({
      inspection: {
        schemaVersion: 1,
        state: "unreadable",
        legacyPath: "/Users/me/config.v1.json",
        failure: null,
      },
    });
    expect(markup).toContain("exists but could not be read at all");
    expect(markup).toContain("the offer returns once the file is readable");
  });

  it("says so when the offer itself could not be read", () => {
    const markup = render({ inspection: null, hasInspectFailure: true });
    expect(markup).toContain("The import offer could not be read");
    expect(markup).toContain("Nothing was changed.");
  });

  it("names the environment authority in a decided description", () => {
    expect(
      legacyImportDecidedDescription({
        schemaVersion: 1,
        state: "already-decided",
        outcome: "imported",
        decidedAt: null,
        legacyPath: null,
        importedComputers: 0,
        importedLlmRoutes: 0,
        importedWorkerProfiles: 0,
        pendingAtImport: 0,
      }),
    ).toContain("at an unrecorded time");
  });
});

describe("legacy import refusal text", () => {
  it("explains which authority refused, and that nothing was written", () => {
    expect(
      workjetLegacyImportFailureDescription({ reason: "unknown-environment", subject: "env-x" }),
    ).toContain("env-x");
    expect(
      workjetLegacyImportFailureDescription({ reason: "gateway-unavailable", subject: null }),
    ).toContain("gateway is unavailable");
    expect(
      workjetLegacyImportFailureDescription({ reason: "unresolved-pending", subject: "pool-x" }),
    ).toContain("Bind it or skip it explicitly");
    expect(workjetLegacyImportFailureDescription(new Error("boom"))).toContain(
      "Nothing was changed.",
    );
  });
});
