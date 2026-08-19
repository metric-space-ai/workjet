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
 * - the X25519 environment keypair that payloads are sealed TO ("encrypt
 *   message/delegation payloads end to end to the target environment key"), and
 * - the environment's own {@link WorkjetMeshWorkspaceId}, which the slice-3
 *   progress note flagged as caller-supplied — a peer must never be able to
 *   choose the workspace identity it claims to send from.
 *
 * All three are created ONCE and reused forever, through {@link ServerSecretStore}:
 * it is this server's only secret authority, it writes `0600` files under the
 * state directory, and its create-once semantics already survive a concurrent
 * second server process.
 *
 * Neither private key ever leaves this module: both live in the service
 * closure, are never returned by any method, never annotated on a span, and
 * never logged. Only the two raw public keys are exposed, as bounded base64url.
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

/**
 * Secret entry holding the PKCS#8 DER bytes of the X25519 private key.
 *
 * Deliberately a SECOND entry rather than one key reused for both jobs: the
 * signing key proves who sent an envelope and is quoted in the peer-key
 * continuity pin, while this key only ever decrypts payloads addressed to this
 * environment. Keeping them separate means an agreement-side mistake can never
 * become a signing oracle, and rotating one later does not invalidate the
 * other's pinned history.
 */
export const WORKJET_MESH_ENCRYPTION_KEY_SECRET = "workjet-mesh-x25519-private-key";

/** Secret entry holding the UTF-8 mesh workspace id of this environment. */
export const WORKJET_MESH_WORKSPACE_ID_SECRET = "workjet-mesh-workspace-id";

/** Prefix of a generated (not yet CTOX-room-derived) workspace id. */
export const WORKJET_MESH_WORKSPACE_ID_PREFIX = "workjet-mesh-";

/** Random bytes behind a generated workspace id (128 bits). */
const WORKSPACE_ID_ENTROPY_BYTES = 16;

const PRIVATE_KEY_RESOURCE = "workjet mesh signing key";
const ENCRYPTION_KEY_RESOURCE = "workjet mesh encryption key";
const WORKSPACE_ID_RESOURCE = "workjet mesh workspace id";

// ===============================
// Sealed payload construction
// ===============================

/**
 * THE sealed-payload construction. Both ends implement exactly this and nothing
 * else; a future change of any step MUST bump the domain string rather than
 * silently reinterpret existing blobs.
 *
 * Seal, given the recipient's static X25519 public key `R` and an `envelopeId`:
 *
 *   1. `(e_sk, e_pk)` ← fresh X25519 keypair, generated PER ENVELOPE. It is
 *      never persisted and never reused, so two seals of the same plaintext to
 *      the same recipient share no key material and no ciphertext.
 *   2. `shared` ← X25519(e_sk, R)                     (32 bytes)
 *   3. `key`    ← HKDF-SHA256(
 *                    ikm  = shared,
 *                    salt = 32 zero bytes,
 *                    info = utf8(DOMAIN ‖ "\n" ‖ b64url(R) ‖ "\n" ‖ b64url(e_pk)),
 *                    len  = 32)
 *      Both public keys enter `info`, which binds the derived key to this exact
 *      (recipient, ephemeral) pair: a blob cannot be re-pointed at another
 *      recipient, and an unknown-key-share confusion cannot arise from a
 *      shared secret alone.
 *   4. `nonce`  ← 12 fresh random bytes.
 *   5. `ct‖tag` ← AES-256-GCM(key, nonce, plaintext,
 *                    aad = utf8(DOMAIN ‖ "\n" ‖ envelopeId))
 *      The 16-byte tag is appended to the ciphertext, so a sealed blob is
 *      `ciphertext = ct ‖ tag`.
 *
 * The AAD binds the blob to ONE routing envelope. Replaying a sealed payload
 * under a different envelope id — a different target thread, a different
 * expiry, a different kind — fails authentication outright, so the signed
 * envelope and the encrypted payload cannot be recombined.
 *
 * Open reverses the derivation with this environment's static private key and
 * the transported `e_pk`. It is anonymous with respect to the sender by
 * construction: sender authenticity comes from the Ed25519 signature over the
 * routing envelope, which is verified BEFORE anything is unsealed.
 *
 * All three transported fields (`ephemeralKey`, `nonce`, `ciphertext`) are
 * base64url without padding.
 */
export const WORKJET_SEALED_PAYLOAD_DOMAIN = "workjet-sealed-payload-v1";

/** AES-256-GCM key length. */
const SEAL_KEY_BYTES = 32;

/** GCM nonce length. 96 bits is the only size AES-GCM is specified for. */
const SEAL_NONCE_BYTES = 12;

/** GCM authentication tag length. */
const SEAL_TAG_BYTES = 16;

/** Raw X25519 public key length. */
const X25519_PUBLIC_KEY_BYTES = 32;

/** HKDF salt. A fixed zero salt: the domain separation lives in `info`. */
const SEAL_HKDF_SALT = new Uint8Array(32);

/**
 * Upper bound on a base64url field of a sealed blob. A ciphertext is as long as
 * the payload it wraps, so the 512-character key bound cannot be reused here.
 * This is a sanity ceiling only: the authoritative size decision is the
 * transport's wire ceiling, checked against the fully encoded wrapper.
 */
const SEAL_FIELD_MAX_LENGTH = 1_048_576;

const SEAL_FIELD_PATTERN = /^[A-Za-z0-9_-]+$/;

const isSealedField = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= SEAL_FIELD_MAX_LENGTH &&
  SEAL_FIELD_PATTERN.test(value);

/** A payload sealed to one recipient environment, ready for the wire. */
export interface WorkjetSealedPayloadBlob {
  /** Per-envelope ephemeral X25519 public key, base64url. */
  readonly ephemeralKey: string;
  /** 12-byte AES-GCM nonce, base64url. */
  readonly nonce: string;
  /** AES-256-GCM ciphertext with its 16-byte tag appended, base64url. */
  readonly ciphertext: string;
}

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

  /**
   * Raw X25519 public key as bounded base64url (43 characters). This is the
   * ONLY thing a peer ever needs in order to seal a payload to this
   * environment; the matching private key never leaves this module.
   */
  readonly encryptionPublicKey: string;

  /**
   * Seals `plaintext` to `recipientEncryptionPublicKey`, binding the blob to
   * `envelopeId` as AAD. See {@link WORKJET_SEALED_PAYLOAD_DOMAIN} for the
   * exact construction. A malformed recipient key or a crypto fault fails with
   * a bounded reason and never leaks key material into the error.
   */
  readonly sealTo: (
    recipientEncryptionPublicKey: string,
    plaintext: Uint8Array,
    envelopeId: string,
  ) => Effect.Effect<WorkjetSealedPayloadBlob, WorkjetMailboxError>;

  /**
   * Opens a blob sealed to THIS environment under `envelopeId`. Every failure
   * mode — malformed field, wrong envelope id, tampered ciphertext, a blob
   * sealed to somebody else — is the same bounded `invalid-signature` outcome,
   * so an attacker learns nothing from which one they hit.
   */
  readonly openSealed: (
    sealed: WorkjetSealedPayloadBlob,
    envelopeId: string,
  ) => Effect.Effect<Uint8Array, WorkjetMailboxError>;

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
  function* (
    secrets: ServerSecretStore.ServerSecretStore["Service"],
    options: {
      readonly secretName: string;
      readonly resource: string;
      readonly curve: "ed25519" | "x25519";
    } = {
      secretName: WORKJET_MESH_PRIVATE_KEY_SECRET,
      resource: PRIVATE_KEY_RESOURCE,
      curve: "ed25519",
    },
  ) {
    const existing = yield* secrets.get(options.secretName);
    if (Option.isSome(existing)) return existing.value;

    const generated = yield* Effect.try({
      // Both the curve and the encodings are written out per branch: node's
      // `generateKeyPairSync` has no overload accepting a union curve, and a
      // hoisted encodings object resolves to the KeyObject-returning overload.
      try: () =>
        options.curve === "ed25519"
          ? NodeCrypto.generateKeyPairSync("ed25519", {
              privateKeyEncoding: { format: "der", type: "pkcs8" },
              publicKeyEncoding: { format: "der", type: "spki" },
            }).privateKey
          : NodeCrypto.generateKeyPairSync("x25519", {
              privateKeyEncoding: { format: "der", type: "pkcs8" },
              publicKeyEncoding: { format: "der", type: "spki" },
            }).privateKey,
      catch: (cause) =>
        new ServerSecretStore.SecretStoreRandomGenerationError({
          resource: options.resource,
          cause,
        }),
    });

    return yield* secrets.create(options.secretName, Uint8Array.from(generated)).pipe(
      Effect.as(Uint8Array.from(generated)),
      Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) =>
        ServerSecretStore.isSecretAlreadyExistsError(error)
          ? secrets.get(options.secretName).pipe(
              Effect.flatMap(
                Option.match({
                  onSome: Effect.succeed,
                  onNone: () =>
                    Effect.fail(
                      new ServerSecretStore.SecretStoreConcurrentReadError({
                        resource: options.resource,
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
  const encryptionKeyDer = yield* getOrCreatePrivateKeyDer(secrets, {
    secretName: WORKJET_MESH_ENCRYPTION_KEY_SECRET,
    resource: ENCRYPTION_KEY_RESOURCE,
    curve: "x25519",
  });
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

  const encryption = yield* Effect.try({
    try: () => {
      const privateKey = NodeCrypto.createPrivateKey({
        key: Buffer.from(encryptionKeyDer),
        format: "der",
        type: "pkcs8",
      });
      const jwk = NodeCrypto.createPublicKey(privateKey).export({ format: "jwk" });
      const raw = typeof jwk.x === "string" ? jwk.x : undefined;
      if (raw === undefined || !isBase64Url(raw)) {
        throw new Error("unusable encryption public key");
      }
      return { privateKey, publicKey: raw } as const;
    },
    catch: (cause) =>
      new ServerSecretStore.SecretStoreDecodeError({
        resource: ENCRYPTION_KEY_RESOURCE,
        cause,
      }),
  });

  /** `utf8(DOMAIN ‖ "\n" ‖ envelopeId)` — the additional authenticated data. */
  const sealAad = (envelopeId: string): Uint8Array =>
    new TextEncoder().encode(`${WORKJET_SEALED_PAYLOAD_DOMAIN}\n${envelopeId}`);

  /** Step 3 of the construction. Identical on both ends by definition. */
  const sealKey = (input: {
    readonly shared: Uint8Array;
    readonly recipientPublicKey: string;
    readonly ephemeralPublicKey: string;
  }): Uint8Array =>
    new Uint8Array(
      NodeCrypto.hkdfSync(
        "sha256",
        input.shared,
        SEAL_HKDF_SALT,
        new TextEncoder().encode(
          `${WORKJET_SEALED_PAYLOAD_DOMAIN}\n${input.recipientPublicKey}\n${input.ephemeralPublicKey}`,
        ),
        SEAL_KEY_BYTES,
      ),
    );

  /** Imports a raw base64url X25519 public key, refusing anything else. */
  const importX25519PublicKey = (raw: string): NodeCrypto.KeyObject => {
    if (typeof raw !== "string" || !isBase64Url(raw)) throw new Error("unusable key");
    if (Buffer.from(raw, "base64url").byteLength !== X25519_PUBLIC_KEY_BYTES) {
      throw new Error("unusable key");
    }
    return NodeCrypto.createPublicKey({
      key: { kty: "OKP", crv: "X25519", x: raw },
      format: "jwk",
    });
  };

  const sealTo: WorkjetMeshIdentityShape["sealTo"] = (
    recipientEncryptionPublicKey,
    plaintext,
    envelopeId,
  ) =>
    Effect.try({
      try: () => {
        const recipient = importX25519PublicKey(recipientEncryptionPublicKey);

        const ephemeral = NodeCrypto.generateKeyPairSync("x25519");
        const ephemeralJwk = ephemeral.publicKey.export({ format: "jwk" });
        const ephemeralPublicKey = typeof ephemeralJwk.x === "string" ? ephemeralJwk.x : undefined;
        if (ephemeralPublicKey === undefined) throw new Error("unusable ephemeral key");

        const shared = Uint8Array.from(
          NodeCrypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }),
        );
        const key = sealKey({
          shared,
          recipientPublicKey: recipientEncryptionPublicKey,
          ephemeralPublicKey,
        });

        const nonce = Uint8Array.from(NodeCrypto.randomBytes(SEAL_NONCE_BYTES));
        const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce, {
          authTagLength: SEAL_TAG_BYTES,
        });
        cipher.setAAD(sealAad(envelopeId));
        const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const sealed = Buffer.concat([body, cipher.getAuthTag()]);

        return {
          ephemeralKey: ephemeralPublicKey,
          nonce: Buffer.from(nonce).toString("base64url"),
          ciphertext: sealed.toString("base64url"),
        } satisfies WorkjetSealedPayloadBlob;
      },
      // A sealing failure is a local fault — a broken recipient key or a crypto
      // backend problem — and the bounded reason is all the caller may learn.
      catch: () => new WorkjetMailboxError({ reason: "mailbox-unavailable" }),
    });

  const openSealed: WorkjetMeshIdentityShape["openSealed"] = (sealed, envelopeId) =>
    Effect.try({
      try: () => {
        if (
          !isSealedField(sealed?.ephemeralKey) ||
          !isSealedField(sealed.nonce) ||
          !isSealedField(sealed.ciphertext)
        ) {
          throw new Error("unusable sealed blob");
        }

        const nonce = Buffer.from(sealed.nonce, "base64url");
        const blob = Buffer.from(sealed.ciphertext, "base64url");
        // `Buffer.from` is lenient about base64url, so the exact lengths are
        // checked here rather than trusted from the wire.
        if (nonce.byteLength !== SEAL_NONCE_BYTES || blob.byteLength < SEAL_TAG_BYTES) {
          throw new Error("unusable sealed blob");
        }

        const ephemeral = importX25519PublicKey(sealed.ephemeralKey);
        const shared = Uint8Array.from(
          NodeCrypto.diffieHellman({ privateKey: encryption.privateKey, publicKey: ephemeral }),
        );
        const key = sealKey({
          shared,
          recipientPublicKey: encryption.publicKey,
          ephemeralPublicKey: sealed.ephemeralKey,
        });

        const tag = blob.subarray(blob.byteLength - SEAL_TAG_BYTES);
        const body = blob.subarray(0, blob.byteLength - SEAL_TAG_BYTES);
        const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, nonce, {
          authTagLength: SEAL_TAG_BYTES,
        });
        decipher.setAAD(sealAad(envelopeId));
        decipher.setAuthTag(tag);
        // `final()` is what actually verifies the tag; without it a truncated
        // or forged blob would decrypt to attacker-chosen bytes.
        return Uint8Array.from(Buffer.concat([decipher.update(body), decipher.final()]));
      },
      // Every failure collapses to the same bounded reason on purpose: an
      // unsealable blob is indistinguishable from a forged one, and a peer must
      // not be able to probe which check it tripped.
      catch: () => new WorkjetMailboxError({ reason: "invalid-signature" }),
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
    encryptionPublicKey: encryption.publicKey,
    sealTo,
    openSealed,
    sign,
    verify,
    signRoutingEnvelope,
    verifyRoutingEnvelope,
  });
});

export const layer = Layer.effect(WorkjetMeshIdentity, makeWorkjetMeshIdentity());
