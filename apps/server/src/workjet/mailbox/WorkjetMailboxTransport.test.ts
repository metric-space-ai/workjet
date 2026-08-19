// @effect-diagnostics preferSchemaOverJson:off -- the fake daemon is a WIRE stand-in: it must read and write the same raw JSON strings the real CTOX routes exchange, so encoding through a schema here would stop testing the wire.
import * as NodeServices from "@effect/platform-node/NodeServices";
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
  type WorkjetPromptSnapshotRef,
  type WorkjetRoutingEnvelope,
  type WorkjetWorkerAddress,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { WorkjetMailboxStore, WorkjetMailboxStoreLive } from "./WorkjetMailboxStore.ts";
import {
  WorkjetSnapshotStore,
  WorkjetSnapshotStoreLive,
  snapshotRefForDigest,
} from "./WorkjetSnapshotStore.ts";
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

/** sha256 hex of a UTF-8 string, matching the snapshot store's own digest. */
const sha256Hex = (text: string): WorkjetContentDigest =>
  WorkjetContentDigest.make(
    NodeCrypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"),
  );

/** The prompt reference the snapshot store would mint for this exact text. */
const promptRefFor = (text: string): WorkjetPromptSnapshotRef => {
  const digest = sha256Hex(text);
  return {
    schemaVersion: 1,
    snapshotRef: snapshotRefForDigest(digest),
    digest,
    byteLength: Buffer.byteLength(text, "utf8"),
  };
};

const delegationPayload = (input: {
  readonly envelopeId: WorkjetEnvelopeId;
  readonly delegationId: WorkjetDelegationId;
  readonly source: WorkjetWorkerAddress;
  readonly target: WorkjetWorkerAddress;
  /** Overrides the scope whitelist, to build a deliberately huge payload. */
  readonly files?: ReadonlyArray<WorkjetRepositoryPath>;
  /** Pins the prompt to a real snapshot digest for transfer tests. */
  readonly prompt?: WorkjetPromptSnapshotRef;
}): WorkjetMailboxPayload => {
  const delegation: WorkjetDelegation = {
    schemaVersion: 1,
    envelopeId: input.envelopeId,
    delegationId: input.delegationId,
    source: input.source,
    target: input.target,
    createdAt: NOW,
    expiresAt: EXPIRES,
    prompt: input.prompt ?? {
      schemaVersion: 1,
      snapshotRef: WorkjetSealedPayloadRef.make("cHJvbXB0LXNuYXBzaG90LXJlZi0wMDE"),
      digest: WorkjetContentDigest.make("a".repeat(63) + "b"),
      byteLength: 4_096,
    },
    scope: {
      schemaVersion: 1,
      files: input.files ?? [WorkjetRepositoryPath.make("apps/server/src/workjet/mailbox/x.ts")],
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

/**
 * A REAL content-addressed snapshot store over a fresh temp directory, so the
 * transfer tests exercise the store's actual digest verification rather than a
 * fake. `makeTempDirectoryScoped` mints a unique directory per layer build, so
 * each test's store starts empty — vital here, exactly like the per-test
 * database, so one test's stored snapshot cannot satisfy another's read.
 */
const snapshotStoreLayer = WorkjetSnapshotStoreLive.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "workjet-transport-snapshots-" })),
  Layer.provide(NodeServices.layer),
);

const testLayer = Layer.mergeAll(
  WorkjetMailboxStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
  SqlitePersistenceMemory,
  snapshotStoreLayer,
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
  /** Emit the pre-sealing v1 wrapper, as an un-upgraded peer still would. */
  readonly legacyV1?: boolean;
  /** Seal the payload to this X25519 key instead of sending it in the clear. */
  readonly sealToKey?: string;
  /** Seal under a DIFFERENT envelope id, to exercise the AAD binding. */
  readonly sealEnvelopeId?: string;
  readonly encryptionKeyOverride?: string;
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

    const wrapper = input.legacyV1
      ? {
          schemaVersion: 1,
          senderPublicKey: input.publicKeyOverride ?? input.identity.publicKey,
          payload: input.payload,
        }
      : {
          schemaVersion: 2,
          senderSigningKey: input.publicKeyOverride ?? input.identity.publicKey,
          senderEncryptionKey: input.encryptionKeyOverride ?? input.identity.encryptionPublicKey,
          body:
            input.sealToKey === undefined
              ? { plain: input.payload, reason: "recipient-key-unknown" }
              : {
                  sealed: yield* input.identity.sealTo(
                    input.sealToKey,
                    new TextEncoder().encode(JSON.stringify(input.payload)),
                    input.sealEnvelopeId ?? input.envelopeId,
                  ),
                },
        };

    return {
      id: input.envelopeId as string,
      target_environment_id: LOCAL_ENVIRONMENT as string,
      envelope_json: JSON.stringify(envelope),
      payload_json: JSON.stringify(wrapper),
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
      // A v2 wrapper carrying BOTH public keys. This peer is unknown, so the
      // payload travels in the clear exactly once, with the reason on the wire.
      const wrapper = JSON.parse(document.payload_json) as {
        schemaVersion: number;
        senderSigningKey: string;
        senderEncryptionKey: string;
        body: { plain?: unknown; reason?: string };
      };
      assert.strictEqual(wrapper.schemaVersion, 2);
      assert.strictEqual(wrapper.senderSigningKey, identity.publicKey);
      assert.strictEqual(wrapper.senderEncryptionKey, identity.encryptionPublicKey);
      assert.strictEqual(wrapper.body.reason, "recipient-key-unknown");
      assert.strictEqual(status.counters.plainFirstContact, 1);
      assert.strictEqual(status.counters.sealed, 0);
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

// ===============================
// SEALING
// ===============================

/** The wrapper a push actually put on the wire, as the daemon received it. */
const publishedWrapper = (
  calls: ReadonlyArray<DaemonCall>,
  index = 0,
): {
  readonly schemaVersion: number;
  readonly senderSigningKey: string;
  readonly senderEncryptionKey: string;
  readonly body: {
    readonly sealed?: { ephemeralKey: string; nonce: string; ciphertext: string };
    readonly plain?: WorkjetMailboxPayload;
    readonly reason?: string;
  };
} =>
  JSON.parse(
    (callAt(calls, "/workjet/mailbox/publish", index).body as DaemonDocument).payload_json,
  );

const outboundTo = (input: {
  readonly identity: WorkjetMeshIdentity["Service"];
  readonly store: WorkjetMailboxStore["Service"];
  readonly envelopeId: WorkjetEnvelopeId;
  readonly payload: WorkjetMailboxPayload;
}) =>
  Effect.gen(function* () {
    const envelope = yield* input.identity.signRoutingEnvelope({
      schemaVersion: 1,
      envelopeId: input.envelopeId,
      kind: "message",
      sourceWorkspaceId: WORKSPACE,
      sourceEnvironmentId: LOCAL_ENVIRONMENT,
      targetWorkspaceId: WORKSPACE,
      targetEnvironmentId: REMOTE_ENVIRONMENT,
      createdAt: NOW,
      expiresAt: EXPIRES,
    });
    yield* input.store.enqueueOutbound(envelope, input.payload);
  });

group("WorkjetMailboxTransport sealing", (it) => {
  it.effect("sends the first envelope to a peer plain, then seals every later one", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const local = yield* makeIdentity(WORKSPACE);
      const peer = yield* makeIdentity(WORKSPACE);
      const daemon = makeFakeDaemon();
      const transport = yield* makeTransport({
        client: daemon.client,
        identity: Effect.succeed(local),
      });

      // FIRST CONTACT. This machine has never heard from the peer, so its
      // encryption key is unknown and the payload cannot be sealed.
      const firstId = envelopeId("seal-out-0001");
      const firstPayload = messagePayload({
        envelopeId: firstId,
        source: localAddress,
        target: remoteAddress,
      });
      yield* outboundTo({ identity: local, store, envelopeId: firstId, payload: firstPayload });

      const first = yield* transport.runCycle;
      assert.strictEqual(first.counters.plainFirstContact, 1);
      assert.strictEqual(first.counters.sealed, 0);
      assert.deepEqual(publishedWrapper(daemon.calls).body.plain, firstPayload);

      // The peer answers. Its envelope pins BOTH of its keys, which is exactly
      // the interim key exchange: the reply is what teaches us where to seal.
      const inboundId = envelopeId("seal-in-00001");
      daemon.documents.set(
        inboundId,
        yield* remoteDocument({
          identity: peer,
          envelopeId: inboundId,
          kind: "message",
          payload: messagePayload({
            envelopeId: inboundId,
            source: remoteAddress,
            target: localAddress,
          }),
        }),
      );
      const second = yield* transport.runCycle;
      assert.strictEqual(second.counters.accepted, 1);

      // EVERY later envelope in this direction is sealed.
      const thirdId = envelopeId("seal-out-0002");
      const thirdPayload = messagePayload({
        envelopeId: thirdId,
        source: localAddress,
        target: remoteAddress,
      });
      yield* outboundTo({ identity: local, store, envelopeId: thirdId, payload: thirdPayload });

      const third = yield* transport.runCycle;
      assert.strictEqual(third.counters.sealed, 1);
      assert.strictEqual(third.counters.plainFirstContact, 1, "no second plaintext envelope");

      const sealedWrapper = publishedWrapper(daemon.calls, 1);
      assert.isUndefined(sealedWrapper.body.plain);
      const sealed = sealedWrapper.body.sealed;
      assert.isDefined(sealed);
      // The daemon holds bytes it cannot read; only the recipient can.
      assert.notInclude(JSON.stringify(sealed), thirdId);
      const opened = yield* peer.openSealed(sealed!, thirdId);
      assert.deepEqual(JSON.parse(new TextDecoder().decode(opened)), thirdPayload);
    }),
  );

  it.effect("opens a sealed inbound payload and applies its delegation", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const local = yield* makeIdentity(WORKSPACE);
      const peer = yield* makeIdentity(WORKSPACE);

      const id = envelopeId("seal-deleg-01");
      const delegation = delegationId("seal-deleg-01");
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "delegation",
        sealToKey: local.encryptionPublicKey,
        payload: delegationPayload({
          envelopeId: id,
          delegationId: delegation,
          source: remoteAddress,
          target: localAddress,
        }),
      });
      // Nothing readable travels: the delegation id itself is inside the blob.
      assert.notInclude(document.payload_json, delegation);

      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({
        client: daemon.client,
        identity: Effect.succeed(local),
      });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.accepted, 1);
      assert.strictEqual(status.counters.unsealed, 1);
      assert.strictEqual(status.counters.rejected, 0);
      // The SAME lifecycle a plaintext delegation produces.
      assert.strictEqual(
        Option.getOrThrow(yield* store.getDelegation(delegation)).state,
        "delivered",
      );
      assert.deepEqual(consumedIds(daemon.calls), [id]);
    }),
  );

  it.effect("rejects and consumes a sealed payload it cannot open", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const local = yield* makeIdentity(WORKSPACE);
      const peer = yield* makeIdentity(WORKSPACE);
      const stranger = yield* makeIdentity(WORKSPACE);

      // Sealed to a THIRD environment: correctly signed, correctly addressed,
      // and still unreadable here.
      const wrongKeyId = envelopeId("seal-wrongkey");
      const wrongKey = yield* remoteDocument({
        identity: peer,
        envelopeId: wrongKeyId,
        kind: "message",
        sealToKey: stranger.encryptionPublicKey,
        payload: messagePayload({
          envelopeId: wrongKeyId,
          source: remoteAddress,
          target: localAddress,
        }),
      });

      // Sealed to the right key but bound by AAD to ANOTHER envelope id: a
      // blob lifted off a different envelope must not open under this one.
      const replayId = envelopeId("seal-replay-1");
      const replay = yield* remoteDocument({
        identity: peer,
        envelopeId: replayId,
        kind: "message",
        sealToKey: local.encryptionPublicKey,
        sealEnvelopeId: envelopeId("seal-replay-9"),
        payload: messagePayload({
          envelopeId: replayId,
          source: remoteAddress,
          target: localAddress,
        }),
      });

      const daemon = makeFakeDaemon({ seed: [wrongKey, replay] });
      const transport = yield* makeTransport({
        client: daemon.client,
        identity: Effect.succeed(local),
      });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.accepted, 0);
      assert.strictEqual(status.rejections.sealing, 2);
      assert.strictEqual(status.rejections.signature, 0, "the envelopes themselves were valid");
      assert.isTrue(Option.isNone(yield* store.getInbound(wrongKeyId)));
      assert.isTrue(Option.isNone(yield* store.getInbound(replayId)));
      // Poison envelopes are consumed, exactly like every other rejection.
      assert.deepEqual([...consumedIds(daemon.calls)].sort(), [wrongKeyId, replayId].sort());
    }),
  );

  it.effect("accepts a v1 wrapper from a peer that has not upgraded yet", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);

      const id = envelopeId("seal-v1-00001");
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "message",
        legacyV1: true,
        payload: messagePayload({
          envelopeId: id,
          source: remoteAddress,
          target: localAddress,
        }),
      });
      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({ client: daemon.client });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.accepted, 1);
      assert.strictEqual(status.counters.unsealed, 0, "a v1 wrapper carries no sealed blob");
      assert.strictEqual(status.counters.rejected, 0);
      assert.isTrue(Option.isSome(yield* store.getInbound(id)));
    }),
  );

  it.effect("pins the encryption key a v1 peer advertises only after it upgrades", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);

      // A v1 envelope pins the signing key and says nothing about encryption.
      const legacyId = envelopeId("seal-mix-00001");
      const legacy = yield* remoteDocument({
        identity: peer,
        envelopeId: legacyId,
        kind: "message",
        legacyV1: true,
        payload: messagePayload({
          envelopeId: legacyId,
          source: remoteAddress,
          target: localAddress,
        }),
      });
      // The SAME peer, now upgraded. Learning its encryption key one field
      // later is still first use, not a rotation.
      const upgradedId = envelopeId("seal-mix-00002");
      const upgraded = yield* remoteDocument({
        identity: peer,
        envelopeId: upgradedId,
        kind: "message",
        payload: messagePayload({
          envelopeId: upgradedId,
          source: remoteAddress,
          target: localAddress,
        }),
      });

      const daemon = makeFakeDaemon({ seed: [legacy, upgraded] });
      const transport = yield* makeTransport({ client: daemon.client });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.accepted, 2);
      assert.strictEqual(status.rejections.keyContinuity, 0);
      assert.isTrue(Option.isSome(yield* store.getInbound(legacyId)));
      assert.isTrue(Option.isSome(yield* store.getInbound(upgradedId)));
    }),
  );

  it.effect("rejects and consumes an envelope whose ENCRYPTION key rotated", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);
      const impostor = yield* makeIdentity(WORKSPACE);

      const firstId = envelopeId("seal-rot-00001");
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

      // The signing key is unchanged and the signature verifies; only the
      // advertised ENCRYPTION key differs. Adopting it would let a room member
      // redirect this peer's future sealed replies to itself, so continuity
      // must refuse it exactly as it refuses a rotated signing key.
      const secondId = envelopeId("seal-rot-00002");
      const second = yield* remoteDocument({
        identity: peer,
        envelopeId: secondId,
        kind: "message",
        encryptionKeyOverride: impostor.encryptionPublicKey,
        payload: messagePayload({
          envelopeId: secondId,
          source: remoteAddress,
          target: localAddress,
        }),
      });

      const daemon = makeFakeDaemon({ seed: [first, second] });
      const transport = yield* makeTransport({ client: daemon.client });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.accepted, 1, "the first key pair is pinned");
      assert.strictEqual(status.rejections.keyContinuity, 1);
      assert.isTrue(Option.isSome(yield* store.getInbound(firstId)));
      assert.isTrue(
        Option.isNone(yield* store.getInbound(secondId)),
        "a rotated encryption key must not reach the inbox",
      );
      assert.deepEqual([...consumedIds(daemon.calls)].sort(), [firstId, secondId].sort());
    }),
  );

  it.effect("refuses to publish a sealed wrapper over the 200 000 byte wire ceiling", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const local = yield* makeIdentity(WORKSPACE);
      const peer = yield* makeIdentity(WORKSPACE);

      // Pin the peer first, so the oversized envelope takes the SEALED path.
      const inboundId = envelopeId("seal-big-in-01");
      const daemon = makeFakeDaemon({
        seed: [
          yield* remoteDocument({
            identity: peer,
            envelopeId: inboundId,
            kind: "message",
            payload: messagePayload({
              envelopeId: inboundId,
              source: remoteAddress,
              target: localAddress,
            }),
          }),
        ],
      });
      const transport = yield* makeTransport({
        client: daemon.client,
        identity: Effect.succeed(local),
      });
      yield* transport.runCycle;

      const id = envelopeId("seal-big-out-1");
      // 256 near-maximal scope paths: a delegation the contracts accept in full
      // whose payload alone is larger than CTOX will take in `payload_json`.
      const oversized = delegationPayload({
        envelopeId: id,
        delegationId: delegationId("seal-big-out-1"),
        source: localAddress,
        target: remoteAddress,
        files: Array.from({ length: 256 }, (_, index) =>
          WorkjetRepositoryPath.make(
            `apps/server/${String(index).padStart(4, "0")}/${"f".repeat(900)}.ts`,
          ),
        ),
      });
      yield* outboundTo({ identity: local, store, envelopeId: id, payload: oversized });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.payloadTooLarge, 1);
      assert.strictEqual(status.counters.pushFailures, 1);
      assert.strictEqual(status.counters.pushed, 0);
      assert.strictEqual(status.counters.sealed, 0, "nothing oversized reaches the wire");
      assert.deepEqual(callsTo(daemon.calls, "/workjet/mailbox/publish"), []);

      // It stays retryable and walks the ordinary attempt budget rather than
      // vanishing behind the operator's back.
      const outbound = Option.getOrThrow(yield* store.getOutbound(id));
      assert.strictEqual(outbound.state, "pending");
      assert.strictEqual(outbound.attemptCount, 1);
    }),
  );
});

// ===============================
// SNAPSHOT TRANSFER
// ===============================

group("WorkjetMailboxTransport snapshot transfer", (it) => {
  const PROMPT_TEXT = "Implement the cross-machine snapshot transfer.\nBounded, sealed, verified.";

  it.effect("attaches sealed snapshot bytes to a cross-environment delegation", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const snapshots = yield* WorkjetSnapshotStore;
      const local = yield* makeIdentity(WORKSPACE);
      const peer = yield* makeIdentity(WORKSPACE);

      // Pin the peer so the outbound delegation takes the SEALED path.
      const inboundId = envelopeId("snap-attach-in");
      const daemon = makeFakeDaemon({
        seed: [
          yield* remoteDocument({
            identity: peer,
            envelopeId: inboundId,
            kind: "message",
            payload: messagePayload({
              envelopeId: inboundId,
              source: remoteAddress,
              target: localAddress,
            }),
          }),
        ],
      });
      const transport = yield* makeTransport({
        client: daemon.client,
        identity: Effect.succeed(local),
      });
      yield* transport.runCycle;

      // The source machine holds the prompt snapshot in its own store.
      const stored = yield* snapshots.put(PROMPT_TEXT);
      const id = envelopeId("snap-attach-01");
      const payload = delegationPayload({
        envelopeId: id,
        delegationId: delegationId("snap-attach-01"),
        source: localAddress,
        target: remoteAddress,
        prompt: { schemaVersion: 1, ...stored },
      });
      yield* outboundTo({ identity: local, store, envelopeId: id, payload });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.snapshotAttached, 1);
      assert.strictEqual(status.counters.snapshotOversized, 0);
      assert.strictEqual(
        status.counters.sealed,
        1,
        "the bytes travel sealed, like everything else",
      );
      assert.strictEqual(status.counters.pushed, 1);

      // The bytes are inside the sealed blob and unreadable to the daemon.
      const wrapper = publishedWrapper(daemon.calls);
      assert.isDefined(wrapper.body.sealed);
      assert.notInclude(JSON.stringify(wrapper.body.sealed), PROMPT_TEXT);
      const opened = yield* peer.openSealed(wrapper.body.sealed!, id);
      const decoded = JSON.parse(new TextDecoder().decode(opened)) as {
        readonly _tag: string;
        readonly snapshotBytes?: string;
        readonly delegation: { readonly prompt: { readonly digest: string } };
      };
      assert.strictEqual(decoded._tag, "delegation");
      assert.strictEqual(decoded.snapshotBytes, PROMPT_TEXT);
      assert.strictEqual(decoded.delegation.prompt.digest, stored.digest);
    }),
  );

  it.effect("stores received snapshot bytes and makes the delegation executable", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const snapshots = yield* WorkjetSnapshotStore;
      const local = yield* makeIdentity(WORKSPACE);
      const peer = yield* makeIdentity(WORKSPACE);

      const prompt = promptRefFor(PROMPT_TEXT);
      const id = envelopeId("snap-recv-01");
      const delegation = delegationId("snap-recv-01");
      // A sealed inbound delegation whose payload carries the snapshot bytes.
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "delegation",
        sealToKey: local.encryptionPublicKey,
        payload: {
          ...delegationPayload({
            envelopeId: id,
            delegationId: delegation,
            source: remoteAddress,
            target: localAddress,
            prompt,
          }),
          snapshotBytes: PROMPT_TEXT,
        } as WorkjetMailboxPayload,
      });
      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({
        client: daemon.client,
        identity: Effect.succeed(local),
      });

      // The prompt is NOT readable before the delegation arrives.
      assert.isTrue(Option.isNone(yield* snapshots.get(prompt.digest).pipe(Effect.option)));

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.accepted, 1);
      assert.strictEqual(status.counters.snapshotStored, 1);
      assert.strictEqual(status.rejections.snapshotDigest, 0);

      // The bytes are now in THIS machine's store, so the executor's
      // `resolvePrompt` would read them instead of skipping on `missingSnapshot`.
      assert.strictEqual(yield* snapshots.get(prompt.digest), PROMPT_TEXT);

      // The SAME reference-only lifecycle a local delegation produces.
      const record = Option.getOrThrow(yield* store.getDelegation(delegation));
      assert.strictEqual(record.state, "delivered");
      assert.strictEqual(record.delegation.prompt.digest, prompt.digest);
      assert.deepEqual(consumedIds(daemon.calls), [id]);
    }),
  );

  it.effect("rejects and consumes snapshot bytes that do not match the declared digest", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const snapshots = yield* WorkjetSnapshotStore;
      const peer = yield* makeIdentity(WORKSPACE);

      // The delegation DECLARES the digest of PROMPT_TEXT but carries different
      // bytes: a tampered or mispaired snapshot.
      const prompt = promptRefFor(PROMPT_TEXT);
      const id = envelopeId("snap-mismatch-1");
      const delegation = delegationId("snap-mismatch-1");
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "delegation",
        payload: {
          ...delegationPayload({
            envelopeId: id,
            delegationId: delegation,
            source: remoteAddress,
            target: localAddress,
            prompt,
          }),
          snapshotBytes: "these bytes do not hash to the declared digest",
        } as WorkjetMailboxPayload,
      });
      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({ client: daemon.client });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.accepted, 0);
      assert.strictEqual(status.counters.snapshotStored, 0);
      assert.strictEqual(status.rejections.snapshotDigest, 1);
      assert.isTrue(Option.isNone(yield* store.getInbound(id)), "nothing durable is written");
      assert.isTrue(
        Option.isNone(yield* store.getDelegation(delegation)),
        "no delegation row for a poison snapshot",
      );
      // The declared digest is still empty: the mismatched bytes never satisfy it.
      assert.isTrue(Option.isNone(yield* snapshots.get(prompt.digest).pipe(Effect.option)));
      // Poison envelopes are consumed, like every other rejection.
      assert.deepEqual(consumedIds(daemon.calls), [id]);
    }),
  );

  it.effect("ships an oversized snapshot reference-only with a marker", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const snapshots = yield* WorkjetSnapshotStore;
      const local = yield* makeIdentity(WORKSPACE);
      const peer = yield* makeIdentity(WORKSPACE);

      // Pin the peer so the delegation takes the SEALED path.
      const inboundId = envelopeId("snap-big-in-01");
      const daemon = makeFakeDaemon({
        seed: [
          yield* remoteDocument({
            identity: peer,
            envelopeId: inboundId,
            kind: "message",
            payload: messagePayload({
              envelopeId: inboundId,
              source: remoteAddress,
              target: localAddress,
            }),
          }),
        ],
      });
      const transport = yield* makeTransport({
        client: daemon.client,
        identity: Effect.succeed(local),
      });
      yield* transport.runCycle;

      // A snapshot that fits the store's 8 MiB cap but not the 200 000-byte wire.
      const bigText = "p".repeat(210_000);
      const stored = yield* snapshots.put(bigText);
      const id = envelopeId("snap-big-out-01");
      const payload = delegationPayload({
        envelopeId: id,
        delegationId: delegationId("snap-big-out-01"),
        source: localAddress,
        target: remoteAddress,
        prompt: { schemaVersion: 1, ...stored },
      });
      yield* outboundTo({ identity: local, store, envelopeId: id, payload });

      const status = yield* transport.runCycle;

      // Never a silent publish failure: it goes reference-only, not too-large.
      assert.strictEqual(status.counters.snapshotOversized, 1);
      assert.strictEqual(status.counters.snapshotAttached, 0);
      assert.strictEqual(status.counters.payloadTooLarge, 0);
      assert.strictEqual(status.counters.pushed, 1);
      assert.strictEqual(status.counters.sealed, 1);

      // The wire carries the reference and the marker, never the bytes.
      const wrapper = publishedWrapper(daemon.calls);
      assert.isDefined(wrapper.body.sealed);
      const opened = yield* peer.openSealed(wrapper.body.sealed!, id);
      const decoded = JSON.parse(new TextDecoder().decode(opened)) as {
        readonly snapshotBytes?: string;
        readonly snapshotOversized?: boolean;
      };
      assert.isUndefined(decoded.snapshotBytes);
      assert.strictEqual(decoded.snapshotOversized, true);
    }),
  );

  it.effect("leaves an oversized-marked inbound delegation delivered with a bounded reason", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const snapshots = yield* WorkjetSnapshotStore;
      const peer = yield* makeIdentity(WORKSPACE);

      const prompt = promptRefFor("a snapshot too large to have travelled");
      const id = envelopeId("snap-ovr-recv-1");
      const delegation = delegationId("snap-ovr-recv-1");
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "delegation",
        payload: {
          ...delegationPayload({
            envelopeId: id,
            delegationId: delegation,
            source: remoteAddress,
            target: localAddress,
            prompt,
          }),
          snapshotOversized: true,
        } as WorkjetMailboxPayload,
      });
      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({ client: daemon.client });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.accepted, 1);
      assert.strictEqual(status.counters.snapshotOversizedReceived, 1);
      assert.strictEqual(status.counters.snapshotStored, 0);
      // Accepted and delivered — never dropped — but the prompt is still absent,
      // so the executor will wait on `missingSnapshot` rather than run it.
      assert.strictEqual(
        Option.getOrThrow(yield* store.getDelegation(delegation)).state,
        "delivered",
      );
      assert.isTrue(Option.isNone(yield* snapshots.get(prompt.digest).pipe(Effect.option)));
      assert.deepEqual(consumedIds(daemon.calls), [id]);
    }),
  );

  it.effect("re-receiving snapshot bytes is an idempotent no-op", () =>
    Effect.gen(function* () {
      const snapshots = yield* WorkjetSnapshotStore;
      const local = yield* makeIdentity(WORKSPACE);
      const peer = yield* makeIdentity(WORKSPACE);

      const prompt = promptRefFor(PROMPT_TEXT);
      const id = envelopeId("snap-idem-01");
      const delegation = delegationId("snap-idem-01");
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "delegation",
        sealToKey: local.encryptionPublicKey,
        payload: {
          ...delegationPayload({
            envelopeId: id,
            delegationId: delegation,
            source: remoteAddress,
            target: localAddress,
            prompt,
          }),
          snapshotBytes: PROMPT_TEXT,
        } as WorkjetMailboxPayload,
      });
      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({
        client: daemon.client,
        identity: Effect.succeed(local),
      });

      const first = yield* transport.runCycle;
      assert.strictEqual(first.counters.snapshotStored, 1);

      // The daemon "forgets" the consumption and re-delivers the same document.
      daemon.consumed.clear();
      const second = yield* transport.runCycle;

      assert.strictEqual(second.counters.inboundDuplicates, 1);
      assert.strictEqual(second.counters.snapshotStored, 1, "a replay must not re-count the store");
      assert.strictEqual(yield* snapshots.get(prompt.digest), PROMPT_TEXT);
    }),
  );

  it.effect("leaves a plain message envelope entirely unaffected", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const local = yield* makeIdentity(WORKSPACE);

      const id = envelopeId("snap-msg-out-01");
      yield* outboundTo({
        identity: local,
        store,
        envelopeId: id,
        payload: messagePayload({ envelopeId: id, source: localAddress, target: remoteAddress }),
      });
      const daemon = makeFakeDaemon();
      const transport = yield* makeTransport({
        client: daemon.client,
        identity: Effect.succeed(local),
      });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.pushed, 1);
      assert.strictEqual(status.counters.snapshotAttached, 0);
      assert.strictEqual(status.counters.snapshotOversized, 0);
      assert.strictEqual(status.counters.snapshotStored, 0);
      // A message wrapper never grows a snapshot field.
      const wrapper = publishedWrapper(daemon.calls);
      assert.strictEqual((wrapper.body.plain as { _tag: string })._tag, "message");
      assert.notProperty(wrapper.body.plain, "snapshotBytes");
    }),
  );
});
