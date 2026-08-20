// @effect-diagnostics preferSchemaOverJson:off -- the fake daemon is a WIRE stand-in: it must read and write the same raw JSON strings the real CTOX routes exchange, so encoding through a schema here would stop testing the wire.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  WorkjetHandoffId,
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
import type { WorkjetMailboxAuditEventInput } from "./WorkjetMailboxAuditEmitter.ts";
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
  WORKJET_TRANSPORT_SEALED_FIELD_MAX_CHARS,
  type CtoxDaemonEndpoint,
  type WorkjetMailboxTransportSources,
} from "./WorkjetMailboxTransport.ts";
import {
  canonicalKeyBindingBytes,
  makeWorkjetMeshIdentity,
  WorkjetMeshIdentity,
} from "./WorkjetMeshIdentity.ts";

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
  /** Emit the pre-binding v2 wrapper: both keys, no proof of who chose them. */
  readonly legacyV2?: boolean;
  /**
   * The ENCRYPTION key the binding actually covers, when it must differ from
   * the one advertised. That divergence is the substitution attack: a room
   * member republishes an honest peer's envelope and its honest binding with
   * its own encryption key swapped in.
   */
  readonly bindEncryptionKey?: string;
  /** The envelope id the binding covers, for lifting a binding onto another. */
  readonly bindEnvelopeId?: string;
  /** The source environment id the binding covers, for a cross-address lift. */
  readonly bindEnvironmentId?: string;
  /** Who signs the binding. Defaults to the identity that signed the envelope. */
  readonly bindingSigner?: WorkjetMeshIdentity["Service"];
  /** Flip one character of the binding signature. */
  readonly tamperBinding?: boolean;
  /** Seal the payload to this X25519 key instead of sending it in the clear. */
  readonly sealToKey?: string;
  /** Seal under a DIFFERENT envelope id, to exercise the AAD binding. */
  readonly sealEnvelopeId?: string;
  readonly encryptionKeyOverride?: string;
  /**
   * The source environment the ENVELOPE is signed for. The key binding follows
   * it, so an override still produces a wholly self-consistent, correctly
   * signed document — the divergence under test is always somewhere else.
   */
  readonly sourceEnvironmentId?: string;
  /**
   * The target environment the ENVELOPE is signed for, independent of the
   * `target_environment_id` the daemon routes on. CTOX never reads the envelope,
   * so the two disagreeing is exactly what a misaddressed envelope looks like.
   */
  readonly targetEnvironmentId?: string;
}) =>
  Effect.gen(function* () {
    const sourceEnvironmentId = input.sourceEnvironmentId ?? REMOTE_ENVIRONMENT;
    const signed = yield* input.identity.signRoutingEnvelope({
      schemaVersion: 1,
      envelopeId: input.envelopeId,
      kind: input.kind,
      sourceWorkspaceId: WORKSPACE,
      sourceEnvironmentId: EnvironmentId.make(sourceEnvironmentId),
      targetWorkspaceId: WORKSPACE,
      targetEnvironmentId: EnvironmentId.make(input.targetEnvironmentId ?? LOCAL_ENVIRONMENT),
      createdAt: NOW,
      expiresAt: input.expiresAt ?? EXPIRES,
    });
    const signature = input.tamperSignature
      ? `${signed.signature.startsWith("A") ? "B" : "A"}${signed.signature.slice(1)}`
      : signed.signature;
    const envelope = { ...signed, signature };

    const senderSigningKey = input.publicKeyOverride ?? input.identity.publicKey;
    const senderEncryptionKey = input.encryptionKeyOverride ?? input.identity.encryptionPublicKey;

    const body =
      input.sealToKey === undefined
        ? { plain: input.payload, reason: "recipient-key-unknown" }
        : {
            sealed: yield* input.identity.sealTo(
              input.sealToKey,
              new TextEncoder().encode(JSON.stringify(input.payload)),
              input.sealEnvelopeId ?? input.envelopeId,
            ),
          };

    // The binding is built from the CLAIM the wrapper makes, so a default
    // document carries a self-consistent one and every attack shape is a
    // deliberate divergence between what is bound and what is advertised.
    const bindingSignature = yield* (input.bindingSigner ?? input.identity).sign(
      canonicalKeyBindingBytes({
        envelopeId: input.bindEnvelopeId ?? input.envelopeId,
        sourceWorkspaceId: WORKSPACE,
        sourceEnvironmentId: input.bindEnvironmentId ?? sourceEnvironmentId,
        senderSigningKey,
        senderEncryptionKey: input.bindEncryptionKey ?? senderEncryptionKey,
      }),
    );
    const keyBinding = input.tamperBinding
      ? `${bindingSignature.startsWith("A") ? "B" : "A"}${bindingSignature.slice(1)}`
      : bindingSignature;

    const wrapper = input.legacyV1
      ? {
          schemaVersion: 1,
          senderPublicKey: senderSigningKey,
          payload: input.payload,
        }
      : input.legacyV2
        ? { schemaVersion: 2, senderSigningKey, senderEncryptionKey, body }
        : { schemaVersion: 3, senderSigningKey, senderEncryptionKey, keyBinding, body };

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

    // The daemon's published identity rides along with the endpoint. The
    // mailbox transport ignores it; the cross-mode port verifies authority
    // against it, so resolving it here keeps ONE descriptor reader.
    assert.deepEqual(yield* resolve(descriptor("running", NOW_MILLIS - 1_000)), {
      _tag: "resolved",
      endpoint: { baseUrl: BASE_URL, instanceId: "ctox-local" },
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

    // An older daemon that publishes no identity is STILL a usable endpoint for
    // the mailbox; the field is simply absent, so a consumer that needs an
    // identity cannot mistake it for a match.
    assert.deepEqual(
      yield* resolve(
        JSON.stringify({
          version: 1,
          status: "running",
          lastSeenAt: NOW_MILLIS,
          healthUrl: "http://127.0.0.1:8788/health",
        }),
      ),
      { _tag: "resolved", endpoint: { baseUrl: BASE_URL } },
    );
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
      // A v3 wrapper carrying BOTH public keys and the key binding that proves
      // one holder chose both. This peer is unknown, so the payload travels in
      // the clear exactly once, with the reason on the wire.
      const wrapper = JSON.parse(document.payload_json) as {
        schemaVersion: number;
        senderSigningKey: string;
        senderEncryptionKey: string;
        keyBinding: string;
        body: { plain?: unknown; reason?: string };
      };
      assert.strictEqual(wrapper.schemaVersion, 3);
      assert.strictEqual(wrapper.senderSigningKey, identity.publicKey);
      assert.strictEqual(wrapper.senderEncryptionKey, identity.encryptionPublicKey);
      // The binding is present even on the plaintext first-contact envelope:
      // that envelope is exactly the one whose keys get pinned, so it is the
      // one that most needs to prove who chose them.
      assert.isTrue(
        yield* identity.verifyKeyBinding(
          {
            envelopeId: id,
            sourceWorkspaceId: envelope.sourceWorkspaceId,
            sourceEnvironmentId: envelope.sourceEnvironmentId,
            senderSigningKey: identity.publicKey,
            senderEncryptionKey: identity.encryptionPublicKey,
          },
          wrapper.keyBinding,
        ),
      );
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

  it.effect("emits a redacted mesh-replication-error when a push fails", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const daemon = makeFakeDaemon({ publishStatus: 500 });
      const identity = yield* makeIdentity(WORKSPACE);
      const events: Array<WorkjetMailboxAuditEventInput> = [];
      const transport = yield* makeTransport({
        client: daemon.client,
        identity: Effect.succeed(identity),
        sources: {
          audit: {
            emit: (event) => {
              events.push(event);
              return Effect.void;
            },
          },
        },
      });

      const id = envelopeId("push-audit-001");
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

      yield* transport.runCycle;

      const replicationErrors = events.filter((event) => event._tag === "mesh-replication-error");
      assert.strictEqual(replicationErrors.length, 1);
      const error = replicationErrors[0];
      if (error?._tag !== "mesh-replication-error")
        return assert.fail("expected a replication error");
      assert.strictEqual(error.envelopeId, id);
      assert.strictEqual(error.reasonCode, "publish-failed");
      // A single failed attempt is not yet a dead-letter.
      assert.isFalse(events.some((event) => event._tag === "envelope-dead-lettered"));
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
  /** The routing kind a forwarding peer reads; defaults to a plain message. */
  readonly kind?: WorkjetRoutingEnvelope["kind"];
}) =>
  Effect.gen(function* () {
    const envelope = yield* input.identity.signRoutingEnvelope({
      schemaVersion: 1,
      envelopeId: input.envelopeId,
      kind: input.kind ?? "message",
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

// ===============================
// Peer key binding
// ===============================

/**
 * The identity-binding half of the trust model (docs/workjet-plan.md → Wave 5
 * security follow-up). Every test here is an attack shape or the accept path it
 * bounds, and each one names the concrete capability an in-room attacker gains
 * if the check regresses.
 */
group("WorkjetMailboxTransport peer key binding", (it) => {
  /** Collects the redacted audit events one cycle emitted. */
  const capturing = () => {
    const events: Array<WorkjetMailboxAuditEventInput> = [];
    return {
      events,
      sink: {
        emit: (event: WorkjetMailboxAuditEventInput) => {
          events.push(event);
          return Effect.void;
        },
      },
    };
  };

  const bindingRejections = (events: ReadonlyArray<WorkjetMailboxAuditEventInput>) =>
    events.filter((event) => event._tag === "mesh-peer-binding-rejected");

  it.effect("pins a peer as self-signed when its wrapper carries a valid binding", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);

      const id = envelopeId("bind-ok-000001");
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "message",
        payload: messagePayload({ envelopeId: id, source: remoteAddress, target: localAddress }),
      });

      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({ client: daemon.client });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.accepted, 1);
      assert.strictEqual(status.counters.bindingVerified, 1);
      assert.strictEqual(status.counters.bindingAbsent, 0);
      assert.strictEqual(status.rejections.keyBinding, 0);
      assert.isTrue(Option.isSome(yield* store.getInbound(id)));

      // The trust level is DURABLE and reaches the roster, not just a counter.
      const page = yield* store.listMeshPeers(10);
      assert.strictEqual(page.peers.length, 1);
      assert.strictEqual(page.peers[0]?.binding, "self-signed");
      assert.isTrue(page.peers[0]?.sealedDeliveryReady);
    }),
  );

  it.effect("pins a v2 peer as tofu and says so rather than implying it is bound", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);

      const id = envelopeId("bind-v2-000001");
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "message",
        legacyV2: true,
        payload: messagePayload({ envelopeId: id, source: remoteAddress, target: localAddress }),
      });

      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({ client: daemon.client });

      const status = yield* transport.runCycle;

      // Accepting a migration-window peer is deliberate; MISLABELLING it would
      // not be. The envelope lands, and the pin records what it really is.
      assert.strictEqual(status.counters.accepted, 1);
      assert.strictEqual(status.counters.bindingAbsent, 1);
      assert.strictEqual(status.counters.bindingVerified, 0);
      assert.isTrue(Option.isSome(yield* store.getInbound(id)));
      const page = yield* store.listMeshPeers(10);
      assert.strictEqual(page.peers[0]?.binding, "tofu");
    }),
  );

  it.effect("refuses a first-contact wrapper whose encryption key the signer never bound", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);
      const attacker = yield* makeIdentity(WORKSPACE);

      // THE substitution attack. `payload_json` is covered by no signature,
      // so a room member republishes the honest peer's envelope and its
      // honest binding with its OWN encryption key advertised. Pinning that
      // pair would seal every later reply to this peer to the attacker.
      const id = envelopeId("bind-sub-00001");
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "message",
        encryptionKeyOverride: attacker.encryptionPublicKey,
        bindEncryptionKey: peer.encryptionPublicKey,
        payload: messagePayload({ envelopeId: id, source: remoteAddress, target: localAddress }),
      });

      const captured = capturing();
      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({
        client: daemon.client,
        sources: { audit: captured.sink },
      });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.accepted, 0);
      assert.strictEqual(status.rejections.keyBinding, 1);
      assert.strictEqual(status.rejections.keyContinuity, 0, "this is a binding failure");
      assert.isTrue(Option.isNone(yield* store.getInbound(id)));
      // NOTHING was pinned: a refused claim must not leave a row behind that
      // a second attempt could then match against.
      assert.strictEqual((yield* store.listMeshPeers(10)).peers.length, 0);
      // Poison is consumed, or every cycle re-reads it forever.
      assert.deepEqual([...consumedIds(daemon.calls)], [id as string]);

      const audited = bindingRejections(captured.events);
      assert.strictEqual(audited.length, 1);
      assert.deepInclude(audited[0], {
        _tag: "mesh-peer-binding-rejected",
        envelopeId: id,
        sourceWorkspaceId: WORKSPACE,
        sourceEnvironmentId: REMOTE_ENVIRONMENT,
        reasonCode: "binding-invalid",
      });
      // Redaction: an audit event never carries key material.
      const serialized = JSON.stringify(captured.events);
      assert.notInclude(serialized, attacker.encryptionPublicKey);
      assert.notInclude(serialized, peer.publicKey);
    }),
  );

  it.effect("refuses a binding lifted from another envelope of the same peer", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);

      // A genuine signature by the right key over the right keys — but for a
      // DIFFERENT envelope. Without the envelope id in the claim, one honest
      // binding would authorise every document an attacker cares to publish.
      const id = envelopeId("bind-lift-0001");
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "message",
        bindEnvelopeId: "wjm-transport-bind-lift-0002",
        payload: messagePayload({ envelopeId: id, source: remoteAddress, target: localAddress }),
      });

      const captured = capturing();
      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({
        client: daemon.client,
        sources: { audit: captured.sink },
      });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.rejections.keyBinding, 1);
      assert.strictEqual(status.counters.accepted, 0);
      assert.isTrue(Option.isNone(yield* store.getInbound(id)));
      assert.strictEqual(bindingRejections(captured.events).length, 1);
    }),
  );

  it.effect("refuses a binding that names a different source environment", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);

      // The mesh address is part of the claim, so a binding a peer signed for
      // the environment id it really owns cannot be re-pointed at another one.
      const id = envelopeId("bind-addr-0001");
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "message",
        bindEnvironmentId: "environment-somewhere-else",
        payload: messagePayload({ envelopeId: id, source: remoteAddress, target: localAddress }),
      });

      const captured = capturing();
      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({
        client: daemon.client,
        sources: { audit: captured.sink },
      });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.rejections.keyBinding, 1);
      assert.isTrue(Option.isNone(yield* store.getInbound(id)));
      assert.strictEqual(bindingRejections(captured.events).length, 1);
    }),
  );

  it.effect("refuses a binding signed by a key other than the envelope's signer", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);
      const attacker = yield* makeIdentity(WORKSPACE);

      // Verification is against the key the ENVELOPE verified against, never
      // against whatever key the binding would like to be checked with.
      const id = envelopeId("bind-signer-001");
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "message",
        bindingSigner: attacker,
        payload: messagePayload({ envelopeId: id, source: remoteAddress, target: localAddress }),
      });

      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({ client: daemon.client });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.rejections.keyBinding, 1);
      assert.isTrue(Option.isNone(yield* store.getInbound(id)));
    }),
  );

  it.effect("refuses a tampered binding signature", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);

      const id = envelopeId("bind-tamper-01");
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "message",
        tamperBinding: true,
        payload: messagePayload({ envelopeId: id, source: remoteAddress, target: localAddress }),
      });

      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({ client: daemon.client });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.rejections.keyBinding, 1);
      assert.isTrue(Option.isNone(yield* store.getInbound(id)));
    }),
  );

  it.effect("refuses to downgrade a self-signed peer back to bare first-use trust", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);

      const firstId = envelopeId("bind-down-0001");
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

      // The SAME keys, the same signer, a valid envelope — with the binding
      // simply stripped. If this were accepted, an attacker would strip the
      // field and be back to the substitution the binding exists to stop.
      const secondId = envelopeId("bind-down-0002");
      const second = yield* remoteDocument({
        identity: peer,
        envelopeId: secondId,
        kind: "message",
        legacyV2: true,
        payload: messagePayload({
          envelopeId: secondId,
          source: remoteAddress,
          target: localAddress,
        }),
      });

      const captured = capturing();
      const daemon = makeFakeDaemon({ seed: [first, second] });
      const transport = yield* makeTransport({
        client: daemon.client,
        sources: { audit: captured.sink },
      });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.accepted, 1, "only the bound envelope lands");
      assert.strictEqual(status.rejections.keyBinding, 1);
      assert.isTrue(Option.isSome(yield* store.getInbound(firstId)));
      assert.isTrue(Option.isNone(yield* store.getInbound(secondId)));
      // The pin keeps the level it earned.
      assert.strictEqual((yield* store.listMeshPeers(10)).peers[0]?.binding, "self-signed");

      const audited = bindingRejections(captured.events);
      assert.strictEqual(audited.length, 1);
      assert.deepInclude(audited[0], { reasonCode: "binding-downgrade" });
    }),
  );

  it.effect("upgrades a tofu pin to self-signed when the same keys arrive bound", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);

      const firstId = envelopeId("bind-up-000001");
      const first = yield* remoteDocument({
        identity: peer,
        envelopeId: firstId,
        kind: "message",
        legacyV2: true,
        payload: messagePayload({
          envelopeId: firstId,
          source: remoteAddress,
          target: localAddress,
        }),
      });
      const secondId = envelopeId("bind-up-000002");
      const second = yield* remoteDocument({
        identity: peer,
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

      // Upgrading is safe in the way downgrading is not: identical key
      // material, now with evidence attached. Both envelopes land.
      assert.strictEqual(status.counters.accepted, 2);
      assert.strictEqual(status.rejections.keyBinding, 0);
      assert.strictEqual(status.counters.bindingAbsent, 1);
      assert.strictEqual(status.counters.bindingVerified, 1);
      assert.strictEqual((yield* store.listMeshPeers(10)).peers[0]?.binding, "self-signed");
    }),
  );

  it.effect("audits a conflicting re-pin attempt instead of only counting it", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);
      const impostor = yield* makeIdentity(WORKSPACE);

      const firstId = envelopeId("bind-conf-0001");
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

      // A different room member, holding a keypair it genuinely owns and
      // signing a perfectly valid binding, claiming the SAME mesh address. The
      // binding verifies; continuity is what refuses it.
      const secondId = envelopeId("bind-conf-0002");
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

      const captured = capturing();
      const daemon = makeFakeDaemon({ seed: [first, second] });
      const transport = yield* makeTransport({
        client: daemon.client,
        sources: { audit: captured.sink },
      });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.accepted, 1);
      assert.strictEqual(status.rejections.keyContinuity, 1);
      assert.isTrue(Option.isNone(yield* store.getInbound(secondId)));

      const audited = bindingRejections(captured.events);
      assert.strictEqual(audited.length, 1);
      assert.deepInclude(audited[0], {
        reasonCode: "signing-key-conflict",
        sourceEnvironmentId: REMOTE_ENVIRONMENT,
      });
      // The contested ADDRESS is the operator's signal; the keys are not.
      assert.notInclude(JSON.stringify(captured.events), impostor.publicKey);
    }),
  );

  it.effect("still refuses a forged signature before any binding is even looked at", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);

      // Key POSSESSION on first contact: a peer cannot pin a signing key it
      // does not hold, because the envelope is verified against that key first.
      // A valid-looking binding does not rescue a broken signature.
      const id = envelopeId("bind-forge-001");
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "message",
        tamperSignature: true,
        payload: messagePayload({ envelopeId: id, source: remoteAddress, target: localAddress }),
      });

      const captured = capturing();
      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({
        client: daemon.client,
        sources: { audit: captured.sink },
      });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.rejections.signature, 1);
      assert.strictEqual(status.rejections.keyBinding, 0);
      assert.strictEqual((yield* store.listMeshPeers(10)).peers.length, 0);
      assert.isTrue(Option.isNone(yield* store.getInbound(id)));
      // A signature failure is not a binding dispute and must not be audited
      // as one, or the binding-rejection signal stops meaning anything.
      assert.strictEqual(bindingRejections(captured.events).length, 0);
    }),
  );
});

group("WorkjetMailboxTransport thread handoff", (it) => {
  const SNAPSHOT_TEXT =
    "# Workjet thread handoff\nSource thread: Transport slice\n\n### user\n\nContinue here.";

  const handoffPayload = (input: {
    readonly envelopeId: WorkjetEnvelopeId;
    readonly handoffId: string;
    readonly source: WorkjetWorkerAddress;
    readonly targetEnvironmentId: EnvironmentId;
    readonly contextSnapshot: WorkjetPromptSnapshotRef;
  }): WorkjetMailboxPayload => ({
    _tag: "handoff",
    handoff: {
      schemaVersion: 1,
      envelopeId: input.envelopeId,
      handoffId: WorkjetHandoffId.make(input.handoffId),
      sourceThread: input.source,
      target: {
        schemaVersion: 1,
        workspaceId: WORKSPACE,
        environmentId: input.targetEnvironmentId,
      },
      createdAt: NOW,
      expiresAt: EXPIRES,
      contextSnapshot: input.contextSnapshot,
      artifacts: { schemaVersion: 1, commitHashes: [], paths: [] },
      note: "Continue the transport slice here.",
    },
  });

  it.effect("attaches sealed snapshot bytes to a cross-environment handoff", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const snapshots = yield* WorkjetSnapshotStore;
      const local = yield* makeIdentity(WORKSPACE);
      const peer = yield* makeIdentity(WORKSPACE);

      // Pin the peer first so the outbound handoff takes the SEALED path.
      const inboundId = envelopeId("hnd-attach-in");
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

      const stored = yield* snapshots.put(SNAPSHOT_TEXT);
      const id = envelopeId("hnd-attach-01");
      const payload = handoffPayload({
        envelopeId: id,
        handoffId: "wjh-0123456789abcdef",
        source: localAddress,
        targetEnvironmentId: remoteAddress.environmentId,
        contextSnapshot: { schemaVersion: 1, ...stored },
      });
      yield* outboundTo({ identity: local, store, envelopeId: id, payload, kind: "handoff" });

      const status = yield* transport.runCycle;

      // A handoff's context snapshot travels exactly like a delegation prompt.
      assert.strictEqual(status.counters.snapshotAttached, 1);
      assert.strictEqual(status.counters.snapshotOversized, 0);
      assert.strictEqual(status.counters.sealed, 1);
      assert.strictEqual(status.counters.pushed, 1);

      const wrapper = publishedWrapper(daemon.calls);
      assert.isDefined(wrapper.body.sealed);
      // The daemon forwards the blob and can read none of it.
      assert.notInclude(JSON.stringify(wrapper.body.sealed), SNAPSHOT_TEXT);
      const opened = yield* peer.openSealed(wrapper.body.sealed!, id);
      const decoded = JSON.parse(new TextDecoder().decode(opened)) as {
        readonly _tag: string;
        readonly snapshotBytes?: string;
        readonly handoff: { readonly contextSnapshot: { readonly digest: string } };
      };
      assert.strictEqual(decoded._tag, "handoff");
      assert.strictEqual(decoded.snapshotBytes, SNAPSHOT_TEXT);
      assert.strictEqual(decoded.handoff.contextSnapshot.digest, stored.digest);
    }),
  );

  it.effect("stores received handoff bytes and records one continuable inbox row", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const snapshots = yield* WorkjetSnapshotStore;
      const local = yield* makeIdentity(WORKSPACE);
      const peer = yield* makeIdentity(WORKSPACE);

      const contextSnapshot = promptRefFor(SNAPSHOT_TEXT);
      const id = envelopeId("hnd-recv-01");
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "handoff",
        sealToKey: local.encryptionPublicKey,
        payload: {
          ...handoffPayload({
            envelopeId: id,
            handoffId: "wjh-0123456789abcdef",
            source: remoteAddress,
            targetEnvironmentId: localAddress.environmentId,
            contextSnapshot,
          }),
          snapshotBytes: SNAPSHOT_TEXT,
        } as WorkjetMailboxPayload,
      });
      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({
        client: daemon.client,
        identity: Effect.succeed(local),
      });

      assert.isTrue(
        Option.isNone(yield* snapshots.get(contextSnapshot.digest).pipe(Effect.option)),
      );

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.accepted, 1);
      assert.strictEqual(status.counters.snapshotStored, 1);
      assert.strictEqual(status.rejections.snapshotDigest, 0);

      // The context is readable HERE, which is what makes "Continue here" real.
      assert.strictEqual(yield* snapshots.get(contextSnapshot.digest), SNAPSHOT_TEXT);

      const received = yield* store.listReceivedHandoffs(10);
      assert.lengthOf(received, 1);
      assert.strictEqual(received[0]?.handoff.sourceThread.threadId, remoteAddress.threadId);
      assert.isNull(received[0]?.acceptedThreadId ?? null);
      // The persisted envelope stays REFERENCE-ONLY: the bytes live in the
      // snapshot store, exactly as on the local fast path.
      const inbound = Option.getOrThrow(yield* store.getInbound(id));
      assert.strictEqual(inbound.payload._tag, "handoff");
      if (inbound.payload._tag === "handoff") {
        assert.isUndefined(inbound.payload.snapshotBytes);
      }
      assert.deepEqual(consumedIds(daemon.calls), [id]);
    }),
  );

  it.effect("records a replayed handoff exactly once", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const local = yield* makeIdentity(WORKSPACE);
      const peer = yield* makeIdentity(WORKSPACE);

      const contextSnapshot = promptRefFor(SNAPSHOT_TEXT);
      const id = envelopeId("hnd-replay-01");
      const build = () =>
        remoteDocument({
          identity: peer,
          envelopeId: id,
          kind: "handoff",
          sealToKey: local.encryptionPublicKey,
          payload: {
            ...handoffPayload({
              envelopeId: id,
              handoffId: "wjh-0123456789abcdef",
              source: remoteAddress,
              targetEnvironmentId: localAddress.environmentId,
              contextSnapshot,
            }),
            snapshotBytes: SNAPSHOT_TEXT,
          } as WorkjetMailboxPayload,
        });
      const daemon = makeFakeDaemon({ seed: [yield* build(), yield* build()] });
      const transport = yield* makeTransport({
        client: daemon.client,
        identity: Effect.succeed(local),
      });

      yield* transport.runCycle;

      // At-least-once transport, exactly-once inbox effect: one offer, not two.
      assert.lengthOf(yield* store.listReceivedHandoffs(10), 1);
    }),
  );
});

// ==========================================================================
// Remote dispatch authentication
//
// Plan invariant 12: "Authenticate remote worker dispatch and prevent
// cross-environment authority escalation." Every test below is written so that
// it FAILS if the property it names is removed — the signature check, the
// locality check, the payload/envelope address binding, or the expiry gate.
// ==========================================================================

group("WorkjetMailboxTransport remote dispatch authentication", (it) => {
  const THIRD_ENVIRONMENT = EnvironmentId.make("environment-third");

  /** `NOW` plus exactly one millisecond, for the expiry boundary. */
  const ONE_MS_AFTER_NOW = "2026-08-19T12:00:00.001Z";

  const thirdAddress: WorkjetWorkerAddress = {
    schemaVersion: 1,
    workspaceId: WORKSPACE,
    environmentId: THIRD_ENVIRONMENT,
    threadId: ThreadId.make("thread-third"),
  };

  it.effect("refuses a correctly signed envelope that names another environment", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);
      const id = envelopeId("cross-env-00001");
      const delegation = delegationId("cross-env-00001");

      // The daemon routes on its own `target_environment_id` column and never
      // reads the envelope, so a peer (or a compromised daemon) can hand this
      // machine an envelope whose SIGNED target is somebody else entirely. The
      // signature is genuine; only the address is wrong.
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "delegation",
        targetEnvironmentId: THIRD_ENVIRONMENT,
        payload: delegationPayload({
          envelopeId: id,
          delegationId: delegation,
          source: remoteAddress,
          target: thirdAddress,
        }),
      });

      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({ client: daemon.client });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.accepted, 0);
      assert.strictEqual(status.rejections.misaddressed, 1);
      assert.isTrue(Option.isNone(yield* store.getInbound(id)), "no inbox row");
      assert.isTrue(Option.isNone(yield* store.getDelegation(delegation)), "no delegation row");
      // Refused BEFORE the sender was ever pinned: an envelope this machine does
      // not own must not teach it anything about the peer that sent it.
      assert.strictEqual(status.counters.bindingVerified, 0);
      assert.strictEqual(status.counters.bindingAbsent, 0);
      assert.deepEqual(consumedIds(daemon.calls), [id]);
    }),
  );

  it.effect("refuses a delegation whose claimed source is not the signer's environment", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);
      const id = envelopeId("claim-third-001");
      const delegation = delegationId("claim-third-001");

      // A fully authenticated peer, signing with its own pinned key for its own
      // address — but attributing the delegation to a THIRD environment. The
      // executor returns results to `delegation.source`, so accepting this would
      // make this machine sign and relay an unsolicited `result` envelope to an
      // environment that never asked for anything: a confused deputy.
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "delegation",
        payload: delegationPayload({
          envelopeId: id,
          delegationId: delegation,
          source: thirdAddress,
          target: localAddress,
        }),
      });

      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({ client: daemon.client });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.accepted, 0);
      assert.strictEqual(status.rejections.addressMismatch, 1);
      assert.isTrue(Option.isNone(yield* store.getInbound(id)));
      assert.isTrue(Option.isNone(yield* store.getDelegation(delegation)));
      assert.deepEqual(consumedIds(daemon.calls), [id]);
    }),
  );

  it.effect("refuses a delegation that claims THIS environment as its source", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);
      const id = envelopeId("claim-local-001");
      const delegation = delegationId("claim-local-001");

      // The sharper form of the same attack: naming the LOCAL environment as the
      // source sends the executor down its same-environment result path, which
      // appends a delegation-result activity onto whichever local thread the
      // remote peer picked — a remote write to a thread that was never a target.
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "delegation",
        payload: delegationPayload({
          envelopeId: id,
          delegationId: delegation,
          source: localAddress,
          target: localAddress,
        }),
      });

      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({ client: daemon.client });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.counters.accepted, 0);
      assert.strictEqual(status.rejections.addressMismatch, 1);
      assert.isTrue(Option.isNone(yield* store.getInbound(id)));
      assert.isTrue(Option.isNone(yield* store.getDelegation(delegation)));
    }),
  );

  it.effect("refuses a handoff whose claimed target environment is not this one", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);
      const id = envelopeId("claim-hoff-001");

      // The handoff variant of the target claim. The envelope is addressed here
      // and signed correctly; the handoff inside it says it belongs elsewhere.
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "handoff",
        payload: {
          _tag: "handoff",
          handoff: {
            schemaVersion: 1,
            envelopeId: id,
            handoffId: WorkjetHandoffId.make("wjh-abcdef0123456789"),
            sourceThread: remoteAddress,
            target: { schemaVersion: 1, workspaceId: WORKSPACE, environmentId: THIRD_ENVIRONMENT },
            createdAt: NOW,
            expiresAt: EXPIRES,
            contextSnapshot: promptRefFor("handoff context"),
            artifacts: { schemaVersion: 1, commitHashes: [], paths: [] },
          },
        },
      });

      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({ client: daemon.client });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.rejections.addressMismatch, 1);
      assert.isTrue(Option.isNone(yield* store.getInbound(id)));
      assert.lengthOf(yield* store.listReceivedHandoffs(10), 0);
    }),
  );

  it.effect("refuses a payload lifted onto an envelope with a different id", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);
      const id = envelopeId("claim-elsew-01");
      const other = envelopeId("claim-elsew-02");

      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "message",
        payload: messagePayload({
          envelopeId: other,
          source: remoteAddress,
          target: localAddress,
        }),
      });

      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({ client: daemon.client });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.rejections.addressMismatch, 1);
      assert.isTrue(Option.isNone(yield* store.getInbound(id)));
    }),
  );

  it.effect("refuses a validly signed but expired envelope before it opens the seal", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const local = yield* makeIdentity(WORKSPACE);
      const peer = yield* makeIdentity(WORKSPACE);
      const id = envelopeId("expiry-past-01");

      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "message",
        expiresAt: EXPIRED,
        sealToKey: local.encryptionPublicKey,
        payload: messagePayload({ envelopeId: id, source: remoteAddress, target: localAddress }),
      });

      const daemon = makeFakeDaemon({ seed: [document] });
      const transport = yield* makeTransport({
        client: daemon.client,
        identity: Effect.succeed(local),
      });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.rejections.expired, 1);
      assert.strictEqual(status.counters.accepted, 0);
      // The seal was never opened and the sender was never pinned: an expired
      // envelope buys a peer no state on this machine at all.
      assert.strictEqual(status.counters.unsealed, 0);
      assert.strictEqual(status.counters.bindingVerified, 0);
      assert.isTrue(Option.isNone(yield* store.getInbound(id)));
      assert.deepEqual(consumedIds(daemon.calls), [id]);
    }),
  );

  it.effect("treats the expiry instant itself as expired and one millisecond later as live", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);
      const atInstant = envelopeId("expiry-edge-01");
      const justAfter = envelopeId("expiry-edge-02");

      // `expiresAt === now` is expired (the check is `<=`); `now + 1ms` is not.
      // Pinning the boundary keeps a later `<` from silently widening the window.
      const documents = [
        yield* remoteDocument({
          identity: peer,
          envelopeId: atInstant,
          kind: "message",
          expiresAt: NOW,
          payload: messagePayload({
            envelopeId: atInstant,
            source: remoteAddress,
            target: localAddress,
          }),
        }),
        yield* remoteDocument({
          identity: peer,
          envelopeId: justAfter,
          kind: "message",
          expiresAt: ONE_MS_AFTER_NOW,
          payload: messagePayload({
            envelopeId: justAfter,
            source: remoteAddress,
            target: localAddress,
          }),
        }),
      ];

      const daemon = makeFakeDaemon({ seed: documents });
      const transport = yield* makeTransport({ client: daemon.client });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.rejections.expired, 1);
      assert.strictEqual(status.counters.accepted, 1);
      assert.isTrue(Option.isNone(yield* store.getInbound(atInstant)), "the instant is expired");
      assert.isTrue(Option.isSome(yield* store.getInbound(justAfter)), "one ms later is live");
    }),
  );

  it.effect("refuses a sealed field beyond the wrapper's one-mebibyte ceiling", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetMailboxStore;
      const peer = yield* makeIdentity(WORKSPACE);
      const id = envelopeId("oversize-in-01");

      // Nothing stops a peer pushing an arbitrarily large wrapper at this
      // machine — the 200 000-byte wire ceiling is an OUTBOUND check. The
      // wrapper schema is the inbound bound, and it is a bound only while the
      // sealed field stays capped.
      const document = yield* remoteDocument({
        identity: peer,
        envelopeId: id,
        kind: "message",
        payload: messagePayload({ envelopeId: id, source: remoteAddress, target: localAddress }),
      });
      // Two halves, because either alone is defeatable: the ceiling must be
      // ENFORCED, and the number itself must not drift upward.
      assert.isAtMost(
        WORKJET_TRANSPORT_SEALED_FIELD_MAX_CHARS,
        1_048_576,
        "the inbound sealed-field ceiling was widened",
      );
      const wrapper = JSON.parse(document.payload_json) as { body: unknown };
      const oversized = {
        ...wrapper,
        body: { sealed: "A".repeat(WORKJET_TRANSPORT_SEALED_FIELD_MAX_CHARS + 1) },
      };

      const daemon = makeFakeDaemon({
        seed: [{ ...document, payload_json: JSON.stringify(oversized) }],
      });
      const transport = yield* makeTransport({ client: daemon.client });

      const status = yield* transport.runCycle;

      assert.strictEqual(status.rejections.malformed, 1);
      assert.strictEqual(status.counters.accepted, 0);
      assert.isTrue(Option.isNone(yield* store.getInbound(id)));
      assert.deepEqual(consumedIds(daemon.calls), [id]);
    }),
  );
});
