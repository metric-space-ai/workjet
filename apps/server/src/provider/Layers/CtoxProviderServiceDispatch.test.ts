/**
 * THE NATIVE CTOX PATH, DRIVEN THROUGH THE PRODUCTIVE PROVIDER SERVICE.
 *
 * Every other CTOX test here hands the adapter a stubbed `resolveTaskScope`
 * (`CtoxAdapter.test.ts` returns `{module_id: "inventory"}` outright). That is
 * the right shape for testing the adapter, and it is exactly why none of them
 * can catch what this file is for: the scope resolution chain — thread binding,
 * capability activation, cross-mode link, connection pin — is the part that was
 * broken, and a stub replaces all of it.
 *
 * WHAT IS REAL, AND WHAT IS NOT.
 *
 * An earlier revision of this file drove `CtoxDriver.create` directly and
 * claimed "the ONLY double is the HTTP peer". Both were wrong, and an
 * independent review said so. This revision goes through the real stack, and
 * the list below is what a reader can rely on:
 *
 *   ProviderService                real, `makeProviderServiceLive()`
 *   ProviderInstanceRegistry       real, assembled from the real `CtoxDriver`
 *   ProviderAdapterRegistry        real, the live facade over that registry
 *   ProviderSessionDirectory       real, over real SQLite — no cast, no double
 *   DecisionHubConnectionRegistry  real, provisioned, secret-backed
 *   CtoxNativeRequests             real, against real migrations
 *   CtoxThreadBindingSource        real, reading the real session directory
 *   WorkjetCrossModeLinkStore      real SQL rows
 *   CtoxMcpTransport               real JSON-RPC over a real HttpClient
 *
 *   ServerEnvironment              real `layer`, over a per-test tmp fixture
 *   DecisionHubMcpClient           real `layer`, over the same fake peer
 *
 * ONE double remains, and one isolated fixture:
 *
 *   the HTTP peer      a test may not require a running CTOX daemon
 *   ServerSecretStore  an isolated in-memory map, so `provision` stores what it
 *                      really stores — a bare-token stub makes `readTarget`
 *                      fail before any test reaches its subject
 *
 * Two earlier revisions of this comment were wrong about that list, the second
 * time after the correction had already been given: it claimed
 * `DecisionHubMcpClient` had no HttpClient-backed layer. It does —
 * `DecisionHubMcpClient.ts:137` exports one and its `make` builds the same MCP
 * transport at :87 — so the hub's own probe now runs for real over this peer,
 * which also means `provision` genuinely probes rather than being waved
 * through. A double that is not needed is not a shortcut, it is a hole in the
 * proof.
 *
 * The peer answers real MCP: it decodes the JSON-RPC envelope the production
 * transport actually sends — with a schema, so a malformed request is refused
 * rather than read as `undefined` — and answers `initialize`, `tools/list` and
 * `tools/call` the way that transport actually decodes them. Its log separates
 * DISCOVERY from mutation, because "the daemon was contacted" and "the daemon
 * was told to act" are different facts and a refusal must sit between them.
 */
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  normalizeWorkjetThreadConfig,
  ProviderInstanceId,
  ThreadId,
  WorkjetBusinessOsObjectId,
  WorkjetBusinessOsObjectKind,
  WorkjetConnectionId,
  WorkjetCrossModeLinkId,
  type CtoxAppModuleId,
  type CtoxManagedInstanceId,
  type ProviderInstanceConfigMap,
  type WorkjetCrossModeLink,
  type WorkjetDecisionHubProvisionInput,
  type WorkjetThreadConfig,
} from "@workjet/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { CTOX_MCP_SERVER_NAME } from "../../workjet/ctox/CtoxMcpTransport.ts";
import { CtoxNativeRequests } from "../../workjet/ctox/CtoxNativeRequests.ts";
import { CtoxThreadBindingSourceLive } from "../../workjet/ctox/CtoxThreadBinding.ts";
import {
  WorkjetCrossModeLinkStore,
  WorkjetCrossModeLinkStoreLive,
} from "../../workjet/crossmode/WorkjetCrossModeLinkStore.ts";
import * as DecisionHubMcpClient from "../../workjet/decisionHub/DecisionHubMcpClient.ts";
import {
  DecisionHubConnectionRegistry,
  layer as decisionHubLayer,
} from "../../workjet/decisionHub/DecisionHubConnectionRegistry.ts";
import type { ProviderServiceError } from "../Errors.ts";
import { CTOX_DRIVER_KIND, CtoxDriver } from "../Drivers/CtoxDriver.ts";
import { CTOX_NATIVE_MODEL } from "./CtoxAdapter.ts";
import { ProviderAdapterRegistryLive } from "./ProviderAdapterRegistry.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderInstanceRegistryMutableLayer } from "./ProviderInstanceRegistryLive.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as ProviderServiceTag from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";

const CTOX_INSTANCE: CtoxManagedInstanceId = "paired:manual_pairing:office-1";
const MODULE = "crm" as CtoxAppModuleId;

const THREAD = ThreadId.make("native-first-start");
/** A thread with a valid binding but no Business OS object of its own. */
const FOREIGN_THREAD = ThreadId.make("native-foreign-thread");

/** Two connections, ONE CTOX instance. That pairing is the whole point. */
const CONNECTION_A = WorkjetConnectionId.make("ctox-connection-a");
const CONNECTION_B = WorkjetConnectionId.make("ctox-connection-b");

const instanceIdFor = (connectionId: WorkjetConnectionId) =>
  ProviderInstanceId.make(`ctox_${connectionId}`);

/**
 * One provider row, pinned to connection A. The registry decodes this exactly
 * as it decodes a configured instance in production.
 */
const configMap: ProviderInstanceConfigMap = {
  [instanceIdFor(CONNECTION_A)]: {
    driver: CTOX_DRIVER_KIND,
    config: { ctoxInstanceId: CTOX_INSTANCE, connectionId: CONNECTION_A },
  },
};

const provision = (connectionId: WorkjetConnectionId): WorkjetDecisionHubProvisionInput => ({
  connectionId,
  instanceId: CTOX_INSTANCE,
  displayName: `Office via ${connectionId}`,
  source: "ctox_dev",
  // The SAME endpoint for both connections, and a different token for each.
  // That is what two credentials to one CTOX instance look like, and it is why
  // the instance id cannot tell them apart: the route is identical.
  // `requireCtoxManagedInstanceRoute` also refuses anything that is not exactly
  // this instance's route, so a per-connection path is rejected on provision.
  endpoint: `https://mcp.ctox.dev/mcp/${CTOX_INSTANCE}`,
  token: `token-${connectionId}`,
});

/**
 * The thread's Workjet config as the composer would write it: the capability
 * enabled AND bound to one connection. Both halves are load bearing —
 * `resolveThreadCapabilityContext` yields no binding when the capability is
 * bound but not enabled, and none when it is enabled but unbound.
 */
const threadConfigFor = (connectionId: WorkjetConnectionId): WorkjetThreadConfig => ({
  ...normalizeWorkjetThreadConfig(DEFAULT_WORKJET_THREAD_CONFIG),
  enabledCapabilityIds: ["ctox-business-os"],
  capabilityBindings: [
    {
      capabilityId: "ctox-business-os",
      target: { kind: "ctox-connection", connectionId, instanceId: CTOX_INSTANCE },
    },
  ],
});

/**
 * The link's environment id has to be the one this server actually resolves,
 * not a constant that merely looks plausible: `resolveCtoxThreadScope` refuses
 * a link created under another Workjet authority with `link-environment-mismatch`.
 * A hard-coded id would either accidentally match — proving nothing — or fail
 * for a reason unrelated to the case under test.
 */
const linkFor = (environmentId: EnvironmentId, threadId: ThreadId): WorkjetCrossModeLink => ({
  schemaVersion: 1,
  linkId: WorkjetCrossModeLinkId.make("wjx-0000000000-first"),
  ctox: {
    schemaVersion: 1,
    instanceId: CTOX_INSTANCE,
    moduleId: MODULE,
    objectKind: WorkjetBusinessOsObjectKind.make("deal"),
    objectId: WorkjetBusinessOsObjectId.make("deal-42"),
  },
  code: { schemaVersion: 1, environmentId, threadId },
  presentation: { schemaVersion: 1, title: "Deal — ACME Q3 renewal" },
  createdAt: "2026-09-09T10:00:00.000Z",
});

/**
 * The envelope the production transport actually sends. Decoding it with a
 * schema rather than `JSON.parse` means the peer REJECTS a malformed request
 * instead of quietly reading `undefined` out of it, so a transport that stopped
 * sending a method or an id fails this test rather than slipping through as a
 * missing tool call.
 */
const McpRequestEnvelope = Schema.Struct({
  id: Schema.Number,
  method: Schema.String,
  params: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
});
const decodeMcpRequest = Schema.decodeUnknownSync(Schema.fromJsonString(McpRequestEnvelope));

/** Discovery and mutation are counted apart; a refusal has to sit between them. */
interface PeerLog {
  readonly discovery: Ref.Ref<ReadonlyArray<string>>;
  readonly toolCalls: Ref.Ref<ReadonlyArray<string>>;
}

const fakePeer = (log: PeerLog) =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      const raw =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
      const envelope = decodeMcpRequest(raw);

      const reply = (result: unknown) =>
        HttpClientResponse.fromWeb(
          request,
          Response.json({ jsonrpc: "2.0", id: envelope.id, result }),
        );

      if (envelope.method === "initialize" || envelope.method === "tools/list") {
        yield* Ref.update(log.discovery, (seen) => [...seen, envelope.method]);
        if (envelope.method === "initialize") {
          return reply({ serverInfo: { name: CTOX_MCP_SERVER_NAME } });
        }
        // `idempotency_key` must be advertised as a string, or the production
        // probe refuses with `remote-tools-missing`: the retry contract is only
        // meaningful when the daemon says it honours it.
        return reply({
          tools: [
            {
              name: "business_os.execute_action",
              inputSchema: {
                properties: {
                  idempotency_key: { type: "string" },
                  module_id: { type: "string" },
                },
              },
            },
            { name: "business_os.get_command_status", inputSchema: { properties: {} } },
          ],
        });
      }

      const name = envelope.params?.name ?? "";
      yield* Ref.update(log.toolCalls, (seen) => [...seen, name]);
      if (name === "business_os.execute_action") {
        return reply({
          structuredContent: {
            module_id: String(envelope.params?.arguments?.["module_id"] ?? ""),
            command_type: "ctox.delegate_task",
            command_id: "cmd-1",
            task_id: "task-1",
          },
        });
      }
      return reply({
        structuredContent: {
          ok: true,
          record: {
            id: "cmd-1",
            collection: "business_commands",
            status: "running",
            data: { command_id: "cmd-1", task_id: "task-1", module: MODULE, status: "running" },
          },
        },
      });
    }),
  );

/** A real store; `readTarget` decodes a serialized target, not a bare token. */
const secretLayer = Layer.effect(
  ServerSecretStore,
  Effect.sync(() => {
    const secrets = new Map<string, Uint8Array>();
    return ServerSecretStore.of({
      get: (name) =>
        Effect.sync(() => {
          const value = secrets.get(name);
          return value === undefined ? Option.none() : Option.some(value.slice());
        }),
      set: (name, value) =>
        Effect.sync(() => {
          secrets.set(name, value.slice());
        }),
      remove: (name) =>
        Effect.sync(() => {
          secrets.delete(name);
        }),
      create: () => Effect.die("unused"),
      getOrCreateRandom: () => Effect.die("unused"),
    });
  }),
);

/**
 * The productive stack, built once per test: its own peer log, its own SQLite,
 * and its own temp directory so nothing leaks between tests or into the repo.
 *
 * `provideMerge` rather than sibling merges throughout. Merged siblings do not
 * see each other, and that mistake already cost a debugging round here: the
 * binding source resolved the connection registry to None, saw zero
 * connections, and refused every start with `no-thread-binding` — the exact
 * symptom of the product defect, produced by the harness instead.
 */
const makeStack = (log: PeerLog, baseDir: string) => {
  const peer = Layer.succeed(HttpClient.HttpClient, fakePeer(log));
  const persistence = SqlitePersistenceMemory;
  const config = ServerConfig.layerTest(process.cwd(), baseDir);

  // The real environment layer. `ProcessRunner.layer` behind it needs a
  // ChildProcessSpawner, which `NodeServices.layer` supplies at the outer
  // closure — the same shape `ServerEnvironment.test.ts` uses.
  const environment = ServerEnvironment.layer.pipe(
    Layer.provide(secretLayer),
    Layer.provide(config),
  );

  // The hub's REAL MCP client over the same peer. Because
  // `DecisionHubConnectionRegistry` probes on provision, this means every
  // `provision` in these tests genuinely completes a probe rather than being
  // waved through by a stub that answers `void`.
  const mcpClient = DecisionHubMcpClient.layer.pipe(Layer.provide(peer));
  const decisionHub = decisionHubLayer.pipe(
    Layer.provide(secretLayer),
    Layer.provideMerge(mcpClient),
  );

  const runtimeRepository = ProviderSessionRuntime.layer.pipe(Layer.provide(persistence));
  const directory = ProviderSessionDirectoryLive.pipe(Layer.provideMerge(runtimeRepository));

  const ctoxServices = Layer.mergeAll(
    CtoxNativeRequests.layer,
    WorkjetCrossModeLinkStoreLive,
    CtoxThreadBindingSourceLive,
  ).pipe(Layer.provideMerge(decisionHub), Layer.provideMerge(environment));

  // The CTOX services are given to the REGISTRY explicitly, not merely provided
  // further out. `CtoxDriver.create` resolves them with `Effect.serviceOption`,
  // so they are absent from the type-level requirement channel: if the building
  // context lacks them, the compiler stays silent and the driver reports itself
  // unavailable at runtime. Relying on outward propagation is exactly the
  // assumption that already produced a false `no-thread-binding` here. The same
  // layer value is memoized within one build, so providing it here AND exposing
  // it below still yields ONE registry and ONE secret map.
  const instanceRegistry = ProviderInstanceRegistryMutableLayer({
    drivers: [CtoxDriver],
    configMap,
  }).pipe(
    Layer.provide(peer),
    Layer.provide(ctoxServices),
    Layer.provide(directory),
    Layer.provide(persistence),
  );

  const adapterRegistry = ProviderAdapterRegistryLive.pipe(Layer.provideMerge(instanceRegistry));

  return makeProviderServiceLive()
    .pipe(
      Layer.provide(adapterRegistry),
      Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
      Layer.provide(config),
      Layer.provideMerge(AnalyticsService.layerTest),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
    )
    .pipe(
      Layer.provideMerge(ctoxServices),
      Layer.provideMerge(directory),
      Layer.provideMerge(environment),
      Layer.provideMerge(persistence),
      Layer.provideMerge(NodeServices.layer),
    );
};

/**
 * One temp directory per test, removed afterwards. `ServerConfig.layerTest`
 * writes real files — the environment id among them — so pointing it at the
 * repository would let one test read another's identity and would dirty the
 * working tree.
 */
const scopedBaseDir = Effect.acquireRelease(
  Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "ctox-dispatch-"))),
  (dir) => Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
);

const makeLog = Effect.gen(function* () {
  return {
    discovery: yield* Ref.make<ReadonlyArray<string>>([]),
    toolCalls: yield* Ref.make<ReadonlyArray<string>>([]),
  } satisfies PeerLog;
});

/**
 * `pinned` is the provider instance the session runs on; `bound` is the
 * connection the THREAD is bound to. They are the same in normal use and differ
 * in exactly the case this file refuses, so they are separate arguments rather
 * than one id used twice.
 */
const startInput = (
  threadId: ThreadId,
  pinned: WorkjetConnectionId,
  bound: WorkjetConnectionId = pinned,
) => ({
  threadId,
  providerInstanceId: instanceIdFor(pinned),
  runtimeMode: "approval-required" as const,
  modelSelection: { instanceId: instanceIdFor(pinned), model: CTOX_NATIVE_MODEL },
  workjetConfig: threadConfigFor(bound),
});

/**
 * A refusal is only evidence when its REASON is checked. `Effect.flip` alone
 * swallows every failure, so a missing service or a broken fixture would make
 * both negative cases pass while proving nothing — which is precisely what a
 * review caught in the previous revision.
 */
const refusalDetail = (failure: ProviderServiceError): string => {
  // A tag equality assertion does not narrow the union for the compiler, so the
  // check has to be the control flow itself. No cast: `ProviderAdapterRequestError`
  // is a member of `ProviderServiceError`, and reading `provider`/`detail` off
  // anything else would be reading fields that may not exist.
  if (failure._tag !== "ProviderAdapterRequestError") {
    return assert.fail(`expected a CTOX request refusal, got ${failure._tag}`);
  }
  assert.strictEqual(failure.provider, CTOX_DRIVER_KIND);
  return failure.detail;
};

it.effect("starts a first native turn through the provider service and then persists it", () =>
  Effect.gen(function* () {
    const log = yield* makeLog;
    const baseDir = yield* scopedBaseDir;
    yield* Effect.gen(function* () {
      yield* (yield* DecisionHubConnectionRegistry).provision(provision(CONNECTION_A));
      const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
      yield* (yield* WorkjetCrossModeLinkStore).createOrSelect(linkFor(environmentId, THREAD));

      const service = yield* ProviderServiceTag.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;

      // Before: the directory is genuinely empty. Resolving the scope through
      // the persisted row would refuse here with `no-thread-binding`, because
      // that row is written only AFTER the start returns — an ordering that
      // made every first start impossible and looked like a misconfigured
      // thread rather than a bug.
      assert.isTrue(Option.isNone(yield* directory.getBinding(THREAD)));

      yield* service.startSession(THREAD, startInput(THREAD, CONNECTION_A));

      // After: a real bound session, on the expected instance and thread. Any
      // row would satisfy `isSome`; the identity is the actual claim.
      const bound = yield* directory.getBinding(THREAD);
      assert.isTrue(Option.isSome(bound));
      const binding = Option.getOrThrow(bound);
      assert.strictEqual(binding.threadId, THREAD);
      assert.strictEqual(binding.providerInstanceId, instanceIdFor(CONNECTION_A));

      yield* service.sendTurn({
        threadId: THREAD,
        requestId: "command:turn-1",
        input: "Review the renewal",
      });

      // Discovery alone would only prove the daemon was reachable. Only
      // `execute_action` proves it was told to act.
      assert.include(yield* Ref.get(log.toolCalls), "business_os.execute_action");
    }).pipe(Effect.provide(makeStack(log, baseDir)));
  }).pipe(Effect.scoped),
);

it.effect("refuses a thread bound to another connection of the SAME CTOX instance", () =>
  Effect.gen(function* () {
    const log = yield* makeLog;
    const baseDir = yield* scopedBaseDir;
    yield* Effect.gen(function* () {
      const connections = yield* DecisionHubConnectionRegistry;
      // Both connections are real, both probe successfully, and both name the
      // same CTOX instance. Nothing about the instance tells them apart; only
      // the pin does.
      yield* connections.provision(provision(CONNECTION_A));
      yield* connections.provision(provision(CONNECTION_B));
      const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
      yield* (yield* WorkjetCrossModeLinkStore).createOrSelect(linkFor(environmentId, THREAD));

      const service = yield* ProviderServiceTag.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      // The session runs on the instance pinned to A; the thread is bound to B.
      const detail = refusalDetail(
        yield* Effect.flip(
          service.startSession(THREAD, startInput(THREAD, CONNECTION_A, CONNECTION_B)),
        ),
      );
      // Naming both connections is the point: "same instance" is exactly the
      // reason a reader would otherwise assume this was allowed.
      assert.include(detail, CONNECTION_B);
      assert.include(detail, CONNECTION_A);

      // The refusal happened BEFORE any mutation, and left nothing behind. A
      // refusal afterwards would leave real work running under the wrong
      // credential, which is the whole reason the connection is part of the pin.
      assert.notInclude(yield* Ref.get(log.toolCalls), "business_os.execute_action");
      assert.isTrue(Option.isNone(yield* directory.getBinding(THREAD)));
    }).pipe(Effect.provide(makeStack(log, baseDir)));
  }).pipe(Effect.scoped),
);

it.effect("refuses a thread that implements no Business OS object of its own", () =>
  Effect.gen(function* () {
    const log = yield* makeLog;
    const baseDir = yield* scopedBaseDir;
    yield* Effect.gen(function* () {
      yield* (yield* DecisionHubConnectionRegistry).provision(provision(CONNECTION_A));
      const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
      // The link belongs to THREAD. FOREIGN_THREAD carries a perfectly valid
      // connection binding and nothing else — the ordinary state of most
      // threads, and exactly why "has a binding" cannot be authorization.
      yield* (yield* WorkjetCrossModeLinkStore).createOrSelect(linkFor(environmentId, THREAD));

      const service = yield* ProviderServiceTag.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const detail = refusalDetail(
        yield* Effect.flip(
          service.startSession(FOREIGN_THREAD, startInput(FOREIGN_THREAD, CONNECTION_A)),
        ),
      );
      // The named reason matters: "no link" and "wrong connection" are
      // different refusals, and only one of them is this test's subject.
      assert.include(detail, "no-business-os-link");

      assert.notInclude(yield* Ref.get(log.toolCalls), "business_os.execute_action");
      assert.isTrue(Option.isNone(yield* directory.getBinding(FOREIGN_THREAD)));
    }).pipe(Effect.provide(makeStack(log, baseDir)));
  }).pipe(Effect.scoped),
);
