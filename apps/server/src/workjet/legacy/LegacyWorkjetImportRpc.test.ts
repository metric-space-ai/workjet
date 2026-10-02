import { assert, describe, it } from "@effect/vitest";
import {
  EMPTY_WORKJET_LEGACY_IMPORT_BINDINGS,
  EnvironmentId,
  WorkjetGatewayAccountId,
  WorkjetGatewayOperationError,
  type WorkjetGatewayCatalog,
  type WorkjetLegacyImportBindings,
  type WorkjetLegacyImportInspection,
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import {
  layerTest as serverSettingsLayerTest,
  ServerSettingsService,
} from "../../serverSettings.ts";
import {
  LEGACY_WORKJET_IMPORT_MARKER_FILE,
  LegacyWorkjetImport,
  layer as legacyWorkjetImportLayer,
} from "./LegacyWorkjetImport.ts";
import { makeLegacyWorkjetImportRpcHandlers } from "./LegacyWorkjetImportRpc.ts";
import goldenSample from "./testFixtures/legacyWorkjetConfig.v1.json" with { type: "json" };

/**
 * These tests drive the REAL runner over a fake filesystem rather than a stubbed
 * importer: the claims worth making here — one settings patch, one marker, a
 * terminal decline — are claims about what actually lands on disk.
 */
const encodeDocument = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const HOME = "/Users/me";
const LEGACY_PATH = `${HOME}/Library/Application Support/Workjet/config.v1.json`;
const STATE_DIR = "/state/userdata";
const SETTINGS_PATH = `${STATE_DIR}/settings.json`;
const MARKER_PATH = `${STATE_DIR}/${LEGACY_WORKJET_IMPORT_MARKER_FILE}`;

const SELF_ENVIRONMENT = EnvironmentId.make("env-self");
const CONFIGURED_ENVIRONMENT = EnvironmentId.make("env-already-configured");
const UNKNOWN_ENVIRONMENT = EnvironmentId.make("env-nobody-has-ever-seen");

const ZAI_ACCOUNT = WorkjetGatewayAccountId.make("zai-z.ai-key");
const OPENAI_ACCOUNT = WorkjetGatewayAccountId.make("openai-personal");

const LOCAL_COMPUTER = "00000000-0000-0000-0000-000000000001";
const TAILNET_COMPUTER = "00000000-0000-0000-0000-000000000002";
const SSH_COMPUTER = "00000000-0000-0000-0000-000000000003";
const KIMI_PROVIDER = "64ECBBC6-361B-459D-A675-E4358F7F3E5E";
const ZAI_PROVIDER = "14F384A7-0D3F-45D1-9CF9-8962A3B28739";
const XAI_PROVIDER = "C6E95930-179B-4CDB-9A00-197E21906EF2";
const OPENAI_POOL = "OpenAI";

const catalog: WorkjetGatewayCatalog = {
  schemaVersion: 1,
  accounts: [
    {
      id: ZAI_ACCOUNT,
      label: "Z.ai key",
      provider: "zai",
      enabled: true,
      priority: 0,
      weight: 1,
      modelIds: ["glm-5.3"],
      credentialSuffix: "1234",
    },
    {
      id: OPENAI_ACCOUNT,
      label: "OpenAI personal",
      provider: "claude",
      enabled: true,
      priority: 0,
      weight: 1,
      modelIds: [],
      credentialSuffix: null,
    },
  ],
  pools: [],
  routes: [],
  models: [],
  routingStrategy: "round-robin",
  providerPools: [],
};

interface FakeDisk {
  readonly files: Map<string, string>;
  readonly writes: string[];
}

const makeDisk = (files: Record<string, string> = {}): FakeDisk => ({
  files: new Map(Object.entries(files)),
  writes: [],
});

const makeImportLayer = (disk: FakeDisk) => {
  const fileSystem = FileSystem.layerNoop({
    exists: (path) => Effect.succeed(disk.files.has(path)),
    makeDirectory: () => Effect.void,
    readFileString: (path) => {
      const contents = disk.files.get(path);
      return contents === undefined
        ? Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readFileString",
              description: "missing",
              pathOrDescriptor: path,
            }),
          )
        : Effect.succeed(contents);
    },
    writeFileString: (path, data) =>
      Effect.sync(() => {
        disk.writes.push(path);
        disk.files.set(path, data);
      }),
  });

  return legacyWorkjetImportLayer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ServerConfig.layer({
          stateDir: STATE_DIR,
          settingsPath: SETTINGS_PATH,
        } as unknown as ServerConfig.ServerConfig["Service"]),
        serverSettingsLayerTest(),
        fileSystem,
        Path.layer,
      ),
    ),
    Layer.provide(Layer.succeed(HostProcessPlatform, "darwin")),
    Layer.provide(Layer.succeed(HostProcessEnvironment, { HOME } as NodeJS.ProcessEnv)),
  );
};

const goldenText = encodeDocument(goldenSample);

interface HandlerOptions {
  readonly gatewayCatalog?: Effect.Effect<WorkjetGatewayCatalog, WorkjetGatewayOperationError>;
  readonly configuredEnvironmentIds?: readonly EnvironmentId[];
}

const withHandlers = <A, E, R>(
  disk: FakeDisk,
  use: (handlers: ReturnType<typeof makeLegacyWorkjetImportRpcHandlers>) => Effect.Effect<A, E, R>,
  options: HandlerOptions = {},
) =>
  Effect.gen(function* () {
    const importer = yield* LegacyWorkjetImport;
    return yield* use(
      makeLegacyWorkjetImportRpcHandlers({
        importer,
        gatewayCatalog: options.gatewayCatalog ?? Effect.succeed(catalog),
        environmentId: Effect.succeed(SELF_ENVIRONMENT),
        configuredEnvironmentIds: Effect.succeed(
          options.configuredEnvironmentIds ?? [CONFIGURED_ENVIRONMENT],
        ),
      }),
    );
  }).pipe(Effect.provide(makeImportLayer(disk)), Effect.scoped);

const bindings = (overrides: Partial<WorkjetLegacyImportBindings> = {}) => ({
  ...EMPTY_WORKJET_LEGACY_IMPORT_BINDINGS,
  ...overrides,
});

/** Every bindable record of the golden fixture answered: one bound, rest skipped. */
const FULL_ANSWER = bindings({
  computers: [{ computerId: LOCAL_COMPUTER, environmentId: SELF_ENVIRONMENT }],
  skippedComputerIds: [TAILNET_COMPUTER, SSH_COMPUTER],
  providers: [{ providerId: ZAI_PROVIDER, gatewayAccountId: ZAI_ACCOUNT }],
  skippedProviderIds: [KIMI_PROVIDER, XAI_PROVIDER],
  pools: [{ pool: OPENAI_POOL, gatewayAccountId: OPENAI_ACCOUNT, acknowledgeFailoverLoss: true }],
});

const requireOffer = (
  inspection: WorkjetLegacyImportInspection,
): Extract<WorkjetLegacyImportInspection, { state: "offer" }> => {
  assert.strictEqual(inspection.state, "offer");
  if (inspection.state !== "offer") throw new Error("expected an offer");
  return inspection;
};

describe("legacy Workjet import: inspect", () => {
  it("reports nothing to import when the machine never ran the Swift app", () => {
    const disk = makeDisk();
    return withHandlers(disk, (handlers) =>
      Effect.gen(function* () {
        const inspection = yield* handlers.inspect({});
        assert.strictEqual(inspection.state, "nothing-to-import");
        assert.deepEqual(disk.writes, []);
      }),
    );
  });

  it("offers the honest floor with every pending record and every drop", () => {
    const disk = makeDisk({ [LEGACY_PATH]: goldenText });
    return withHandlers(disk, (handlers) =>
      Effect.gen(function* () {
        const offer = requireOffer(yield* handlers.inspect({}));
        assert.strictEqual(offer.legacyPath, LEGACY_PATH);
        assert.strictEqual(offer.settingsPath, SETTINGS_PATH);

        // No bindings: nothing that needs an invented reference comes across.
        assert.strictEqual(offer.summary.computersImported, 0);
        assert.strictEqual(offer.summary.computersTotal, 3);
        assert.strictEqual(offer.summary.workersImported, 0);
        assert.strictEqual(offer.summary.workersTotal, 4);

        const kinds = offer.pending.map((record) => record.kind);
        assert.strictEqual(kinds.filter((kind) => kind === "computer-environment").length, 3);
        assert.strictEqual(kinds.filter((kind) => kind === "provider-account").length, 3);
        assert.strictEqual(kinds.filter((kind) => kind === "provider-pool-account").length, 1);
        assert.strictEqual(kinds.filter((kind) => kind === "worker").length, 4);
        assert.isFalse(offer.pendingTruncated);

        // A pool binding loses failover, and the contract says so at the record.
        const pool = offer.pending.find((record) => record.kind === "provider-pool-account");
        assert.isDefined(pool);
        if (pool?.kind === "provider-pool-account") {
          assert.strictEqual(pool.pool, OPENAI_POOL);
          assert.isTrue(pool.failoverLoss);
          assert.strictEqual(pool.workerIds.length, 2);
        }

        // Enough evidence to recognize a machine and an account, and nothing
        // that could authenticate anything.
        const computer = offer.pending.find(
          (record) => record.kind === "computer-environment" && record.computerId === SSH_COMPUTER,
        );
        if (computer?.kind === "computer-environment") {
          assert.strictEqual(computer.computerName, "build-box");
          assert.strictEqual(computer.transport, "SSH");
          assert.strictEqual(computer.host, "build-box.example.internal");
        }

        // Every drop is reported, so what will not come across is visible.
        assert.isAbove(offer.drops.length, 20);
        assert.isFalse(offer.dropsTruncated);
        assert.strictEqual(offer.summary.dropTotal, offer.drops.length);
        assert.isTrue(
          offer.drops.some((drop) => drop.source === "computers[].host"),
          "a transport detail is reported as dropped",
        );

        // The targets the server will accept a binding against.
        assert.deepEqual(
          offer.bindable.environments.map((environment) => environment.environmentId),
          [SELF_ENVIRONMENT, CONFIGURED_ENVIRONMENT],
        );
        assert.isTrue(offer.bindable.environments[0]?.isSelf);
        assert.isTrue(offer.bindable.environments[1]?.referencedByConfiguration);
        assert.isTrue(offer.bindable.gatewayCatalogAvailable);
        assert.deepEqual(
          offer.bindable.gatewayAccounts.map((account) => account.accountId),
          [ZAI_ACCOUNT, OPENAI_ACCOUNT],
        );

        // Reading the offer writes nothing at all.
        assert.deepEqual(disk.writes, []);
      }),
    );
  });

  it("says the gateway catalog is unavailable instead of showing no accounts", () => {
    const disk = makeDisk({ [LEGACY_PATH]: goldenText });
    return withHandlers(
      disk,
      (handlers) =>
        Effect.gen(function* () {
          const offer = requireOffer(yield* handlers.inspect({}));
          assert.isFalse(offer.bindable.gatewayCatalogAvailable);
          assert.deepEqual([...offer.bindable.gatewayAccounts], []);
        }),
      {
        gatewayCatalog: Effect.fail(
          new WorkjetGatewayOperationError({ reason: "gateway-not-ready" }),
        ),
      },
    );
  });

  it("reports a document that fails closed as unreadable, with the reader's reason", () => {
    const disk = makeDisk({ [LEGACY_PATH]: encodeDocument({ ...goldenSample, version: 2 }) });
    return withHandlers(disk, (handlers) =>
      Effect.gen(function* () {
        const inspection = yield* handlers.inspect({});
        assert.strictEqual(inspection.state, "unreadable");
        if (inspection.state !== "unreadable") return;
        assert.strictEqual(inspection.failure?.reason, "unsupported-version");
        // An unreadable document is a defect to look at, not a decision.
        assert.deepEqual(disk.writes, []);
      }),
    );
  });
});

describe("legacy Workjet import: server-side binding validation", () => {
  const refusal = (answer: WorkjetLegacyImportBindings) =>
    withHandlers(makeDisk({ [LEGACY_PATH]: goldenText }), (handlers) =>
      Effect.gen(function* () {
        const result = yield* Effect.result(
          handlers.decide({ action: "accept", bindings: answer }),
        );
        assert.strictEqual(result._tag, "Failure");
        if (result._tag !== "Failure") throw new Error("expected a refusal");
        return result.failure;
      }),
    );

  it("refuses an environment this server cannot verify", () =>
    Effect.gen(function* () {
      const failure = yield* refusal(
        bindings({
          ...FULL_ANSWER,
          computers: [{ computerId: LOCAL_COMPUTER, environmentId: UNKNOWN_ENVIRONMENT }],
        }),
      );
      assert.strictEqual(failure.reason, "unknown-environment");
      assert.strictEqual(failure.subject, UNKNOWN_ENVIRONMENT);
    }));

  it("accepts an environment the configuration already references", () => {
    const disk = makeDisk({ [LEGACY_PATH]: goldenText });
    return withHandlers(disk, (handlers) =>
      Effect.gen(function* () {
        const result = yield* handlers.decide({
          action: "accept",
          bindings: bindings({
            ...FULL_ANSWER,
            computers: [{ computerId: LOCAL_COMPUTER, environmentId: CONFIGURED_ENVIRONMENT }],
          }),
        });
        assert.strictEqual(result.outcome, "imported");
      }),
    );
  });

  it("refuses an account the gateway catalog does not hold", () =>
    Effect.gen(function* () {
      const failure = yield* refusal(
        bindings({
          ...FULL_ANSWER,
          providers: [
            {
              providerId: ZAI_PROVIDER,
              gatewayAccountId: WorkjetGatewayAccountId.make("account-that-does-not-exist"),
            },
          ],
        }),
      );
      assert.strictEqual(failure.reason, "unknown-gateway-account");
      assert.strictEqual(failure.subject, "account-that-does-not-exist");
    }));

  it("refuses an account binding it cannot verify because the gateway is down", () => {
    const disk = makeDisk({ [LEGACY_PATH]: goldenText });
    return withHandlers(
      disk,
      (handlers) =>
        Effect.gen(function* () {
          const result = yield* Effect.result(
            handlers.decide({ action: "accept", bindings: FULL_ANSWER }),
          );
          assert.strictEqual(result._tag, "Failure");
          if (result._tag !== "Failure") return;
          assert.strictEqual(result.failure.reason, "gateway-unavailable");
          // Fail closed: nothing was written.
          assert.deepEqual(disk.writes, []);
        }),
      {
        gatewayCatalog: Effect.fail(
          new WorkjetGatewayOperationError({ reason: "gateway-not-ready" }),
        ),
      },
    );
  });

  it("refuses a binding for a legacy record the offer does not contain", () =>
    Effect.gen(function* () {
      const failure = yield* refusal(
        bindings({
          ...FULL_ANSWER,
          computers: [
            { computerId: LOCAL_COMPUTER, environmentId: SELF_ENVIRONMENT },
            {
              computerId: "a-computer-that-is-not-in-the-document",
              environmentId: SELF_ENVIRONMENT,
            },
          ],
        }),
      );
      assert.strictEqual(failure.reason, "unknown-record");
      assert.strictEqual(failure.subject, "a-computer-that-is-not-in-the-document");
    }));

  it("refuses a record that is both bound and skipped", () =>
    Effect.gen(function* () {
      const failure = yield* refusal(
        bindings({
          ...FULL_ANSWER,
          skippedComputerIds: [LOCAL_COMPUTER, TAILNET_COMPUTER, SSH_COMPUTER],
        }),
      );
      assert.strictEqual(failure.reason, "conflicting-binding");
      assert.strictEqual(failure.subject, LOCAL_COMPUTER);
    }));

  it("refuses an accept that leaves a pending record unanswered", () =>
    Effect.gen(function* () {
      const failure = yield* refusal(
        bindings({ ...FULL_ANSWER, skippedComputerIds: [TAILNET_COMPUTER] }),
      );
      assert.strictEqual(failure.reason, "unresolved-pending");
      assert.strictEqual(failure.subject, SSH_COMPUTER);
    }));

  it("needs no gateway at all when every account record is skipped", () => {
    const disk = makeDisk({ [LEGACY_PATH]: goldenText });
    return withHandlers(
      disk,
      (handlers) =>
        Effect.gen(function* () {
          const result = yield* handlers.decide({
            action: "accept",
            bindings: bindings({
              computers: [{ computerId: LOCAL_COMPUTER, environmentId: SELF_ENVIRONMENT }],
              skippedComputerIds: [TAILNET_COMPUTER, SSH_COMPUTER],
              skippedProviderIds: [KIMI_PROVIDER, ZAI_PROVIDER, XAI_PROVIDER],
              skippedPools: [OPENAI_POOL],
            }),
          });
          assert.strictEqual(result.outcome, "imported");
          if (result.outcome !== "imported") return;
          // A skipped provider imports no route, and every worker that needed
          // one stays out with it.
          assert.strictEqual(result.importedComputers, 1);
          assert.strictEqual(result.importedLlmRoutes, 0);
          assert.strictEqual(result.importedWorkerProfiles, 0);
        }),
      {
        gatewayCatalog: Effect.fail(
          new WorkjetGatewayOperationError({ reason: "gateway-not-ready" }),
        ),
      },
    );
  });
});

describe("legacy Workjet import: decide", () => {
  it("applies exactly one settings patch, writes one marker, and never runs twice", () => {
    const disk = makeDisk({ [LEGACY_PATH]: goldenText });
    return withHandlers(disk, (handlers) =>
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        const result = yield* handlers.decide({ action: "accept", bindings: FULL_ANSWER });

        assert.strictEqual(result.outcome, "imported");
        if (result.outcome !== "imported") return;
        assert.strictEqual(result.importedComputers, 1);
        // The bound provider plus the synthetic single-account route that stands
        // in for the bound pool.
        assert.strictEqual(result.importedLlmRoutes, 2);
        assert.strictEqual(result.importedWorkerProfiles, 3);
        // The records that stayed pending under these bindings are reported.
        assert.isAbove(result.pending.length, 0);

        const stored = yield* settings.getSettings;
        assert.strictEqual(stored.workjet.computers.length, 1);
        assert.strictEqual(stored.workjet.computers[0]?.environmentId, SELF_ENVIRONMENT);
        assert.isTrue(
          stored.workjet.llmRoutes.some((route) => route.id === `pool:${OPENAI_POOL}`),
          "the bound pool becomes one synthetic route",
        );

        // One marker, one settings write, and the legacy document untouched.
        assert.strictEqual(disk.writes.filter((path) => path === MARKER_PATH).length, 1);
        assert.notInclude(disk.writes, LEGACY_PATH);

        // Idempotent: a second decide changes nothing.
        const second = yield* handlers.decide({ action: "accept", bindings: FULL_ANSWER });
        assert.strictEqual(second.outcome, "already-decided");
        if (second.outcome !== "already-decided") return;
        assert.strictEqual(second.previousOutcome, "imported");
        assert.strictEqual(disk.writes.filter((path) => path === MARKER_PATH).length, 1);

        // And the offer is gone for good.
        const inspection = yield* handlers.inspect({});
        assert.strictEqual(inspection.state, "already-decided");
        if (inspection.state !== "already-decided") return;
        assert.strictEqual(inspection.outcome, "imported");
        assert.strictEqual(inspection.importedComputers, 1);
        assert.isNotNull(inspection.decidedAt);
      }),
    );
  });

  it("records a decline as terminal, with the date the panel shows", () => {
    const disk = makeDisk({ [LEGACY_PATH]: goldenText });
    return withHandlers(disk, (handlers) =>
      Effect.gen(function* () {
        const settings = yield* ServerSettingsService;
        assert.strictEqual((yield* handlers.decide({ action: "decline" })).outcome, "declined");

        // A decline is a refusal, not an edit.
        assert.deepEqual((yield* settings.getSettings).workjet.workerProfiles, []);
        assert.strictEqual(disk.writes.filter((path) => path === MARKER_PATH).length, 1);

        const second = yield* handlers.decide({ action: "decline" });
        assert.strictEqual(second.outcome, "already-decided");
        if (second.outcome !== "already-decided") return;
        assert.strictEqual(second.previousOutcome, "declined");

        // Accepting after a decline stays declined.
        const accept = yield* handlers.decide({ action: "accept", bindings: FULL_ANSWER });
        assert.strictEqual(accept.outcome, "already-decided");
        assert.strictEqual(disk.writes.filter((path) => path === MARKER_PATH).length, 1);

        const inspection = yield* handlers.inspect({});
        assert.strictEqual(inspection.state, "already-decided");
        if (inspection.state !== "already-decided") return;
        assert.strictEqual(inspection.outcome, "declined");
        assert.strictEqual(inspection.legacyPath, LEGACY_PATH);
        assert.isNotNull(inspection.decidedAt);
      }),
    );
  });

  it("has nothing to decide when there is nothing to import", () => {
    const disk = makeDisk();
    return withHandlers(disk, (handlers) =>
      Effect.gen(function* () {
        assert.strictEqual(
          (yield* handlers.decide({ action: "decline" })).outcome,
          "nothing-to-import",
        );
        assert.deepEqual(disk.writes, []);
      }),
    );
  });

  it("refuses to import an unreadable document and records no decision", () => {
    const disk = makeDisk({ [LEGACY_PATH]: encodeDocument({ ...goldenSample, version: 2 }) });
    return withHandlers(disk, (handlers) =>
      Effect.gen(function* () {
        const result = yield* handlers.decide({
          action: "accept",
          bindings: EMPTY_WORKJET_LEGACY_IMPORT_BINDINGS,
        });
        assert.strictEqual(result.outcome, "unreadable");
        if (result.outcome !== "unreadable") return;
        assert.strictEqual(result.failure.reason, "unsupported-version");
        assert.deepEqual(disk.writes, []);
        assert.isFalse(disk.files.has(MARKER_PATH));
      }),
    );
  });
});
