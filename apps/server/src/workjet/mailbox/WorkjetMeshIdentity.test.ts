import { assert, it } from "@effect/vitest";
import { EnvironmentId, WorkjetEnvelopeId, WorkjetMeshWorkspaceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  canonicalKeyBindingBytes,
  canonicalRoutingEnvelopeBytes,
  makeWorkjetMeshIdentity,
  WORKJET_MESH_ENCRYPTION_KEY_SECRET,
  WORKJET_MESH_PRIVATE_KEY_SECRET,
  WORKJET_MESH_WORKSPACE_ID_PREFIX,
  WORKJET_MESH_WORKSPACE_ID_SECRET,
  WORKJET_MESH_KEY_BINDING_DOMAIN,
  WORKJET_ROUTING_ENVELOPE_SIGNING_DOMAIN,
  workjetMeshOverviewOf,
  workjetMeshRosterOf,
  type WorkjetSealedPayloadBlob,
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
    assert.equal(second.encryptionPublicKey, first.encryptionPublicKey);
    assert.isTrue(first.workspaceId.startsWith(WORKJET_MESH_WORKSPACE_ID_PREFIX));
    assert.match(first.publicKey, /^[A-Za-z0-9_-]{43}$/);
    assert.match(first.encryptionPublicKey, /^[A-Za-z0-9_-]{43}$/);

    // Signing and agreement are two DIFFERENT keys under two different entries;
    // one key doing both jobs is exactly what the split exists to prevent.
    assert.notEqual(first.encryptionPublicKey, first.publicKey);

    // Every durable entry exists, and no private key left the service.
    assert.isTrue(store.entries.has(WORKJET_MESH_PRIVATE_KEY_SECRET));
    assert.isTrue(store.entries.has(WORKJET_MESH_ENCRYPTION_KEY_SECRET));
    assert.notInclude(Object.keys(first), "encryptionPrivateKey");
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
    assert.notEqual(left.encryptionPublicKey, right.encryptionPublicKey);
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

// ===============================
// Seal / open
// ===============================

const ENVELOPE_ID = "wjm-seal-0000-0000-0000-000000000001";
const OTHER_ENVELOPE_ID = "wjm-seal-0000-0000-0000-000000000002";
const plaintext = (text: string) => new TextEncoder().encode(text);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

it.effect("round-trips a payload sealed to the recipient's encryption key", () =>
  Effect.gen(function* () {
    const sender = yield* identityFrom(makeMemorySecretStore().service);
    const recipient = yield* identityFrom(makeMemorySecretStore().service);

    const secret = "delegation payload the daemon must never read";
    const sealed = yield* sender.sealTo(
      recipient.encryptionPublicKey,
      plaintext(secret),
      ENVELOPE_ID,
    );

    // Every transported field is bounded base64url, and the blob carries no
    // plaintext of any kind.
    assert.match(sealed.ephemeralKey, /^[A-Za-z0-9_-]{43}$/);
    assert.match(sealed.nonce, /^[A-Za-z0-9_-]{16}$/);
    assert.match(sealed.ciphertext, /^[A-Za-z0-9_-]+$/);
    assert.notInclude(sealed.ciphertext, "delegation");

    assert.equal(text(yield* recipient.openSealed(sealed, ENVELOPE_ID)), secret);

    // The sender cannot read back what it sealed to somebody else, and neither
    // can a third environment in the same room.
    const bystander = yield* identityFrom(makeMemorySecretStore().service);
    for (const stranger of [sender, bystander]) {
      const error = yield* stranger.openSealed(sealed, ENVELOPE_ID).pipe(Effect.flip);
      assert.equal(error.reason, "invalid-signature");
    }

    // An empty payload is still a payload; it must not collapse into a
    // special case that skips authentication.
    const empty = yield* sender.sealTo(recipient.encryptionPublicKey, plaintext(""), ENVELOPE_ID);
    assert.equal(text(yield* recipient.openSealed(empty, ENVELOPE_ID)), "");
  }),
);

it.effect("binds a sealed blob to one envelope id through the AAD", () =>
  Effect.gen(function* () {
    const sender = yield* identityFrom(makeMemorySecretStore().service);
    const recipient = yield* identityFrom(makeMemorySecretStore().service);

    const sealed = yield* sender.sealTo(
      recipient.encryptionPublicKey,
      plaintext("bound to exactly one envelope"),
      ENVELOPE_ID,
    );

    // Lifting the blob onto ANY other envelope fails: this is what stops a
    // sealed payload from being replayed under a different target, expiry, or
    // kind while its own routing envelope stays validly signed.
    for (const wrongId of [OTHER_ENVELOPE_ID, "", `${ENVELOPE_ID} `, ENVELOPE_ID.toUpperCase()]) {
      const error = yield* recipient.openSealed(sealed, wrongId).pipe(Effect.flip);
      assert.equal(error.reason, "invalid-signature");
    }
    assert.isTrue(
      Option.isSome(yield* recipient.openSealed(sealed, ENVELOPE_ID).pipe(Effect.option)),
    );
  }),
);

it.effect("gives every seal a fresh ephemeral key, nonce, and ciphertext", () =>
  Effect.gen(function* () {
    const sender = yield* identityFrom(makeMemorySecretStore().service);
    const recipient = yield* identityFrom(makeMemorySecretStore().service);

    const same = "the identical plaintext, sealed twice";
    const first = yield* sender.sealTo(recipient.encryptionPublicKey, plaintext(same), ENVELOPE_ID);
    const second = yield* sender.sealTo(
      recipient.encryptionPublicKey,
      plaintext(same),
      ENVELOPE_ID,
    );

    // Equal plaintext to the same recipient under the same envelope id must
    // still produce nothing in common: no ciphertext equality oracle.
    assert.notEqual(first.ephemeralKey, second.ephemeralKey);
    assert.notEqual(first.nonce, second.nonce);
    assert.notEqual(first.ciphertext, second.ciphertext);

    assert.equal(text(yield* recipient.openSealed(first, ENVELOPE_ID)), same);
    assert.equal(text(yield* recipient.openSealed(second, ENVELOPE_ID)), same);
  }),
);

it.effect("refuses a tampered or malformed sealed blob with one bounded reason", () =>
  Effect.gen(function* () {
    const sender = yield* identityFrom(makeMemorySecretStore().service);
    const recipient = yield* identityFrom(makeMemorySecretStore().service);
    const sealed = yield* sender.sealTo(
      recipient.encryptionPublicKey,
      plaintext("authenticated encryption, not just encryption"),
      ENVELOPE_ID,
    );

    const flip = (value: string) => `${value.startsWith("A") ? "B" : "A"}${value.slice(1)}`;
    const candidates: ReadonlyArray<WorkjetSealedPayloadBlob> = [
      // A flipped ciphertext byte: GCM's tag, not a checksum, must catch it.
      { ...sealed, ciphertext: flip(sealed.ciphertext) },
      // Truncating the tag off must not decrypt "the rest" of the message.
      { ...sealed, ciphertext: sealed.ciphertext.slice(0, 4) },
      { ...sealed, ciphertext: "" },
      { ...sealed, nonce: flip(sealed.nonce) },
      { ...sealed, nonce: sealed.nonce.slice(0, 8) },
      { ...sealed, ephemeralKey: flip(sealed.ephemeralKey) },
      { ...sealed, ephemeralKey: "AAAA" },
      { ...sealed, ephemeralKey: "not base64url!!" },
      { ...sealed, ciphertext: "not base64url!!" },
      { ...sealed, nonce: null as unknown as string },
      undefined as unknown as WorkjetSealedPayloadBlob,
    ];
    for (const candidate of candidates) {
      const error = yield* recipient.openSealed(candidate, ENVELOPE_ID).pipe(Effect.flip);
      assert.equal(error.reason, "invalid-signature");
    }

    // Sealing to something that is not a usable X25519 key fails as a bounded
    // LOCAL fault rather than producing an unopenable blob.
    for (const badKey of ["", "not base64url!!", "AAAA", "a".repeat(600)]) {
      const error = yield* sender.sealTo(badKey, plaintext("x"), ENVELOPE_ID).pipe(Effect.flip);
      assert.equal(error.reason, "mailbox-unavailable");
    }

    // The untouched blob still opens after all of the above.
    assert.include(text(yield* recipient.openSealed(sealed, ENVELOPE_ID)), "authenticated");
  }),
);

it.effect("seals a payload far larger than one AES block", () =>
  Effect.gen(function* () {
    const sender = yield* identityFrom(makeMemorySecretStore().service);
    const recipient = yield* identityFrom(makeMemorySecretStore().service);

    const large = "p".repeat(100_000);
    const sealed = yield* sender.sealTo(
      recipient.encryptionPublicKey,
      plaintext(large),
      ENVELOPE_ID,
    );
    assert.equal(text(yield* recipient.openSealed(sealed, ENVELOPE_ID)), large);
  }),
);

// ===============================
// Recipient roster projection
// ===============================

const LOCAL_WORKSPACE = WorkjetMeshWorkspaceId.make("workjet-mesh-local");
const PEER_WORKSPACE = WorkjetMeshWorkspaceId.make("workjet-mesh-peer");
const LOCAL_ENVIRONMENT = EnvironmentId.make("environment-local");

it("labels the local environment and renders each peer's first contact as ISO", () => {
  const roster = workjetMeshRosterOf({
    workspaceId: LOCAL_WORKSPACE,
    environmentId: LOCAL_ENVIRONMENT,
    page: {
      peers: [
        {
          workspaceId: PEER_WORKSPACE,
          environmentId: EnvironmentId.make("environment-peer"),
          firstSeenAtMillis: Date.UTC(2026, 7, 18, 10, 0, 0),
          sealedDeliveryReady: true,
          binding: "self-signed",
        },
      ],
      truncated: false,
    },
  });

  assert.deepEqual(roster.local, {
    schemaVersion: 1,
    workspaceId: LOCAL_WORKSPACE,
    environmentId: LOCAL_ENVIRONMENT,
  });
  assert.equal(roster.peers.length, 1);
  assert.equal(roster.peers[0]?.firstSeenAt, "2026-08-18T10:00:00.000Z");
  assert.isTrue(roster.peers[0]?.sealedDeliveryReady);
  // The trust LEVEL travels beside the "can be sealed" flag: sealing to a key
  // and knowing whose key it is are different claims, and the roster must not
  // let a reader collapse them.
  assert.equal(roster.peers[0]?.binding, "self-signed");
  assert.isFalse(roster.truncated);
});

it("carries ids, one timestamp, and no key material or liveness claim", () => {
  const roster = workjetMeshRosterOf({
    workspaceId: LOCAL_WORKSPACE,
    environmentId: LOCAL_ENVIRONMENT,
    page: {
      peers: [
        {
          workspaceId: PEER_WORKSPACE,
          environmentId: EnvironmentId.make("environment-peer"),
          firstSeenAtMillis: 1_000,
          sealedDeliveryReady: false,
          binding: "tofu",
        },
      ],
      truncated: true,
    },
  });

  assert.deepEqual(Object.keys(roster.peers[0] ?? {}).toSorted(), [
    "binding",
    "environmentId",
    "firstSeenAt",
    "schemaVersion",
    "sealedDeliveryReady",
    "workspaceId",
  ]);
  // An unbound peer reports `tofu` rather than being silently rendered like a
  // bound one; the honest label is the whole point of the field.
  assert.equal(roster.peers[0]?.binding, "tofu");
  const serialized = JSON.stringify(roster);
  assert.notInclude(serialized, "publicKey");
  assert.notInclude(serialized, "encryption");
  assert.notInclude(serialized, "online");
  assert.isTrue(roster.truncated);
});

it("reports an empty roster for a machine that has pinned no peer yet", () => {
  const roster = workjetMeshRosterOf({
    workspaceId: LOCAL_WORKSPACE,
    environmentId: LOCAL_ENVIRONMENT,
    page: { peers: [], truncated: false },
  });

  assert.deepEqual(roster.peers, []);
  assert.equal(roster.local.environmentId, LOCAL_ENVIRONMENT);
});

// ===============================
// Peer key binding
// ===============================

it.effect("signs a key binding over its OWN keys and cannot be told to sign others'", () =>
  Effect.gen(function* () {
    const identity = yield* identityFrom(makeMemorySecretStore().service);
    const other = yield* identityFrom(makeMemorySecretStore().service);

    const claim = {
      envelopeId: "wjm-binding-0001",
      sourceWorkspaceId: identity.workspaceId,
      sourceEnvironmentId: "environment-local",
    } as const;
    const signature = yield* identity.signKeyBinding(claim);

    // The signed claim is the one naming THIS environment's keys. There is no
    // parameter for the keys precisely so a caller can never produce a binding
    // asserting key material this environment does not hold.
    assert.isTrue(
      yield* identity.verifyKeyBinding(
        {
          ...claim,
          senderSigningKey: identity.publicKey,
          senderEncryptionKey: identity.encryptionPublicKey,
        },
        signature,
      ),
    );
    assert.isFalse(
      yield* identity.verifyKeyBinding(
        {
          ...claim,
          senderSigningKey: identity.publicKey,
          senderEncryptionKey: other.encryptionPublicKey,
        },
        signature,
      ),
    );
  }),
);

it.effect("refuses a binding whose envelope id or claimed address was changed", () =>
  Effect.gen(function* () {
    const identity = yield* identityFrom(makeMemorySecretStore().service);
    const claim = {
      envelopeId: "wjm-binding-0002",
      sourceWorkspaceId: identity.workspaceId,
      sourceEnvironmentId: "environment-local",
      senderSigningKey: identity.publicKey,
      senderEncryptionKey: identity.encryptionPublicKey,
    } as const;
    const signature = yield* identity.signKeyBinding(claim);

    assert.isTrue(yield* identity.verifyKeyBinding(claim, signature));
    // Every field of the claim is load-bearing: without the envelope id one
    // honest binding would authorise every later document, and without the
    // source pair it could be re-pointed at another machine's mesh address.
    assert.isFalse(
      yield* identity.verifyKeyBinding({ ...claim, envelopeId: "wjm-binding-0003" }, signature),
    );
    assert.isFalse(
      yield* identity.verifyKeyBinding(
        { ...claim, sourceEnvironmentId: "environment-elsewhere" },
        signature,
      ),
    );
    assert.isFalse(
      yield* identity.verifyKeyBinding(
        { ...claim, sourceWorkspaceId: "workjet-mesh-elsewhere" },
        signature,
      ),
    );
  }),
);

it.effect("rejects a binding signed by anybody but the key named in the claim", () =>
  Effect.gen(function* () {
    const identity = yield* identityFrom(makeMemorySecretStore().service);
    const attacker = yield* identityFrom(makeMemorySecretStore().service);

    const claim = {
      envelopeId: "wjm-binding-0004",
      sourceWorkspaceId: identity.workspaceId,
      sourceEnvironmentId: "environment-local",
      senderSigningKey: identity.publicKey,
      senderEncryptionKey: identity.encryptionPublicKey,
    } as const;
    // The attacker signs the honest peer's exact claim. It must not verify:
    // otherwise anyone could vouch for anyone else's keys.
    const forged = yield* attacker.sign(canonicalKeyBindingBytes(claim));
    assert.isFalse(yield* identity.verifyKeyBinding(claim, forged));

    // Malformed signatures are a `false`, never a throw.
    assert.isFalse(yield* identity.verifyKeyBinding(claim, "not base64url!!"));
    assert.isFalse(yield* identity.verifyKeyBinding(claim, ""));
  }),
);

it("serializes a binding claim with a fixed domain, field order, and no key-order drift", () => {
  const claim = {
    envelopeId: "wjm-binding-0005",
    sourceWorkspaceId: "workjet-mesh-peer",
    sourceEnvironmentId: "environment-peer",
    senderSigningKey: "signing-key",
    senderEncryptionKey: "encryption-key",
  } as const;
  const text = new TextDecoder().decode(canonicalKeyBindingBytes(claim));

  assert.isTrue(text.startsWith(`${WORKJET_MESH_KEY_BINDING_DOMAIN}\n`));
  // The domain tag versions the serialization: a future field change must bump
  // it rather than silently reinterpret signatures already in the wild.
  assert.strictEqual(
    text,
    `${WORKJET_MESH_KEY_BINDING_DOMAIN}\n{"envelopeId":"wjm-binding-0005","sourceWorkspaceId":"workjet-mesh-peer","sourceEnvironmentId":"environment-peer","senderSigningKey":"signing-key","senderEncryptionKey":"encryption-key"}`,
  );
  // The literal fixes the key order, so an input object built the other way
  // round produces byte-identical output on both ends of the wire.
  const reordered = {
    senderEncryptionKey: claim.senderEncryptionKey,
    senderSigningKey: claim.senderSigningKey,
    sourceEnvironmentId: claim.sourceEnvironmentId,
    sourceWorkspaceId: claim.sourceWorkspaceId,
    envelopeId: claim.envelopeId,
  };
  assert.deepEqual(canonicalKeyBindingBytes(reordered), canonicalKeyBindingBytes(claim));
  // A binding signature is not usable as a routing-envelope signature.
  assert.notStrictEqual(WORKJET_MESH_KEY_BINDING_DOMAIN, WORKJET_ROUTING_ENVELOPE_SIGNING_DOMAIN);
});

// ===============================
// Multi-computer overview projection
// ===============================

const OBSERVED_AT_MILLIS = Date.UTC(2026, 7, 19, 12, 0, 0);
const PEER_ONE = EnvironmentId.make("environment-peer-one");
const PEER_TWO = EnvironmentId.make("environment-peer-two");

const peerRecord = (environmentId: EnvironmentId) => ({
  workspaceId: PEER_WORKSPACE,
  environmentId,
  firstSeenAtMillis: Date.UTC(2026, 7, 18, 10, 0, 0),
  sealedDeliveryReady: true,
  binding: "self-signed" as const,
});

it("joins contact and delegation counts onto the peers that own them", () => {
  const overview = workjetMeshOverviewOf({
    workspaceId: LOCAL_WORKSPACE,
    environmentId: LOCAL_ENVIRONMENT,
    page: { peers: [peerRecord(PEER_ONE), peerRecord(PEER_TWO)], truncated: false },
    contact: [
      {
        environmentId: PEER_ONE,
        lastInboundAtMillis: Date.UTC(2026, 7, 19, 9, 0, 0),
        lastOutboundAtMillis: Date.UTC(2026, 7, 19, 8, 0, 0),
      },
    ],
    delegationCounts: [
      { environmentId: PEER_ONE, direction: "sent", state: "running", count: 2 },
      { environmentId: PEER_ONE, direction: "received", state: "completed", count: 5 },
      { environmentId: PEER_TWO, direction: "sent", state: "queued", count: 1 },
    ],
    observedAtMillis: OBSERVED_AT_MILLIS,
  });

  assert.deepEqual(overview.local, {
    schemaVersion: 1,
    workspaceId: LOCAL_WORKSPACE,
    environmentId: LOCAL_ENVIRONMENT,
  });
  assert.equal(overview.observedAt, "2026-08-19T12:00:00.000Z");

  const [first, second] = overview.peers;
  assert.equal(first?.environmentId, PEER_ONE);
  assert.equal(first?.lastInboundAt, "2026-08-19T09:00:00.000Z");
  assert.equal(first?.lastOutboundAt, "2026-08-19T08:00:00.000Z");
  assert.deepEqual(first?.delegationsSent, [{ state: "running", count: 2 }]);
  assert.deepEqual(first?.delegationsReceived, [{ state: "completed", count: 5 }]);

  // A count belonging to another peer never bleeds across.
  assert.equal(second?.environmentId, PEER_TWO);
  assert.deepEqual(second?.delegationsSent, [{ state: "queued", count: 1 }]);
  assert.deepEqual(second?.delegationsReceived, []);
});

it("omits the contact keys entirely for a peer with nothing on record", () => {
  const overview = workjetMeshOverviewOf({
    workspaceId: LOCAL_WORKSPACE,
    environmentId: LOCAL_ENVIRONMENT,
    page: { peers: [peerRecord(PEER_ONE)], truncated: true },
    contact: [{ environmentId: PEER_ONE, lastInboundAtMillis: null, lastOutboundAtMillis: null }],
    delegationCounts: [],
    observedAtMillis: OBSERVED_AT_MILLIS,
  });

  const peer = overview.peers[0]!;
  // Absent, not zeroed: the expiry sweep removing rows must never render as a
  // 1970 timestamp or as "just now".
  assert.isFalse("lastInboundAt" in peer);
  assert.isFalse("lastOutboundAt" in peer);
  assert.isTrue(overview.truncated);
});

it("carries no key material and no liveness claim of any kind", () => {
  const overview = workjetMeshOverviewOf({
    workspaceId: LOCAL_WORKSPACE,
    environmentId: LOCAL_ENVIRONMENT,
    page: { peers: [peerRecord(PEER_ONE)], truncated: false },
    contact: [{ environmentId: PEER_ONE, lastInboundAtMillis: 1_000, lastOutboundAtMillis: 2_000 }],
    delegationCounts: [],
    observedAtMillis: OBSERVED_AT_MILLIS,
  });

  assert.deepEqual(Object.keys(overview.peers[0]!).toSorted(), [
    "binding",
    "delegationsReceived",
    "delegationsSent",
    "environmentId",
    "firstSeenAt",
    "lastInboundAt",
    "lastOutboundAt",
    "schemaVersion",
    "sealedDeliveryReady",
    "workspaceId",
  ]);
  const serialized = JSON.stringify(overview);
  for (const forbidden of ["online", "offline", "reachable", "publicKey", "privateKey", "key"]) {
    assert.notInclude(serialized, forbidden);
  }
});

it("keeps the peer order the store chose rather than re-sorting by contact", () => {
  // Ordering is the CLIENT's presentation decision; the projection stays a pure
  // join so the server contract does not silently change what "first" means.
  const overview = workjetMeshOverviewOf({
    workspaceId: LOCAL_WORKSPACE,
    environmentId: LOCAL_ENVIRONMENT,
    page: { peers: [peerRecord(PEER_TWO), peerRecord(PEER_ONE)], truncated: false },
    contact: [{ environmentId: PEER_ONE, lastInboundAtMillis: 9_000, lastOutboundAtMillis: null }],
    delegationCounts: [],
    observedAtMillis: OBSERVED_AT_MILLIS,
  });

  assert.deepEqual(
    overview.peers.map((peer) => peer.environmentId),
    [PEER_TWO, PEER_ONE],
  );
});
