// @effect-diagnostics preferSchemaOverJson:off -- the fake daemon is a WIRE stand-in: it must read and write the same raw JSON strings the real CTOX routes exchange, so encoding through a schema here would stop testing the wire.
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ThreadId,
  WorkjetContentDigest,
  WorkjetDelegationId,
  WorkjetEnvelopeId,
  WorkjetMeshWorkspaceId,
  WorkjetRepositoryPath,
  WorkjetSealedPayloadRef,
  type WorkjetDelegation,
  type WorkjetMailboxPayload,
  type WorkjetRoutingEnvelope,
  type WorkjetWorkerAddress,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkjetMailboxStore, WorkjetMailboxStoreLive } from "./WorkjetMailboxStore.ts";
import {
  ctoxBaseUrlFromHealthUrl,
  makeWorkjetMailboxTransportWithSources,
  resolveCtoxEndpointFromDescriptor,
  type CtoxDaemonEndpoint,
  type WorkjetMailboxTransportSources,
} from "./WorkjetMailboxTransport.ts";
import { makeWorkjetMeshIdentity, WorkjetMeshIdentity } from "./WorkjetMeshIdentity.ts";

// ===============================
// Fixtures
// ===============================

const WORKSPACE = WorkjetMeshWorkspaceId.make("workjet-mesh-room-1");
const LOCAL_ENVIRONMENT = EnvironmentId.make("environment-local");
const REMOTE_ENVIRONMENT = EnvironmentId.make("environment-remote");
const LOCAL_THREAD = ThreadId.make("thread-local");
const REMOTE_THREAD = ThreadId.make("thread-remote");

const NOW = "2026-08-19T12:00:00.000Z";
const NOW_MILLIS = Date.parse(NOW);
const EXPIRES = "2026-08-19T13:00:00.000Z";
const EXPIRED = "2026-08-19T11:00:00.000Z";

const BASE_URL = "http://127.0.0.1:8788";
const TOKEN = "ctox-loopback-token";
const ENDPOINT: CtoxDaemonEndpoint = { baseUrl: BASE_URL };

const localAddress: WorkjetWorkerAddress = {
  schemaVersion: 1,
  workspaceId: WORKSPACE,
  environmentId: LOCAL_ENVIRONMENT,
  threadId: LOCAL_THREAD,
};
const remoteAddress: WorkjetWorkerAddress = {
  schemaVersion: 1,
  workspaceId: WORKSPACE,
  environmentId: REMOTE_ENVIRONMENT,
  threadId: REMOTE_THREAD,
};

const envelopeId = (suffix: string) => WorkjetEnvelopeId.make(`wjm-transport-${suffix}`);
const delegationId = (suffix: string) => WorkjetDelegationId.make(`wjd-transport-${suffix}`);

const delegationPayload = (input: {
  readonly envelopeId: WorkjetEnvelopeId;
  readonly delegationId: WorkjetDelegationId;
  readonly source: WorkjetWorkerAddress;
  readonly target: WorkjetWorkerAddress;
}): WorkjetMailboxPayload => {
  const delegation: WorkjetDelegation = {
    schemaVersion: 1,
    envelopeId: input.envelopeId,
    delegationId: input.delegationId,
    source: input.source,
    target: input.target,
    createdAt: NOW,
    expiresAt: EXPIRES,
    prompt: {
      schemaVersion: 1,
      snapshotRef: WorkjetSealedPayloadRef.make("cHJvbXB0LXNuYXBzaG90LXJlZi0wMDE"),
      digest: WorkjetContentDigest.make("a".repeat(63) + "b"),
      byteLength: 4_096,
    },
    scope: {
      schemaVersion: 1,
      files: [WorkjetRepositoryPath.make("apps/server/src/workjet/mailbox/x.ts")],
      nonGoals: "No relay, no UI.",
    },
    completion: { schemaVersion: 1, acceptance: "Focused transport tests pass." },
    budget: { schemaVersion: 1, maxDepth: 4, maxReviewRounds: 2, expiresAt: EXPIRES },
    state: "queued",
    stateChangedAt: NOW,
    depth: 0,
  };
  return { _tag: "delegation", delegation };
};

const messagePayload = (input: {
  readonly envelopeId: WorkjetEnvelopeId;
  readonly source: WorkjetWorkerAddress;
  readonly target: WorkjetWorkerAddress;
}): WorkjetMailboxPayload => ({
  _tag: "message",
  message: {
    schemaVersion: 1,
    envelopeId: input.envelopeId,
    source: input.source,
    target: input.target,
    createdAt: NOW,
    expiresAt: EXPIRES,
    body: {
      _tag: "sealed",
      payloadRef: WorkjetSealedPayloadRef.make("c2VhbGVkLXBheWxvYWQtY2Fub24"),
      byteLength: 512,
    },
  },
});

/** A real Ed25519 identity over an in-memory secret store. */
const makeIdentity = (workspaceId: WorkjetMeshWorkspaceId) => {
  const entries = new Map<string, Uint8Array>();
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) => {
      const value = entries.get(name);
      return Effect.succeed(value === undefined ? Option.none() : Option.some(value));
    },
    set: (name, value) => Effect.sync(() => void entries.set(name, value)),
    create: (name, value) => Effect.sync(() => void entries.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void entries.delete(name)),
  });
  return makeWorkjetMeshIdentity().pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.map((identity) => WorkjetMeshIdentity.of({ ...identity, workspaceId })),
  );
};

// ===============================
// Fake loopback daemon
// ===============================

interface DaemonDocument {
  readonly id: string;
  readonly target_environment_id: string;
  readonly envelope_json: string;
  readonly payload_json: string;
}

interface DaemonCall {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly body: unknown;
  readonly authorization: string | undefined;
}

/**
 * An in-process stand-in for the daemon's three loopback routes, wired in
 * through the SAME injected `HttpClient` boundary the real transport uses, so
 * the tests exercise the real request construction, headers, status handling
 * and JSON decoding rather than a parallel test-only path.
 *
 * Its behaviour mirrors `workjet_mailbox.rs`: publish is idempotent on the
 * envelope id and reports `duplicate`, pending returns only documents addressed
 * to the requested environment that it has not already consumed, and consumed
 * unions ids into `consumed_by`.
 */
const makeFakeDaemon = (options?: {
  readonly publishStatus?: number;
  readonly seed?: ReadonlyArray<DaemonDocument>;
}) => {
  const documents = new Map<string, DaemonDocument>();
  const consumed = new Map<string, Set<string>>();
  const calls: Array<DaemonCall> = [];
  for (const document of options?.seed ?? []) documents.set(document.id, document);

  const publish = (body: DaemonDocument) => {
    const duplicate = documents.has(body.id);
    if (!duplicate) documents.set(body.id, body);
    return { ok: true, id: body.id, duplicate, tombstoned: false };
  };

  const pending = (environmentId: string) => {
    const envelopes = [...documents.values()].filter(
      (document) =>
        document.target_environment_id === environmentId &&
        !(consumed.get(document.id)?.has(environmentId) ?? false),
    );
    return { ok: true, environment_id: environmentId, envelopes, count: envelopes.length };
  };

  const markConsumed = (environmentId: string, ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      const set = consumed.get(id) ?? new Set<string>();
      set.add(environmentId);
      consumed.set(id, set);
    }
    return { ok: true, updated: ids };
  };

  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const raw = request.body;
      const bytes = (raw as { readonly body?: Uint8Array }).body;
      const body: unknown =
        bytes === undefined ? undefined : JSON.parse(new TextDecoder().decode(bytes));
      calls.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        body,
        authorization: request.headers["authorization"],
      });

      const answer = (status: number, payload: unknown) =>
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(payload), {
            status,
            headers: { "content-type": "application/json" },
          }),
        );

      if (url.pathname === "/workjet/mailbox/publish") {
        const status = options?.publishStatus ?? 200;
        if (status !== 200) return answer(status, { ok: false, error: "invalid_request" });
        return answer(200, publish(body as DaemonDocument));
      }
      if (url.pathname === "/workjet/mailbox/pending") {
        return answer(200, pending(url.searchParams.get("environment_id") ?? ""));
      }
      if (url.pathname === "/workjet/mailbox/consumed") {
        const parsed = body as { environment_id: string; envelope_ids: ReadonlyArray<string> };
        return answer(200, markConsumed(parsed.environment_id, parsed.envelope_ids));
      }
      return answer(404, { ok: false, error: "not_found" });
    }),
  );

  return { client, calls, documents, consumed };
};

const callsTo = (calls: ReadonlyArray<DaemonCall>, path: string) =>
  calls.filter((call) => call.path === path);

const callAt = (calls: ReadonlyArray<DaemonCall>, path: string, index = 0): DaemonCall => {
  const call = callsTo(calls, path)[index];
  if (call === undefined) throw new Error(`expected a ${path} call at index ${index}`);
  return call;
};

/** The envelope ids one `consumed` call reported to the daemon. */
const consumedIds = (calls: ReadonlyArray<DaemonCall>, index = 0): ReadonlyArray<string> =>
  (
    callAt(calls, "/workjet/mailbox/consumed", index).body as {
      readonly envelope_ids: ReadonlyArray<string>;
    }
  ).envelope_ids;

// ===============================
// Harness
// ===============================

const sources = (
  overrides?: Partial<WorkjetMailboxTransportSources>,
): WorkjetMailboxTransportSources => ({
  nowIso: Effect.succeed(NOW),
  resolveEndpoint: Effect.succeed({ _tag: "resolved", endpoint: ENDPOINT } as const),
  resolveAuthToken: Effect.succeed(Option.some(TOKEN)),
  ...overrides,
});

const environmentLayer = Layer.succeed(
  ServerEnvironment,
  ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(LOCAL_ENVIRONMENT),
    getDescriptor: Effect.die("unused"),
  } as unknown as ServerEnvironment["Service"]),
);

const makeTransport = (input: {
  readonly client: HttpClient.HttpClient;
  readonly sources?: Partial<WorkjetMailboxTransportSources>;
  readonly identity?: Effect.Effect<WorkjetMeshIdentity["Service"]>;
}) =>
  (input.identity ?? makeIdentity(WORKSPACE)).pipe(
    Effect.flatMap((identity) =>
      makeWorkjetMailboxTransportWithSources(sources(input.sources)).pipe(
        Effect.provideService(WorkjetMeshIdentity, identity),
      ),
    ),
    Effect.provideService(HttpClient.HttpClient, input.client),
    Effect.provide(environmentLayer),
  );

const testLayer = Layer.mergeAll(
  WorkjetMailboxStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  SqlitePersistenceMemory,
);

type TestServices = Layer.Success<typeof testLayer>;

/**
 * Groups tests that each need their OWN database. A shared layer would be
 * wrong here specifically because of trust-on-first-use: every pull test uses
 * the same `(workspace, environment)` source pair, so one shared database would
 * let the first test's peer key pin the key for all the others and quietly turn
 * the continuity assertions into tautologies.
 */
type TestLayerError = Layer.Error<typeof testLayer>;

const scopedEffect = <E>(
  label: string,
  body: () => Effect.Effect<unknown, E, TestServices>,
): void => {
  it.effect(
    label,
    (): Effect.Effect<unknown, E | TestLayerError> => body().pipe(Effect.provide(testLayer)),
  );
};

const group = (
  _name: string,
  register: (api: { readonly effect: typeof scopedEffect }) => void,
): void => register({ effect: scopedEffect });

/**
 * Builds a document exactly as a PEER would have published it: a routing
 * envelope signed with the peer's own key, wrapped with that key in the
 * transport payload wrapper.
 */
const remoteDocument = (input: {
  readonly identity: WorkjetMeshIdentity["Service"];
  readonly envelopeId: WorkjetEnvelopeId;
  readonly payload: WorkjetMailboxPayload;
  readonly kind: WorkjetRoutingEnvelope["kind"];
  readonly expiresAt?: string;
  readonly tamperSignature?: boolean;
  readonly publicKeyOverride?: string;
}) =>
  Effect.gen(function* () {
    const signed = yield* input.identity.signRoutingEnvelope({
      schemaVersion: 1,
      envelopeId: input.envelopeId,
      kind: input.kind,
      sourceWorkspaceId: WORKSPACE,
      sourceEnvironmentId: REMOTE_ENVIRONMENT,
      targetWorkspaceId: WORKSPACE,
      targetEnvironmentId: LOCAL_ENVIRONMENT,
      createdAt: NOW,
      expiresAt: input.expiresAt ?? EXPIRES,
    });
    const signature = input.tamperSignature
      ? `${signed.signature.startsWith("A") ? "B" : "A"}${signed.signature.slice(1)}`
      : signed.signature;
    const envelope = { ...signed, signature };
    return {
      id: input.envelopeId as string,
      target_environment_id: LOCAL_ENVIRONMENT as string,
      envelope_json: JSON.stringify(envelope),
      payload_json: JSON.stringify({
        schemaVersion: 1,
        senderPublicKey: input.publicKeyOverride ?? input.identity.publicKey,
        payload: input.payload,
      }),
    } satisfies DaemonDocument;
  });

// ===============================
// Endpoint resolution
// ===============================

it.effect("derives the loopback base url from the descriptor health url", () =>
  Effect.sync(() => {
    assert.deepEqual(
      ctoxBaseUrlFromHealthUrl("http://127.0.0.1:8788/health"),
      Option.some("http://127.0.0.1:8788"),
    );
    assert.deepEqual(
      ctoxBaseUrlFromHealthUrl("http://localhost:9999/health/"),
      Option.some("http://localhost:9999"),
    );
    // A descriptor may not widen a loopback-only surface onto the network.
    assert.isTrue(Option.isNone(ctoxBaseUrlFromHealthUrl("http://10.0.0.4:8788/health")));
    assert.isTrue(Option.isNone(ctoxBaseUrlFromHealthUrl("not-a-url")));
  }),
);

it.effect("reads a running descriptor and refuses a stale one", () =>
  Effect.gen(function* () {
    const descriptor = (status: string, lastSeenAt: number) =>
      JSON.stringify({
        version: 1,
        instanceId: "ctox-local",
        displayName: "CTOX Local Instance",
        status,
        lastSeenAt,
        healthUrl: "http://127.0.0.1:8788/health",
      });

    const fileSystem = (contents: string | null) =>
      ({
        readFileString: () =>
          contents === null
            ? Effect.fail({ _tag: "DescriptorMissing" } as const)
            : Effect.succeed(contents),
      }) as never;

    const resolve = (contents: string | null) =>
      resolveCtoxEndpointFromDescriptor({
        fileSystem: fileSystem(contents),
        path: "/state/instance.json",
        nowMillis: Effect.succeed(NOW_MILLIS),
      });

    assert.deepEqual(yield* resolve(descriptor("running", NOW_MILLIS - 1_000)), {
      _tag: "resolved",
      endpoint: { baseUrl: BASE_URL },
    });
    assert.deepEqual(yield* resolve(descriptor("stopped", NOW_MILLIS)), {
      _tag: "idle",
      reason: "daemon-not-running",
    });
    // A descriptor left behind by a crashed daemon must not read as an endpoint.
    assert.deepEqual(yield* resolve(descriptor("running", NOW_MILLIS - 600_000)), {
      _tag: "idle",
      reason: "daemon-not-running",
    });
    assert.deepEqual(yield* resolve(null), { _tag: "idle", reason: "descriptor-missing" });
    assert.deepEqual(yield* resolve("{not json"), {
      _tag: "idle",
      reason: "descriptor-unreadable",
    });
  }),
);

// ===============================
// Idle behaviour
// ===============================

group("WorkjetMailboxTransport idles", (it) => {
  it.effect("idles without touching the daemon when the token is unreachable", () =>
    Effect.gen(function* () {
      const daemon = makeFakeDaemon();
      const transport = yield* makeTransport({
        client: daemon.client,
        sources: { resolveAuthToken: Effect.succeed(Option.none()) },
      });

      const status = yield* transport.runCycle;

      assert.isFalse(status.running);
      assert.strictEqual(status.idleReason, "token-unavailable");
      assert.deepEqual(daemon.calls, [], "an unauthenticated call must never be attempted");
    }),
  );

  it.effect("idles and re-probes when the daemon descriptor is absent", () =>
    Effect.gen(function* () {
      const daemon = makeFakeDaemon();
      const transport = yield* makeTransport({
        client: daemon.client,
        sources: {
          resolveEndpoint: Effect.succeed({ _tag: "idle", reason: "descriptor-missing" } as const),
        },
      });

      const first = yield* transport.runCycle;
      const second = yield* transport.runCycle;

      assert.strictEqual(first.idleReason, "descriptor-missing");
      assert.strictEqual(second.idleReason, "descriptor-missing");
      assert.deepEqual(daemon.calls, []);
      assert.strictEqual(second.counters.pushed, 0);
    }),
  );
});

// ===============================
// PUSH
// ===============================

group("WorkjetMailboxTransport push", (it) => {
  it.effect("publishes a cross-environment envelope and marks it delivered", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const daemon = makeFakeDaemon();
      const identity = yield* makeIdentity(WORKSPACE);
      const transport = yield* makeTransport({
        client: daemon.client,
        identity: Effect.succeed(identity),
      });

      const id = envelopeId("push-0001");
      const envelope = yield* identity.signRoutingEnvelope({
        schemaVersion: 1,
        envelopeId: id,
        kind: "message",
        sourceWorkspaceId: WORKSPACE,
        sourceEnvironmentId: LOCAL_ENVIRONMENT,
        targetWorkspaceId: WORKSPACE,
        targetEnvironmentId: REMOTE_ENVIRONMENT,
        createdAt: NOW,
        expiresAt: EXPIRES,
      });
      yield* store.enqueueOutbound(
        envelope,
        messagePayload({ envelopeId: id, source: localAddress, target: remoteAddress }),
      );

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.pushed, 1);
      assert.strictEqual(status.counters.pushFailures, 0);

      const outbound = yield* store.getOutbound(id);
      assert.isTrue(Option.isSome(outbound));
      assert.strictEqual(Option.getOrThrow(outbound).state, "delivered");

      const published = callsTo(daemon.calls, "/workjet/mailbox/publish");
      assert.strictEqual(published.length, 1);
      assert.strictEqual(published[0]?.authorization, `Bearer ${TOKEN}`);

      // The wire document carries the SIGNED envelope and the sender key
      // wrapper, and the daemon sees nothing else.
      const document = published[0]?.body as DaemonDocument;
      assert.strictEqual(document.id, id);
      assert.strictEqual(document.target_environment_id, REMOTE_ENVIRONMENT);
      const wire = JSON.parse(document.envelope_json) as WorkjetRoutingEnvelope;
      assert.strictEqual(wire.signature, envelope.signature);
      const wrapper = JSON.parse(document.payload_json) as { senderPublicKey: string };
      assert.strictEqual(wrapper.senderPublicKey, identity.publicKey);
    }),
  );

  it.effect("never hands a same-environment envelope to the daemon", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const daemon = makeFakeDaemon();
      const identity = yield* makeIdentity(WORKSPACE);
      const transport = yield* makeTransport({
        client: daemon.client,
        identity: Effect.succeed(identity),
      });

      const id = envelopeId("push-local-001");
      const envelope = yield* identity.signRoutingEnvelope({
        schemaVersion: 1,
        envelopeId: id,
        kind: "message",
        sourceWorkspaceId: WORKSPACE,
        sourceEnvironmentId: LOCAL_ENVIRONMENT,
        targetWorkspaceId: WORKSPACE,
        targetEnvironmentId: LOCAL_ENVIRONMENT,
        createdAt: NOW,
        expiresAt: EXPIRES,
      });
      yield* store.enqueueOutbound(
        envelope,
        messagePayload({ envelopeId: id, source: localAddress, target: localAddress }),
      );

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.pushed, 0);
      assert.deepEqual(callsTo(daemon.calls, "/workjet/mailbox/publish"), []);
    }),
  );

  it.effect("records an attempt instead of delivery when the daemon refuses", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const daemon = makeFakeDaemon({ publishStatus: 500 });
      const identity = yield* makeIdentity(WORKSPACE);
      const transport = yield* makeTransport({
        client: daemon.client,
        identity: Effect.succeed(identity),
      });

      const id = envelopeId("push-fail-001");
      const envelope = yield* identity.signRoutingEnvelope({
        schemaVersion: 1,
        envelopeId: id,
        kind: "message",
        sourceWorkspaceId: WORKSPACE,
        sourceEnvironmentId: LOCAL_ENVIRONMENT,
        targetWorkspaceId: WORKSPACE,
        targetEnvironmentId: REMOTE_ENVIRONMENT,
        createdAt: NOW,
        expiresAt: EXPIRES,
      });
      yield* store.enqueueOutbound(
        envelope,
        messagePayload({ envelopeId: id, source: localAddress, target: remoteAddress }),
      );

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.pushed, 0);
      assert.strictEqual(status.counters.pushFailures, 1);

      const outbound = Option.getOrThrow(yield* store.getOutbound(id));
      assert.strictEqual(outbound.state, "pending", "a refused push stays retryable");
      assert.strictEqual(outbound.attemptCount, 1, "the existing backoff budget advances");
    }),
  );

  it.effect("treats a duplicate publish as delivered", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const identity = yield* makeIdentity(WORKSPACE);
      const id = envelopeId("push-dup-0001");
      const envelope = yield* identity.signRoutingEnvelope({
        schemaVersion: 1,
        envelopeId: id,
        kind: "message",
        sourceWorkspaceId: WORKSPACE,
        sourceEnvironmentId: LOCAL_ENVIRONMENT,
        targetWorkspaceId: WORKSPACE,
        targetEnvironmentId: REMOTE_ENVIRONMENT,
        createdAt: NOW,
        expiresAt: EXPIRES,
      });
      // The daemon already holds this id: a re-publish after a crashed cycle.
      const daemon = makeFakeDaemon({
        seed: [
          {
            id,
            target_environment_id: REMOTE_ENVIRONMENT,
            envelope_json: JSON.stringify(envelope),
            payload_json: "{}",
          },
        ],
      });
      const transport = yield* makeTransport({
        client: daemon.client,
        identity: Effect.succeed(identity),
      });
      yield* store.enqueueOutbound(
        envelope,
        messagePayload({ envelopeId: id, source: localAddress, target: remoteAddress }),
      );

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.pushDuplicates, 1);
      assert.strictEqual(status.counters.pushed, 0);
      assert.strictEqual(Option.getOrThrow(yield* store.getOutbound(id)).state, "delivered");
    }),
  );
});

// ===============================
// PULL
// ===============================

group("WorkjetMailboxTransport pull", (it) => {
  it.effect("verifies, ingests, applies the delegation, and consumes", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);
      const id = envelopeId("pull-deleg-01");
      const delegation = delegationId("pull-deleg-01");
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "delegation",
        payload: delegationPayload({
          envelopeId: id,
          delegationId: delegation,
          source: remoteAddress,
          target: localAddress,
        }),
      });
      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({ client: daemon.client });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.pulled, 1);
      assert.strictEqual(status.counters.accepted, 1);
      assert.strictEqual(status.counters.rejected, 0);

      const inbound = yield* store.getInbound(id);
      assert.isTrue(Option.isSome(inbound), "the envelope is durable locally");

      // The SAME lifecycle the local fast path produces: queued → delivered.
      const record = Option.getOrThrow(yield* store.getDelegation(delegation));
      assert.strictEqual(record.state, "delivered");

      assert.strictEqual(callsTo(daemon.calls, "/workjet/mailbox/consumed").length, 1);
      assert.deepEqual(consumedIds(daemon.calls), [id]);
      assert.strictEqual(status.counters.consumed, 1);

      // The pending query targets THIS environment only.
      assert.include(
        callAt(daemon.calls, "/workjet/mailbox/pending").query,
        `environment_id=${LOCAL_ENVIRONMENT}`,
      );
    }),
  );

  it.effect("consumes a replayed envelope without repeating its delegation effects", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);
      const id = envelopeId("pull-replay-01");
      const delegation = delegationId("pull-replay-01");
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "delegation",
        payload: delegationPayload({
          envelopeId: id,
          delegationId: delegation,
          source: remoteAddress,
          target: localAddress,
        }),
      });
      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({ client: daemon.client });

      yield* transport.runCycle;
      // The delegation has since progressed; a replay must not drag it back.
      yield* store.transitionDelegationState(delegation, "delivered", "accepted", NOW);

      // The daemon "forgets" the consumption, exactly as at-least-once delivery
      // permits, and hands the same document over again.
      daemon.consumed.clear();
      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.inboundDuplicates, 1);
      assert.strictEqual(status.counters.accepted, 1, "still exactly one acceptance overall");
      assert.strictEqual(
        Option.getOrThrow(yield* store.getDelegation(delegation)).state,
        "accepted",
        "a replay must not re-run the lifecycle",
      );
      assert.strictEqual(callsTo(daemon.calls, "/workjet/mailbox/consumed").length, 2);
    }),
  );

  it.effect("rejects and consumes a tampered signature", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);
      const id = envelopeId("pull-tamper-01");
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "message",
        tamperSignature: true,
        payload: messagePayload({
          envelopeId: id,
          source: remoteAddress,
          target: localAddress,
        }),
      });
      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({ client: daemon.client });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.accepted, 0);
      assert.strictEqual(status.rejections.signature, 1);
      assert.isTrue(Option.isNone(yield* store.getInbound(id)), "nothing durable is written");
      // A poison envelope is consumed, or the loop would re-read it forever.
      assert.deepEqual(consumedIds(daemon.calls), [id]);
    }),
  );

  it.effect("rejects and consumes an envelope whose sender key rotated", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);
      const impostor = yield* makeIdentity(WORKSPACE);

      const firstId = envelopeId("pull-tofu-0001");
      const first = yield* remoteDocument({
        identity: peer,
        envelopeId: firstId,
        kind: "message",
        payload: messagePayload({
          envelopeId: firstId,
          source: remoteAddress,
          target: localAddress,
        }),
      });

      // A SECOND envelope from the same source pair, correctly signed with a
      // DIFFERENT key. The signature verifies against the self-asserted key, so
      // continuity is the only thing standing between the room and
      // impersonation.
      const secondId = envelopeId("pull-tofu-0002");
      const second = yield* remoteDocument({
        identity: impostor,
        envelopeId: secondId,
        kind: "message",
        payload: messagePayload({
          envelopeId: secondId,
          source: remoteAddress,
          target: localAddress,
        }),
      });

      const daemon = makeFakeDaemon({ seed: [first, second] });
      const transport = yield* makeTransport({ client: daemon.client });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.accepted, 1, "the first key is pinned and accepted");
      assert.strictEqual(status.rejections.keyContinuity, 1);
      assert.isTrue(Option.isSome(yield* store.getInbound(firstId)));
      assert.isTrue(
        Option.isNone(yield* store.getInbound(secondId)),
        "a rotated key must not reach the inbox",
      );

      assert.deepEqual([...consumedIds(daemon.calls)].sort(), [firstId, secondId].sort());
    }),
  );

  it.effect("rejects and consumes expired, misaddressed, and undecodable envelopes", () =>
    Effect.gen(function* () {
      const peer = yield* makeIdentity(WORKSPACE);

      const expiredId = envelopeId("pull-expired-1");
      const expired = yield* remoteDocument({
        identity: peer,
        envelopeId: expiredId,
        kind: "message",
        expiresAt: EXPIRED,
        payload: messagePayload({
          envelopeId: expiredId,
          source: remoteAddress,
          target: localAddress,
        }),
      });

      // The daemon's document id and the SIGNED envelope id disagree; CTOX
      // never checks this, because it never reads the envelope.
      const mismatchedId = envelopeId("pull-mismatch-1");
      const mismatched = {
        ...(yield* remoteDocument({
          identity: peer,
          envelopeId: mismatchedId,
          kind: "message",
          payload: messagePayload({
            envelopeId: mismatchedId,
            source: remoteAddress,
            target: localAddress,
          }),
        })),
        id: "pull-mismatch-other",
      } satisfies DaemonDocument;

      const garbage: DaemonDocument = {
        id: "pull-garbage-001",
        target_environment_id: LOCAL_ENVIRONMENT,
        envelope_json: "{not json",
        payload_json: "{}",
      };

      const daemon = makeFakeDaemon({ seed: [expired, mismatched, garbage] });
      const transport = yield* makeTransport({ client: daemon.client });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.accepted, 0);
      assert.strictEqual(status.counters.rejected, 3);
      assert.strictEqual(status.rejections.expired, 1);
      assert.strictEqual(status.rejections.misaddressed, 1);
      assert.strictEqual(status.rejections.malformed, 1);
      assert.strictEqual(status.counters.consumed, 3, "no poison envelope loops");
    }),
  );
});
