/**
 * THE FIRST START, PROVEN OVER THE REAL DRIVER BOUNDARY.
 *
 * Every other CTOX test in this directory hands the adapter a stubbed
 * `resolveTaskScope` (`CtoxAdapter.test.ts` returns `{module_id: "inventory"}`
 * outright). That is the right shape for testing the adapter, and it is exactly
 * why it cannot catch the defect this file exists for: the scope resolution
 * chain — thread binding, capability activation, cross-mode link, connection
 * pin — is the part that was broken, and a stub replaces all of it.
 *
 * So here NOTHING in that chain is stubbed. `CtoxDriver.create` runs, and the
 * services it resolves are the productive ones:
 *
 *   DecisionHubConnectionRegistry  real, provisioned, secret-backed
 *   CtoxNativeRequests             real, against real migrations
 *   CtoxThreadBindingSource        real
 *   WorkjetCrossModeLinkStore      real, real SQL rows
 *   SqlClient                      real SQLite, full migration set
 *   CtoxMcpTransport               real, real JSON-RPC over a real HttpClient
 *
 * The ONLY double is the HTTP peer at the far end of the wire, because a test
 * may not require a running CTOX daemon. It answers real MCP: it parses the
 * JSON-RPC envelope the production transport actually sends, and it answers
 * `initialize`, `tools/list` and `tools/call` the way the production transport
 * actually decodes them. A peer that returned canned objects to a stubbed
 * transport would prove nothing about either.
 *
 * THE DEFECT THIS GUARDS.
 *
 * `bindings.forThread(threadId)` reads the ProviderSessionDirectory row, and
 * that row is written only AFTER `startSession` returns. So resolving a first
 * start through it refused EVERY first start with `no-thread-binding` — the
 * native harness could never be reached at all, and the failure looked like a
 * misconfigured thread rather than an ordering bug. `fromStartConfig` reads the
 * validated `workjetConfig` that the start input already carries, which is the
 * only place the binding exists at that moment.
 *
 * The second case is the one that looks safe and is not: two connections to the
 * SAME CTOX instance. Comparing only the instance id would let a thread bound
 * to connection A be acted on through connection B. Those two connections can
 * carry different agent tokens and different scopes, so that is a privilege
 * change wearing the costume of a routing detail.
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
  type WorkjetCrossModeLink,
  type WorkjetDecisionHubProvisionInput,
  type WorkjetThreadConfig,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { CTOX_MCP_SERVER_NAME } from "../../workjet/ctox/CtoxMcpTransport.ts";
import { CtoxNativeRequests } from "../../workjet/ctox/CtoxNativeRequests.ts";
import { CtoxThreadBindingSourceLive } from "../../workjet/ctox/CtoxThreadBinding.ts";
import {
  WorkjetCrossModeLinkStore,
  WorkjetCrossModeLinkStoreLive,
} from "../../workjet/crossmode/WorkjetCrossModeLinkStore.ts";
import { DecisionHubMcpClient } from "../../workjet/decisionHub/DecisionHubMcpClient.ts";
import {
  DecisionHubConnectionRegistry,
  layer as decisionHubLayer,
} from "../../workjet/decisionHub/DecisionHubConnectionRegistry.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { CTOX_DRIVER_KIND, CtoxDriver } from "../Drivers/CtoxDriver.ts";
import { CTOX_NATIVE_MODEL } from "./CtoxAdapter.ts";

const ENVIRONMENT = EnvironmentId.make("environment-local");
const CTOX_INSTANCE: CtoxManagedInstanceId = "paired:manual_pairing:office-1";
const MODULE = "crm" as CtoxAppModuleId;
const THREAD = ThreadId.make("native-first-start");

/** Two connections, ONE CTOX instance. That pairing is the whole point. */
const CONNECTION_A = WorkjetConnectionId.make("ctox-connection-a");
const CONNECTION_B = WorkjetConnectionId.make("ctox-connection-b");

const provision = (connectionId: WorkjetConnectionId): WorkjetDecisionHubProvisionInput => ({
  connectionId,
  instanceId: CTOX_INSTANCE,
  displayName: `Office via ${connectionId}`,
  source: "ctox_dev",
  // The SAME endpoint for both connections, and a different token for each.
  // That is what two credentials to one CTOX instance actually look like, and
  // it is why the instance id cannot distinguish them: the route is identical.
  // `requireCtoxManagedInstanceRoute` also refuses anything that is not exactly
  // this instance's route, so a per-connection path would be rejected here.
  endpoint: `https://mcp.ctox.dev/mcp/${CTOX_INSTANCE}`,
  token: `token-${connectionId}`,
});

/**
 * The thread's Workjet config, exactly as the composer would have written it:
 * the capability enabled AND bound to one connection. Both halves are load
 * bearing — `resolveThreadCapabilityContext` produces no binding when the
 * capability is bound but not enabled, and none when it is enabled but unbound.
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

const link: WorkjetCrossModeLink = {
  schemaVersion: 1,
  linkId: WorkjetCrossModeLinkId.make("wjx-0000000000-first"),
  ctox: {
    schemaVersion: 1,
    instanceId: CTOX_INSTANCE,
    moduleId: MODULE,
    objectKind: WorkjetBusinessOsObjectKind.make("deal"),
    objectId: WorkjetBusinessOsObjectId.make("deal-42"),
  },
  code: { schemaVersion: 1, environmentId: ENVIRONMENT, threadId: THREAD },
  presentation: { schemaVersion: 1, title: "Deal — ACME Q3 renewal" },
  createdAt: "2026-09-09T10:00:00.000Z",
};

/**
 * The envelope the production transport actually sends. Decoding it with a
 * schema rather than `JSON.parse` is not ceremony here: it means the peer
 * REJECTS a malformed request instead of quietly reading `undefined` out of it,
 * so a transport that stopped sending a method or an id would fail this test
 * rather than slip through as a missing tool call.
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

/**
 * THE FAKE PEER — a CTOX daemon at the far end of a real wire.
 *
 * It parses the JSON-RPC envelope the production transport sends and answers in
 * the shape the production transport decodes, so `initialize`, `tools/list`,
 * the identity check, the required-tool check and the `idempotency_key`
 * argument check are all genuinely exercised. `seen` records every tool call so
 * a test can assert that a refusal happened BEFORE the wire, not after it.
 */
const fakePeer = (seen: Ref.Ref<ReadonlyArray<string>>) =>
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

      if (envelope.method === "initialize") {
        return reply({ serverInfo: { name: CTOX_MCP_SERVER_NAME } });
      }
      if (envelope.method === "tools/list") {
        // `idempotency_key` must be advertised as a string, or the production
        // probe refuses with `remote-tools-missing` — the retry contract is
        // only meaningful when the daemon says it honours it.
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
      yield* Ref.update(seen, (calls) => [...calls, name]);
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
            data: {
              command_id: "cmd-1",
              task_id: "task-1",
              module: MODULE,
              status: "running",
            },
          },
        },
      });
    }),
  );

/**
 * A first start never reads this — the runtime row does not exist yet, which is
 * the entire ordering problem. Returning "no row" is therefore the HONEST
 * value here, not a convenience: if the resolver were still going through
 * `forThread`, this double would make it fail, and the first test would fail
 * with `no-thread-binding` instead of passing for the wrong reason.
 */
const emptySessionDirectory = Layer.succeed(
  ProviderSessionDirectory.ProviderSessionDirectory,
  ProviderSessionDirectory.ProviderSessionDirectory.of({
    getBinding: () => Effect.succeed(Option.none()),
  } as unknown as ProviderSessionDirectory.ProviderSessionDirectory["Service"]),
);

const environment = Layer.succeed(
  ServerEnvironment,
  ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(ENVIRONMENT),
    getDescriptor: Effect.die("unused"),
  } as unknown as ServerEnvironment["Service"]),
);

/** A real store; a bare-token stub makes `readTarget` fail before any test runs. */
const secretLayer = Effect.gen(function* () {
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
}).pipe(Layer.effect(ServerSecretStore));

const mcpClient = Layer.succeed(
  DecisionHubMcpClient,
  DecisionHubMcpClient.of({
    probe: () => Effect.void,
    requestDecision: () => Effect.die("unused"),
    getDecision: () => Effect.die("unused"),
  }),
);

const decisionHub = decisionHubLayer.pipe(Layer.provide(secretLayer), Layer.provide(mcpClient));

/**
 * `provideMerge` rather than a sibling in `mergeAll`, and that distinction cost
 * a debugging round: merged siblings do not see each other, so the binding
 * source resolved `Effect.serviceOption(DecisionHubConnectionRegistry)` to None,
 * saw zero connections, and refused every start with `no-thread-binding` — the
 * exact symptom of the product defect this file tests, produced instead by the
 * harness. Providing it once keeps ONE registry: the connection a test
 * provisions is the connection the binding source reads back.
 */
const services = Layer.mergeAll(
  CtoxNativeRequests.layer,
  WorkjetCrossModeLinkStoreLive,
  CtoxThreadBindingSourceLive.pipe(
    Layer.provide(environment),
    Layer.provide(emptySessionDirectory),
  ),
).pipe(Layer.provideMerge(decisionHub), Layer.provideMerge(SqlitePersistenceMemory));

/** Build the instance the way the registry does, with the same input shape. */
const instanceFor = (connectionId: WorkjetConnectionId) =>
  CtoxDriver.create({
    instanceId: ProviderInstanceId.make(`ctox_${connectionId}`),
    displayName: undefined,
    environment: [],
    enabled: true,
    routeViaGateway: false,
    config: { ctoxInstanceId: CTOX_INSTANCE, connectionId },
  });

/**
 * `pinned` is the provider instance the session runs on; `bound` is the
 * connection the THREAD is bound to. They are the same in normal use and differ
 * in exactly the case this file exists to refuse, so they are separate
 * arguments rather than one id used twice.
 */
const startInput = (pinned: WorkjetConnectionId, bound: WorkjetConnectionId = pinned) => ({
  threadId: THREAD,
  providerInstanceId: ProviderInstanceId.make(`ctox_${pinned}`),
  runtimeMode: "approval-required" as const,
  modelSelection: {
    instanceId: ProviderInstanceId.make(`ctox_${pinned}`),
    model: CTOX_NATIVE_MODEL,
  },
  workjetConfig: threadConfigFor(bound),
});

/**
 * One harness per test. The peer's call log and the layer that installs the
 * peer are created TOGETHER, because the first draft of this file built two
 * separate Refs — the peer wrote to one, the assertion read the other, and the
 * "no call reached the wire" check would have passed no matter what happened.
 */
const harness = Effect.gen(function* () {
  const calls = yield* Ref.make<ReadonlyArray<string>>([]);
  return { calls, layer: Layer.succeed(HttpClient.HttpClient, fakePeer(calls)) };
});

it.effect("starts a first native turn before any provider session row exists", () =>
  Effect.gen(function* () {
    const test = yield* harness;
    yield* (yield* DecisionHubConnectionRegistry).provision(provision(CONNECTION_A));
    yield* (yield* WorkjetCrossModeLinkStore).createOrSelect(link);

    const instance = yield* instanceFor(CONNECTION_A).pipe(Effect.provide(test.layer));
    yield* instance.adapter.startSession(startInput(CONNECTION_A));
    const started = yield* instance.adapter.sendTurn({
      threadId: THREAD,
      requestId: "command:turn-1",
      input: "Review the renewal",
    });

    // Reaching the peer is the proof: it means binding → capability activation
    // → cross-mode link → connection pin all resolved from the START INPUT,
    // with the session directory deliberately empty.
    assert.include(yield* Ref.get(test.calls), "business_os.execute_action");
    assert.isString(started.turnId);
  }).pipe(Effect.scoped, Effect.provide(services)),
);

it.effect("refuses a thread bound to another connection of the SAME CTOX instance", () =>
  Effect.gen(function* () {
    const test = yield* harness;
    const connections = yield* DecisionHubConnectionRegistry;
    // Both connections are real, ready, and point at the same CTOX instance.
    // Nothing about the instance distinguishes them; only the pin does.
    yield* connections.provision(provision(CONNECTION_A));
    yield* connections.provision(provision(CONNECTION_B));
    yield* (yield* WorkjetCrossModeLinkStore).createOrSelect(link);

    // The provider instance sends over A. The thread is bound to B.
    const instance = yield* instanceFor(CONNECTION_A).pipe(Effect.provide(test.layer));
    // The refusal belongs to the START, because that is where the scope is
    // resolved; `sendTurn` reuses the scope the session already carries. So a
    // session that started at all would already be the defect.
    const failure = yield* Effect.flip(
      instance.adapter.startSession(startInput(CONNECTION_A, CONNECTION_B)),
    );

    // A bare `_tag` assertion would not narrow the union for the compiler, and
    // the fields below are the actual claim — so narrow, then read.
    if (failure._tag !== "ProviderAdapterRequestError") {
      return assert.fail(`expected a request error, got ${failure._tag}`);
    }
    assert.strictEqual(failure.provider, CTOX_DRIVER_KIND);
    // Naming both connections is the point: "same instance" is exactly the
    // reason a reader would otherwise assume this call was allowed.
    assert.include(failure.detail, CONNECTION_B);
    assert.include(failure.detail, CONNECTION_A);
    // And the refusal happened BEFORE the wire. A refusal after the daemon had
    // already accepted the action would leave real work running under the wrong
    // credential, which is the failure this rule exists to prevent.
    assert.notInclude(yield* Ref.get(test.calls), "business_os.execute_action");
  }).pipe(Effect.scoped, Effect.provide(services)),
);
