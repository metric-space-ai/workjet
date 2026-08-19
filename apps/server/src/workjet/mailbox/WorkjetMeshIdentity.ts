import * as NodeCrypto from "node:crypto";

import {
  WorkjetMailboxError,
  WorkjetMeshWorkspaceId,
  type WorkjetRoutingEnvelope,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

/**
 * The local mesh identity of THIS environment (docs/workjet-plan.md →
 * "Distributed worker mailbox and delegation graph"):
 *
 * - the Ed25519 environment keypair that signs the immutable routing envelope
 *   ("sign the immutable routing envelope with the source environment key"),
 *   and
 * - the environment's own {@link WorkjetMeshWorkspaceId}, which the slice-3
 *   progress note flagged as caller-supplied — a peer must never be able to
 *   choose the workspace identity it claims to send from.
 *
 * Both are created ONCE and reused forever, through {@link ServerSecretStore}:
 * it is this server's only secret authority, it writes `0600` files under the
 * state directory, and its create-once semantics already survive a concurrent
 * second server process.
 *
 * The private key never leaves this module: it lives in the service closure,
 * is never returned by any method, never annotated on a span, and never
 * logged. Only the raw public key is exposed, as bounded base64url.
 *
 * TRANSPORT NOTE: mesh membership is CTOX room pairing (owner decision
 * 2026-08-18). When the CTOX Sync transport slice lands, the workspace id must
 * be DERIVED from the paired CTOX room instead of generated here, and this
 * generated id becomes the pre-pairing fallback. The generated id is
 * deliberately persisted under its own secret name so that migration is a
 * single overwrite of one entry and never touches the signing key.
 */

// ===============================
// Persistence
// ===============================

/** Secret entry holding the PKCS#8 DER bytes of the Ed25519 private key. */
export const WORKJET_MESH_PRIVATE_KEY_SECRET = "workjet-mesh-ed25519-private-key";

/** Secret entry holding the UTF-8 mesh workspace id of this environment. */
export const WORKJET_MESH_WORKSPACE_ID_SECRET = "workjet-mesh-workspace-id";

/** Prefix of a generated (not yet CTOX-room-derived) workspace id. */
export const WORKJET_MESH_WORKSPACE_ID_PREFIX = "workjet-mesh-";

/** Random bytes behind a generated workspace id (128 bits). */
const WORKSPACE_ID_ENTROPY_BYTES = 16;

const PRIVATE_KEY_RESOURCE = "workjet mesh signing key";
const WORKSPACE_ID_RESOURCE = "workjet mesh workspace id";

// ===============================
// Canonical signing payload
// ===============================

/**
 * Domain separator. It makes a signature over a routing envelope unusable as a
 * signature over any other Workjet byte string, and it versions the
 * serialization itself: a future change of the field set MUST bump this tag
 * rather than silently re-interpret old signatures.
 */
export const WORKJET_ROUTING_ENVELOPE_SIGNING_DOMAIN = "workjet-routing-envelope-v1";

/** A routing envelope before its detached signature exists. */
export type WorkjetUnsignedRoutingEnvelope = Omit<WorkjetRoutingEnvelope, "signature">;

/**
 * THE canonical byte serialization of an unsigned routing envelope. Signer and
 * verifier must both use this function and nothing else.
 *
 * Definition:
 *
 *   utf8( DOMAIN + "\n" + JSON.stringify({ … }) )
 *
 * where the object literal fixes the key order explicitly as
 *
 *   schemaVersion, envelopeId, kind, sourceWorkspaceId, sourceEnvironmentId,
 *   targetWorkspaceId, targetEnvironmentId, createdAt, expiresAt
 *
 * `signature` is excluded by construction (it is the thing being produced), and
 * every remaining field is a bounded string or the schema-version literal, so
 * `JSON.stringify` over this literal is deterministic: no optional keys, no
 * arrays, no numbers other than the literal `1`, no key-order dependence on the
 * input object.
 */
export const canonicalRoutingEnvelopeBytes = (
  envelope: WorkjetUnsignedRoutingEnvelope,
): Uint8Array => {
  const canonical = {
    schemaVersion: envelope.schemaVersion,
    envelopeId: envelope.envelopeId,
    kind: envelope.kind,
    sourceWorkspaceId: envelope.sourceWorkspaceId,
    sourceEnvironmentId: envelope.sourceEnvironmentId,
    targetWorkspaceId: envelope.targetWorkspaceId,
    targetEnvironmentId: envelope.targetEnvironmentId,
    createdAt: envelope.createdAt,
    expiresAt: envelope.expiresAt,
  };
  return new TextEncoder().encode(
    // @effect-diagnostics-next-line preferSchemaOverJson:off -- The canonical signing payload is defined as this exact literal serialization.
    `${WORKJET_ROUTING_ENVELOPE_SIGNING_DOMAIN}\n${JSON.stringify(canonical)}`,
  );
};

// ===============================
// Service
// ===============================

export interface WorkjetMeshIdentityShape {
  /** This environment's own mesh workspace id. Never caller-supplied. */
  readonly workspaceId: WorkjetMeshWorkspaceId;

  /** Raw Ed25519 public key as bounded base64url (43 characters). */
  readonly publicKey: string;

  /** Detached Ed25519 signature over `bytes`, base64url, 86 characters. */
  readonly sign: (bytes: Uint8Array) => Effect.Effect<string, WorkjetMailboxError>;

  /**
   * Verifies a detached signature. Malformed signature or key material returns
   * `false`; this never throws and never fails.
   */
  readonly verify: (
    bytes: Uint8Array,
    signature: string,
    publicKey: string,
  ) => Effect.Effect<boolean>;

  /** Signs the canonical serialization and returns the complete envelope. */
  readonly signRoutingEnvelope: (
    envelope: WorkjetUnsignedRoutingEnvelope,
  ) => Effect.Effect<WorkjetRoutingEnvelope, WorkjetMailboxError>;

  /**
   * Verifies a complete envelope against a source public key, defaulting to
   * this environment's own key (the local fast path).
   */
  readonly verifyRoutingEnvelope: (
    envelope: WorkjetRoutingEnvelope,
    publicKey?: string,
  ) => Effect.Effect<boolean>;
}

export class WorkjetMeshIdentity extends Context.Service<
  WorkjetMeshIdentity,
  WorkjetMeshIdentityShape
>()("t3/workjet/mailbox/WorkjetMeshIdentity") {}

// ===============================
// Key and workspace-id material
// ===============================

const decodeWorkspaceId = Schema.decodeUnknownEffect(WorkjetMeshWorkspaceId);

const isBase64Url = (value: string): boolean => /^[A-Za-z0-9_-]{1,512}$/.test(value);

/**
 * Reads the create-once private key, generating it on first boot. A concurrent
 * creator loses the `wx` race and re-reads the winner's key, so two processes
 * can never end up with two different environment identities.
 */
const getOrCreatePrivateKeyDer = Effect.fn("WorkjetMeshIdentity.getOrCreatePrivateKeyDer")(
  function* (secrets: ServerSecretStore.ServerSecretStore["Service"]) {
    const existing = yield* secrets.get(WORKJET_MESH_PRIVATE_KEY_SECRET);
    if (Option.isSome(existing)) return existing.value;

    const generated = yield* Effect.try({
      try: () =>
        NodeCrypto.generateKeyPairSync("ed25519", {
          privateKeyEncoding: { format: "der", type: "pkcs8" },
          publicKeyEncoding: { format: "der", type: "spki" },
        }).privateKey,
      catch: (cause) =>
        new ServerSecretStore.SecretStoreRandomGenerationError({
          resource: PRIVATE_KEY_RESOURCE,
          cause,
        }),
    });

    return yield* secrets.create(WORKJET_MESH_PRIVATE_KEY_SECRET, Uint8Array.from(generated)).pipe(
      Effect.as(Uint8Array.from(generated)),
      Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) =>
        ServerSecretStore.isSecretAlreadyExistsError(error)
          ? secrets.get(WORKJET_MESH_PRIVATE_KEY_SECRET).pipe(
              Effect.flatMap(
                Option.match({
                  onSome: Effect.succeed,
                  onNone: () =>
                    Effect.fail(
                      new ServerSecretStore.SecretStoreConcurrentReadError({
                        resource: PRIVATE_KEY_RESOURCE,
                      }),
                    ),
                }),
              ),
            )
          : Effect.fail(error),
      ),
    );
  },
);

/**
 * Reads the create-once workspace id, generating a collision-resistant one on
 * first boot. A stored value that no longer satisfies the contract pattern is a
 * decode failure, never a silently regenerated identity: regenerating would
 * change this machine's mesh address behind every peer's back.
 */
const getOrCreateWorkspaceId = Effect.fn("WorkjetMeshIdentity.getOrCreateWorkspaceId")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
) {
  const decodeStored = (bytes: Uint8Array) =>
    decodeWorkspaceId(new TextDecoder().decode(bytes)).pipe(
      Effect.mapError(
        (cause) =>
          new ServerSecretStore.SecretStoreDecodeError({
            resource: WORKSPACE_ID_RESOURCE,
            cause,
          }),
      ),
    );

  const existing = yield* secrets.get(WORKJET_MESH_WORKSPACE_ID_SECRET);
  if (Option.isSome(existing)) return yield* decodeStored(existing.value);

  const entropy = yield* Effect.try({
    try: () => Uint8Array.from(NodeCrypto.randomBytes(WORKSPACE_ID_ENTROPY_BYTES)),
    catch: (cause) =>
      new ServerSecretStore.SecretStoreRandomGenerationError({
        resource: WORKSPACE_ID_RESOURCE,
        cause,
      }),
  });
  const generated = yield* decodeStored(
    new TextEncoder().encode(
      `${WORKJET_MESH_WORKSPACE_ID_PREFIX}${Encoding.encodeBase64Url(entropy)}`,
    ),
  );

  const won = yield* secrets
    .create(WORKJET_MESH_WORKSPACE_ID_SECRET, new TextEncoder().encode(generated))
    .pipe(
      Effect.as(true),
      Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) =>
        ServerSecretStore.isSecretAlreadyExistsError(error)
          ? Effect.succeed(false)
          : Effect.fail(error),
      ),
    );
  if (won) return generated;

  // A concurrent process created the entry first; adopt ITS id rather than
  // keeping a second, conflicting mesh address for the same environment.
  const winner = yield* secrets.get(WORKJET_MESH_WORKSPACE_ID_SECRET);
  if (Option.isNone(winner)) {
    return yield* Effect.fail(
      new ServerSecretStore.SecretStoreConcurrentReadError({ resource: WORKSPACE_ID_RESOURCE }),
    );
  }
  return yield* decodeStored(winner.value);
});

// ===============================
// Construction
// ===============================

export const makeWorkjetMeshIdentity = Effect.fn("WorkjetMeshIdentity.make")(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;

  const privateKeyDer = yield* getOrCreatePrivateKeyDer(secrets);
  const workspaceId = yield* getOrCreateWorkspaceId(secrets);

  const material = yield* Effect.try({
    try: () => {
      const privateKey = NodeCrypto.createPrivateKey({
        key: Buffer.from(privateKeyDer),
        format: "der",
        type: "pkcs8",
      });
      const jwk = NodeCrypto.createPublicKey(privateKey).export({ format: "jwk" });
      const raw = typeof jwk.x === "string" ? jwk.x : undefined;
      if (raw === undefined || !isBase64Url(raw)) {
        throw new Error("unusable public key");
      }
      return { privateKey, publicKey: raw } as const;
    },
    catch: (cause) =>
      new ServerSecretStore.SecretStoreDecodeError({
        resource: PRIVATE_KEY_RESOURCE,
        cause,
      }),
  });

  const sign: WorkjetMeshIdentityShape["sign"] = (bytes) =>
    Effect.try({
      try: () =>
        Buffer.from(NodeCrypto.sign(null, bytes, material.privateKey)).toString("base64url"),
      // The bounded reason is all a peer may ever learn; a signing failure is a
      // local mailbox fault, not something the caller did wrong.
      catch: () => new WorkjetMailboxError({ reason: "mailbox-unavailable" }),
    });

  const verify: WorkjetMeshIdentityShape["verify"] = (bytes, signature, publicKey) =>
    Effect.sync(() => {
      if (typeof signature !== "string" || typeof publicKey !== "string") return false;
      if (!isBase64Url(signature) || !isBase64Url(publicKey)) return false;
      try {
        const key = NodeCrypto.createPublicKey({
          key: { kty: "OKP", crv: "Ed25519", x: publicKey },
          format: "jwk",
        });
        const decoded = Buffer.from(signature, "base64url");
        // Ed25519 signatures are exactly 64 bytes; `Buffer.from` is lenient, so
        // this rejects truncated or padded input before it reaches verification.
        if (decoded.byteLength !== 64) return false;
        return NodeCrypto.verify(null, bytes, key, decoded);
      } catch {
        return false;
      }
    });

  const signRoutingEnvelope: WorkjetMeshIdentityShape["signRoutingEnvelope"] = (envelope) =>
    sign(canonicalRoutingEnvelopeBytes(envelope)).pipe(
      Effect.map((signature) => ({ ...envelope, signature })),
    );

  const verifyRoutingEnvelope: WorkjetMeshIdentityShape["verifyRoutingEnvelope"] = (
    envelope,
    publicKey,
  ) =>
    verify(
      canonicalRoutingEnvelopeBytes(envelope),
      envelope.signature,
      publicKey ?? material.publicKey,
    );

  return WorkjetMeshIdentity.of({
    workspaceId,
    publicKey: material.publicKey,
    sign,
    verify,
    signRoutingEnvelope,
    verifyRoutingEnvelope,
  });
});

export const layer = Layer.effect(WorkjetMeshIdentity, makeWorkjetMeshIdentity());
