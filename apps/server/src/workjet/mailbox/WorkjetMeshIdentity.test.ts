import { assert, it } from "@effect/vitest";
import { EnvironmentId, WorkjetEnvelopeId, WorkjetMeshWorkspaceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  canonicalRoutingEnvelopeBytes,
  makeWorkjetMeshIdentity,
  WORKJET_MESH_PRIVATE_KEY_SECRET,
  WORKJET_MESH_WORKSPACE_ID_PREFIX,
  WORKJET_MESH_WORKSPACE_ID_SECRET,
  WORKJET_ROUTING_ENVELOPE_SIGNING_DOMAIN,
  type WorkjetUnsignedRoutingEnvelope,
} from "./WorkjetMeshIdentity.ts";

/**
 * An in-memory stand-in for the file-backed secret store with the SAME
 * create-once semantics: `create` on an existing name fails exactly like the
 * `wx` open does, which is what the persistence tests below depend on.
 */
const makeMemorySecretStore = () => {
  const entries = new Map<string, Uint8Array>();
  const service = ServerSecretStore.ServerSecretStore.of({
    get: (name) => {
      const value = entries.get(name);
      return Effect.succeed(value === undefined ? Option.none() : Option.some(value));
    },
    set: (name, value) => Effect.sync(() => void entries.set(name, value)),
    create: (name, value) =>
      entries.has(name)
        ? Effect.fail(
            new ServerSecretStore.SecretStorePersistError({
              resource: `secret ${name}`,
              cause: new Error("exists"),
            }),
          )
        : Effect.sync(() => void entries.set(name, value)),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) => Effect.sync(() => void entries.delete(name)),
  });
  return { entries, service };
};

const identityFrom = (secrets: ServerSecretStore.ServerSecretStore["Service"]) =>
  makeWorkjetMeshIdentity().pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
  );

const unsignedEnvelope: WorkjetUnsignedRoutingEnvelope = {
  schemaVersion: 1,
  envelopeId: WorkjetEnvelopeId.make("wjm-00000000-0000-4000-8000-000000000001"),
  kind: "message",
  sourceWorkspaceId: WorkjetMeshWorkspaceId.make("workjet-mesh-source"),
  sourceEnvironmentId: EnvironmentId.make("environment-source"),
  targetWorkspaceId: WorkjetMeshWorkspaceId.make("workjet-mesh-target"),
  targetEnvironmentId: EnvironmentId.make("environment-target"),
  createdAt: "2026-08-19T12:00:00.000Z",
  expiresAt: "2026-08-19T13:00:00.000Z",
};

// ===============================
// Canonical serialization
// ===============================

it("serializes an unsigned envelope into one domain-separated, order-stable payload", () => {
  const canonical = new TextDecoder().decode(canonicalRoutingEnvelopeBytes(unsignedEnvelope));
  assert.isTrue(canonical.startsWith(`${WORKJET_ROUTING_ENVELOPE_SIGNING_DOMAIN}\n`));
  assert.equal(
    canonical,
    `${WORKJET_ROUTING_ENVELOPE_SIGNING_DOMAIN}\n{"schemaVersion":1,"envelopeId":"wjm-00000000-0000-4000-8000-000000000001","kind":"message","sourceWorkspaceId":"workjet-mesh-source","sourceEnvironmentId":"environment-source","targetWorkspaceId":"workjet-mesh-target","targetEnvironmentId":"environment-target","createdAt":"2026-08-19T12:00:00.000Z","expiresAt":"2026-08-19T13:00:00.000Z"}`,
  );

  // A differently keyed but equal input must produce identical bytes, and a
  // stray signature must not participate in the payload.
  const reordered = {
    expiresAt: unsignedEnvelope.expiresAt,
    createdAt: unsignedEnvelope.createdAt,
    targetEnvironmentId: unsignedEnvelope.targetEnvironmentId,
    targetWorkspaceId: unsignedEnvelope.targetWorkspaceId,
    sourceEnvironmentId: unsignedEnvelope.sourceEnvironmentId,
    sourceWorkspaceId: unsignedEnvelope.sourceWorkspaceId,
    kind: unsignedEnvelope.kind,
    envelopeId: unsignedEnvelope.envelopeId,
    schemaVersion: unsignedEnvelope.schemaVersion,
    signature: "aaaaaaaaaaaaaaaaaaaa",
  } satisfies WorkjetUnsignedRoutingEnvelope & { readonly signature: string };
  assert.deepEqual(
    canonicalRoutingEnvelopeBytes(reordered),
    canonicalRoutingEnvelopeBytes(unsignedEnvelope),
  );
});

// ===============================
// Persistence
// ===============================

it.effect("creates the keypair and workspace id once and reuses both afterwards", () =>
  Effect.gen(function* () {
    const store = makeMemorySecretStore();

    const first = yield* identityFrom(store.service);
    const second = yield* identityFrom(store.service);

    assert.equal(second.publicKey, first.publicKey);
    assert.equal(second.workspaceId, first.workspaceId);
    assert.isTrue(first.workspaceId.startsWith(WORKJET_MESH_WORKSPACE_ID_PREFIX));
    assert.match(first.publicKey, /^[A-Za-z0-9_-]{43}$/);

    // Both durable entries exist, and the private key never left the service.
    assert.isTrue(store.entries.has(WORKJET_MESH_PRIVATE_KEY_SECRET));
    assert.equal(
      new TextDecoder().decode(store.entries.get(WORKJET_MESH_WORKSPACE_ID_SECRET)),
      first.workspaceId,
    );
    assert.notInclude(Object.keys(first), "privateKey");

    // A signature made by the first instance verifies under the second.
    const signature = yield* first.sign(new TextEncoder().encode("payload"));
    assert.isTrue(
      yield* second.verify(new TextEncoder().encode("payload"), signature, second.publicKey),
    );
  }),
);

it.effect("gives two independent environments two distinct identities", () =>
  Effect.gen(function* () {
    const left = yield* identityFrom(makeMemorySecretStore().service);
    const right = yield* identityFrom(makeMemorySecretStore().service);

    assert.notEqual(left.publicKey, right.publicKey);
    assert.notEqual(left.workspaceId, right.workspaceId);
  }),
);

it.effect("refuses a persisted workspace id that violates the contract pattern", () =>
  Effect.gen(function* () {
    const store = makeMemorySecretStore();
    store.entries.set(WORKJET_MESH_WORKSPACE_ID_SECRET, new TextEncoder().encode("has spaces!"));

    const error = yield* identityFrom(store.service).pipe(Effect.flip);
    assert.equal(error._tag, "SecretStoreDecodeError");
  }),
);

// ===============================
// Sign / verify
// ===============================

it.effect("round-trips a detached envelope signature and rejects a tampered envelope", () =>
  Effect.gen(function* () {
    const identity = yield* identityFrom(makeMemorySecretStore().service);

    const signed = yield* identity.signRoutingEnvelope(unsignedEnvelope);
    assert.match(signed.signature, /^[A-Za-z0-9_-]{86}$/);
    assert.isTrue(yield* identity.verifyRoutingEnvelope(signed));
    assert.isTrue(yield* identity.verifyRoutingEnvelope(signed, identity.publicKey));

    // Every routed field is covered by the signature.
    for (const tampered of [
      { ...signed, targetEnvironmentId: EnvironmentId.make("environment-attacker") },
      { ...signed, sourceWorkspaceId: WorkjetMeshWorkspaceId.make("workjet-mesh-attacker") },
      { ...signed, envelopeId: WorkjetEnvelopeId.make("wjm-00000000-0000-4000-8000-000000000002") },
      { ...signed, kind: "delegation" as const },
      { ...signed, expiresAt: "2026-08-19T23:00:00.000Z" },
    ]) {
      assert.isFalse(yield* identity.verifyRoutingEnvelope(tampered));
    }

    // A different environment's key must not verify this environment's signature.
    const other = yield* identityFrom(makeMemorySecretStore().service);
    assert.isFalse(yield* identity.verifyRoutingEnvelope(signed, other.publicKey));
  }),
);

it.effect("returns false for malformed verify inputs instead of throwing", () =>
  Effect.gen(function* () {
    const identity = yield* identityFrom(makeMemorySecretStore().service);
    const bytes = new TextEncoder().encode("payload");
    const signature = yield* identity.sign(bytes);

    const malformed: ReadonlyArray<readonly [string, string]> = [
      ["", identity.publicKey],
      ["not base64url!!", identity.publicKey],
      ["a".repeat(86), identity.publicKey],
      [signature.slice(0, 40), identity.publicKey],
      [`${signature}AA`, identity.publicKey],
      [signature, ""],
      [signature, "not base64url!!"],
      [signature, "AAAA"],
      [signature, "a".repeat(600)],
      [signature, identity.publicKey.slice(0, 20)],
      [null as unknown as string, identity.publicKey],
      [signature, undefined as unknown as string],
    ];
    for (const [candidateSignature, candidateKey] of malformed) {
      assert.isFalse(yield* identity.verify(bytes, candidateSignature, candidateKey));
    }

    // The correct pair still verifies after all of the above.
    assert.isTrue(yield* identity.verify(bytes, signature, identity.publicKey));
    assert.isFalse(
      yield* identity.verify(new TextEncoder().encode("other"), signature, identity.publicKey),
    );
  }),
);
