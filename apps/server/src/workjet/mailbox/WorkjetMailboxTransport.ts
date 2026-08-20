import * as NodeOS from "node:os";

import {
  WorkjetMailboxError,
  WorkjetMailboxPayload,
  WorkjetRoutingEnvelope,
  type EnvironmentId,
  type WorkjetMailboxPeerBindingRejection,
  type WorkjetMailboxTimestamp,
  type WorkjetMeshPeerBinding,
  type WorkjetMeshWorkspaceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import * as ProcessRunner from "../../processRunner.ts";
import {
  WorkjetMailboxAuditEmitter,
  emitAudit,
  type WorkjetMailboxAuditSink,
  type WorkjetMailboxAuditEventInput,
} from "./WorkjetMailboxAuditEmitter.ts";
import { applyDeliveredDelegation } from "./WorkjetMailboxDelivery.ts";
import {
  WorkjetMailboxStore,
  type WorkjetMailboxStoreError,
  type WorkjetOutboxRecord,
} from "./WorkjetMailboxStore.ts";
import { WorkjetMeshIdentity } from "./WorkjetMeshIdentity.ts";
import { WorkjetSnapshotStore } from "./WorkjetSnapshotStore.ts";

/**
 * The Workjet side of the LOCAL CTOX daemon mailbox docking (docs/workjet-plan.md
 * → Wave 5, "Distributed worker mailbox and delegation graph", transport
 * architecture note of 2026-08-19).
 *
 * The docking decision is the whole design constraint: the Workjet server does
 * NOT embed a WebRTC peer. Each machine's local CTOX daemon carries a
 * `workjet_mailbox_envelopes` collection and replicates it through its existing
 * room membership, capability layer, and device revocation. The daemon treats
 * `envelope_json` and `payload_json` as OPAQUE bounded blobs — it never parses,
 * verifies, or interprets them.
 *
 * Therefore every mailbox semantic stays here:
 *
 * - signature verification of the routing envelope,
 * - sender-key acceptance (see "Interim sender-key distribution" below),
 * - expiry and addressing checks,
 * - idempotent inbox insertion and exactly-once delegation effects,
 * - outbox delivery accounting and the backoff-to-dead-letter budget.
 *
 * The daemon contributes exactly one thing Workjet cannot do for itself:
 * replication of an opaque document to the other machines in the room.
 *
 * ## Loopback surface
 *
 * Three authenticated routes on the daemon's MCP-channel listener (verified
 * against the CTOX implementation in `src/core/business_os/workjet_mailbox.rs`
 * and `workjet_mailbox_routes.rs`):
 *
 *   POST /workjet/mailbox/publish   one envelope document; duplicate id → 200
 *                                   with `"duplicate": true`
 *   GET  /workjet/mailbox/pending   bounded page for one environment id,
 *                                   opaque `after` cursor
 *   POST /workjet/mailbox/consumed  mark envelope ids consumed by an
 *                                   environment id
 *
 * All three require the same `Authorization: Bearer <token>` as `POST /mcp` and
 * refuse any non-loopback peer address before reading a body.
 *
 * ## Sender-key distribution and what actually secures it — READ THIS
 *
 * A pulled envelope must be verified against the SENDER's public key, and the
 * daemon cannot supply it: it is opaque to the envelope's contents by design.
 * So the sender's keys travel WITH the payload:
 *
 *   payload_json = { schemaVersion: 3, senderSigningKey, senderEncryptionKey,
 *                    keyBinding, body: { sealed } | { plain, reason } }
 *
 * Self-asserted keys prove nothing on their own, so FOUR constraints hold them
 * down, listed weakest first:
 *
 *  1. **CTOX room membership.** Only machines already paired into the room
 *     replicate this collection at all. The room, its password, and the
 *     capability/session layer are the daemon's existing admission control.
 *     This is admission control, not identity: every member is equally inside.
 *  2. **Signature over the routing envelope.** Verified against
 *     `senderSigningKey` BEFORE anything is pinned, so a peer can never pin a
 *     signing key it does not hold. First contact has never been unauthenticated
 *     in this sense — what was missing was everything below.
 *  3. **Key binding (`WORKJET_MESH_KEY_BINDING_DOMAIN`).** `payload_json` is
 *     covered by NO signature, so up to wrapper v2 a room member could
 *     republish an honest envelope with `senderEncryptionKey` swapped for its
 *     own and capture every later sealed reply to that peer. v3 carries a
 *     detached Ed25519 signature, by the same key the envelope verified
 *     against, over both public keys plus the claimed source pair and envelope
 *     id. It is verified before the pin, and a pin established under one can
 *     never be DOWNGRADED by a later wrapper that omits it.
 *  4. **Key continuity (TOFU).** The first keys seen for a
 *     `(sourceWorkspaceId, sourceEnvironmentId)` pair are pinned durably
 *     (migrations 043/044, trust level 049). A later envelope from that source
 *     carrying a DIFFERENT key is refused, audited as
 *     `mesh-peer-binding-rejected`, counted, and consumed.
 *
 * WHAT REMAINS OPEN, stated plainly: a room member that reaches an environment
 * id FIRST, with a keypair it genuinely holds, is indistinguishable from the
 * rightful owner of that id. Nothing above contradicts it, and no room-derived
 * MAC could — the room secret is known to every member, which is precisely the
 * adversary. Closing it needs a per-device attestation from the CTOX daemon.
 * The roster reports each peer's level (`tofu` / `self-signed`) rather than
 * implying a uniform trust the mesh does not have.
 *
 * None of this weakens the local fast path, which verifies against this
 * environment's own key and never consults a peer key at all.
 *
 * ## Payload sealing and the first-contact exception — READ THIS
 *
 * A cross-machine payload is ENCRYPTED to the target environment's X25519 key
 * (docs/workjet-plan.md → Wave 5) with the construction documented at
 * `WORKJET_SEALED_PAYLOAD_DOMAIN` in WorkjetMeshIdentity: a fresh ephemeral
 * X25519 key per envelope, HKDF-SHA256 to an AES-256-GCM key, and the envelope
 * id as AAD so a sealed blob cannot be replayed under a different envelope.
 * The daemon replicates the blob without being able to read it.
 *
 * Sealing needs the recipient's encryption key, and there is still no key
 * directory. The interim exchange is the SAME trust-on-first-use table the
 * signing key uses (migration 044): every outbound wrapper advertises this
 * environment's encryption key, and the receiver pins it beside the signing key
 * under one continuity rule — first key wins, a later different key from the
 * same source pair is rejected and consumed.
 *
 * Hence one bounded exception, which is deliberate and visible in the status
 * snapshot as `plainFirstContact`:
 *
 *   the FIRST envelope to a peer this machine has never received anything from
 *   travels as `{plain, reason:"recipient-key-unknown"}`. Its protection is
 *   exactly what the transport had before this slice — CTOX room membership and
 *   the signed routing envelope — and nothing weaker. Once that peer has sent
 *   anything back, its encryption key is pinned and every later envelope in
 *   this direction is sealed. Two machines that talk to each other therefore
 *   converge to sealed after one envelope in each direction.
 *
 * The LOCAL fast path never crosses a machine and is untouched: it neither
 * seals nor consults a peer key.
 *
 * ## Idle rather than fail
 *
 * The daemon may not be installed, may not be running, or may start later. The
 * loop therefore RESOLVES the daemon descriptor and the auth token every cycle
 * and idles with a redacted debug log when either is missing. An idle transport
 * is a normal state, not an error: pending outbound rows simply stay pending.
 */

// ===============================
// Bounds and cadence
// ===============================

/** Poll cadence. Jittered, so several machines never align their polls. */
export const WORKJET_TRANSPORT_POLL_INTERVAL = Duration.seconds(10);

/** Outbound rows considered per cycle. */
export const WORKJET_TRANSPORT_PUSH_LIMIT = 50;

/** Envelopes pulled per cycle. Stays under CTOX's 200-entry page ceiling. */
export const WORKJET_TRANSPORT_PULL_LIMIT = 50;

/** CTOX refuses more than 200 envelope ids in one `consumed` call. */
const CONSUMED_BATCH_LIMIT = 200;

/** Per-request ceiling. A wedged loopback socket must not stall the loop. */
const REQUEST_TIMEOUT = Duration.seconds(15);

/**
 * The daemon's own descriptor freshness contract: `lastSeenAt` refreshes every
 * 45 s and the documented consumer staleness window is 120 s. A descriptor left
 * behind by a crashed daemon must read as "not running", not as an endpoint.
 */
const DESCRIPTOR_STALENESS_MILLIS = 120_000;

/**
 * CTOX validates every id it stores as `[A-Za-z0-9_-]{1,128}`. Workjet's own id
 * contracts are wider (they also permit `.` and `:`), so ids are checked here
 * before they are placed in a CTOX-visible field.
 */
const CTOX_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const isCtoxSafeId = (value: string): boolean => CTOX_ID_PATTERN.test(value);

/** Environment variable that supplies the bearer token directly. */
export const WORKJET_CTOX_TOKEN_ENV = "WORKJET_CTOX_MAILBOX_TOKEN";

/** Environment variable that overrides the CTOX state root. */
export const CTOX_STATE_ROOT_ENV = "CTOX_STATE_ROOT";

/** Environment variable that points at the `ctox` executable. */
export const CTOX_BIN_ENV = "CTOX_BIN";

/** Secret the daemon authenticates its loopback surface with. */
export const CTOX_MCP_TOKEN_SECRET_SCOPE = "business_os";
export const CTOX_MCP_TOKEN_SECRET_NAME = "mcp_inbound_auth_token";

// ===============================
// Status
// ===============================

/**
 * Why the transport is not exchanging envelopes. Every value is a bounded
 * constant: this snapshot is destined for the UI and must never carry a path, a
 * token fragment, or a daemon error string.
 */
export type WorkjetMailboxTransportIdleReason =
  | "descriptor-missing"
  | "descriptor-unreadable"
  | "daemon-not-running"
  | "daemon-endpoint-unusable"
  | "token-unavailable"
  | "environment-id-unsupported";

export interface WorkjetMailboxTransportCounters {
  readonly pushed: number;
  readonly pushDuplicates: number;
  readonly pushFailures: number;
  readonly pulled: number;
  readonly accepted: number;
  readonly inboundDuplicates: number;
  readonly rejected: number;
  readonly consumed: number;
  readonly deferred: number;
  /** Outbound envelopes whose payload was sealed to the target environment. */
  readonly sealed: number;
  /**
   * Outbound envelopes sent in the clear because the target's encryption key
   * was not yet pinned. One per peer per direction; a rising number means peers
   * keep appearing, never that sealing regressed.
   */
  readonly plainFirstContact: number;
  /** Outbound envelopes refused before publish for exceeding the wire ceiling. */
  readonly payloadTooLarge: number;
  /** Inbound envelopes whose sealed payload this environment opened. */
  readonly unsealed: number;
  /**
   * Inbound envelopes accepted from a peer whose pin stands at `self-signed`:
   * both of its public keys are provably chosen by one holder and bound to the
   * mesh address claimed.
   */
  readonly bindingVerified: number;
  /**
   * Inbound envelopes accepted from a peer still pinned on bare
   * trust-on-first-use, because the wrapper carried no key binding (a v1/v2
   * migration-window peer). Not an error — an honest count of how much of this
   * mesh is still unbound.
   */
  readonly bindingAbsent: number;
  /**
   * Outbound cross-environment delegations that shipped WITH their prompt
   * snapshot bytes attached, so the receiver can run them without waiting for a
   * separate snapshot transfer.
   */
  readonly snapshotAttached: number;
  /**
   * Outbound cross-environment delegations shipped reference-only because the
   * snapshot would not fit the sealed wire ceiling. They carry a
   * `snapshot-oversized` marker instead of the bytes; never a silent drop.
   */
  readonly snapshotOversized: number;
  /**
   * Inbound cross-environment delegations whose attached snapshot bytes this
   * environment stored into its LOCAL snapshot store, digest re-verified, so the
   * executor now finds the prompt locally.
   */
  readonly snapshotStored: number;
  /**
   * Inbound cross-environment delegations that arrived reference-only with the
   * `snapshot-oversized` marker: accepted and left `delivered` with this bounded
   * reason rather than dropped, awaiting a later bounded-reference fetch.
   */
  readonly snapshotOversizedReceived: number;
}

/** Why a pulled envelope was refused. Poison envelopes are consumed, not looped. */
export interface WorkjetMailboxTransportRejections {
  readonly malformed: number;
  readonly misaddressed: number;
  readonly expired: number;
  readonly signature: number;
  readonly keyContinuity: number;
  /**
   * A wrapper whose key binding did not hold: a signature that did not verify
   * against the envelope's signing key, a claim naming a different
   * envelope/source pair than the envelope does, or a wrapper that omitted the
   * binding for a peer already pinned WITH one (a strip-the-binding downgrade).
   *
   * Deliberately distinct from `keyContinuity`, which is a CONFLICT with an
   * already-pinned key. These are different attacks and an operator watching
   * one should not have it hidden inside the other's count.
   */
  readonly keyBinding: number;
  /**
   * An envelope advertising a key an OPERATOR revoked on this machine
   * (migration 053). Counted apart from `keyContinuity` because it is not a
   * conflict with a pin — the pin is gone — and apart from `keyBinding`
   * because nothing about the wrapper is wrong. It is the one rejection whose
   * cause is a local human decision, and a non-zero count is the signal that
   * something is still presenting a key the operator destroyed.
   */
  readonly keyRevoked: number;
  /**
   * A sealed payload that would not open under this envelope id: a blob sealed
   * to another environment, a tampered ciphertext, or a replay lifted onto a
   * different envelope. Distinct from `signature`, which is about the routing
   * envelope, and from `malformed`, which is about structure.
   */
  readonly sealing: number;
  /**
   * A delegation whose attached snapshot bytes did not hash to the digest the
   * delegation declared. The bytes are worthless, so the envelope is consumed:
   * a snapshot matching the declared digest could only arrive under a different
   * envelope, never by re-reading this one.
   */
  readonly snapshotDigest: number;
  /**
   * A payload whose CLAIMED addresses disagree with the ones the routing
   * envelope's signature actually authenticates.
   *
   * The signature covers the routing envelope only, and the seal binds the
   * payload to the envelope ID — neither binds the addresses INSIDE the payload
   * to the ones outside it. Without this check a pinned peer could deliver a
   * delegation whose `source` names a third environment (making this machine
   * sign and relay a `result` envelope to it) or names THIS environment
   * (making the executor's same-environment result path write an activity onto
   * a locally addressed thread the peer chose). Both are cross-environment
   * authority escalation by a sender that is otherwise perfectly authenticated,
   * so the mismatch is refused before anything durable is written.
   */
  readonly addressMismatch: number;
}

export interface WorkjetMailboxTransportStatus {
  readonly schemaVersion: 1;
  readonly running: boolean;
  readonly idleReason: WorkjetMailboxTransportIdleReason | null;
  readonly lastPushAtMillis: number | null;
  readonly lastPullAtMillis: number | null;
  readonly counters: WorkjetMailboxTransportCounters;
  readonly rejections: WorkjetMailboxTransportRejections;
}

const EMPTY_COUNTERS: WorkjetMailboxTransportCounters = {
  pushed: 0,
  pushDuplicates: 0,
  pushFailures: 0,
  pulled: 0,
  accepted: 0,
  inboundDuplicates: 0,
  rejected: 0,
  consumed: 0,
  deferred: 0,
  sealed: 0,
  plainFirstContact: 0,
  payloadTooLarge: 0,
  unsealed: 0,
  bindingVerified: 0,
  bindingAbsent: 0,
  snapshotAttached: 0,
  snapshotOversized: 0,
  snapshotStored: 0,
  snapshotOversizedReceived: 0,
};

const EMPTY_REJECTIONS: WorkjetMailboxTransportRejections = {
  malformed: 0,
  misaddressed: 0,
  expired: 0,
  signature: 0,
  keyContinuity: 0,
  keyBinding: 0,
  keyRevoked: 0,
  sealing: 0,
  snapshotDigest: 0,
  addressMismatch: 0,
};

export interface WorkjetMailboxTransportShape {
  /** Bounded, redaction-safe snapshot for later UI exposure. */
  readonly status: Effect.Effect<WorkjetMailboxTransportStatus>;

  /**
   * One bounded push+pull cycle. The scheduled loop calls exactly this, so a
   * test drives the real cycle rather than a parallel test-only path.
   */
  readonly runCycle: Effect.Effect<WorkjetMailboxTransportStatus>;
}

export class WorkjetMailboxTransport extends Context.Service<
  WorkjetMailboxTransport,
  WorkjetMailboxTransportShape
>()("t3/workjet/mailbox/WorkjetMailboxTransport") {}

// ===============================
// Daemon descriptor
// ===============================

/**
 * The daemon's `<state-root>/instance.json`. Only the fields this transport
 * needs are decoded; the descriptor is a CTOX-owned contract that may grow.
 */
const CtoxInstanceDescriptor = Schema.Struct({
  version: Schema.Number,
  /**
   * The daemon's own published identity, written by the running process (CTOX
   * `src/core/service/instance_descriptor.rs`). Optional here because the field
   * is not needed to *reach* the daemon — the mailbox transport ignores it — but
   * it IS the only local fact that says WHICH CTOX instance this loopback
   * listener belongs to, so the cross-mode port reads it to verify authority.
   */
  instanceId: Schema.optional(Schema.String),
  status: Schema.String,
  lastSeenAt: Schema.Number,
  healthUrl: Schema.optional(Schema.String),
});

const decodeDescriptor = Schema.decodeUnknownEffect(Schema.fromJsonString(CtoxInstanceDescriptor));

export interface CtoxDaemonEndpoint {
  /** Base URL of the loopback MCP-channel listener, with no trailing slash. */
  readonly baseUrl: string;
  /**
   * The `instanceId` the running daemon published in its descriptor, when it
   * published one. Absent for an older daemon that omits the field; a consumer
   * that needs an identity must treat absence as "cannot vouch", never as a
   * match.
   */
  readonly instanceId?: string;
}

/** `CTOX_STATE_ROOT`, else the documented default `~/.local/state/ctox`. */
export const ctoxStateRoot = (path: Path.Path, env: NodeJS.ProcessEnv): string => {
  const configured = env[CTOX_STATE_ROOT_ENV]?.trim();
  return configured !== undefined && configured.length > 0
    ? configured
    : path.join(NodeOS.homedir(), ".local", "state", "ctox");
};

export const ctoxDescriptorPath = (path: Path.Path, env: NodeJS.ProcessEnv): string =>
  path.join(ctoxStateRoot(path, env), "instance.json");

/**
 * Turns a descriptor's `healthUrl` into the listener base URL.
 *
 * The descriptor publishes `http://127.0.0.1:8788/health` — the one
 * credential-free route on that listener. The mailbox routes ride the SAME
 * listener, so the base URL is the health URL minus its `/health` suffix. A
 * non-loopback host is refused outright: this surface is loopback-only by the
 * daemon's own policy and a descriptor is not an authority that can widen it.
 */
export const ctoxBaseUrlFromHealthUrl = (healthUrl: string): Option.Option<string> => {
  let parsed: URL;
  try {
    parsed = new URL(healthUrl);
  } catch {
    return Option.none();
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return Option.none();
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || host.startsWith("127.");
  if (!loopback) return Option.none();
  const path = parsed.pathname.replace(/\/health\/?$/, "").replace(/\/$/, "");
  return Option.some(`${parsed.origin}${path}`);
};

// ===============================
// Transport payload wrapper
// ===============================

/** CTOX caps `payload_json` at 200 000 bytes on the publish route. */
export const WORKJET_TRANSPORT_PAYLOAD_CEILING_BYTES = 200_000;

const MeshPublicKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,512}$/));

/**
 * A base64url field of a sealed blob. A ciphertext is as long as the payload it
 * wraps, so this bound is a sanity ceiling rather than the size policy: the
 * authoritative decision is {@link WORKJET_TRANSPORT_PAYLOAD_CEILING_BYTES},
 * checked against the fully encoded wrapper so an oversized envelope is refused
 * as a typed `payload-too-large` instead of an opaque encoding failure.
 *
 * That authoritative ceiling is an OUTBOUND check, so this bound is the only
 * thing standing between a hostile peer and an unbounded inbound wrapper. It is
 * exported so a test can pin both halves: that the ceiling is enforced, and
 * that the number itself has not been widened.
 */
export const WORKJET_TRANSPORT_SEALED_FIELD_MAX_CHARS = 1_048_576;

const SealedField = Schema.String.check(
  Schema.isPattern(new RegExp(`^[A-Za-z0-9_-]{1,${WORKJET_TRANSPORT_SEALED_FIELD_MAX_CHARS}}$`)),
);

/**
 * The v1 wrapper, kept ONLY so a peer that has not yet upgraded stays readable
 * during the migration window. Nothing produces it any more.
 */
export const WorkjetTransportPayloadWrapperV1 = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  senderPublicKey: MeshPublicKey,
  payload: WorkjetMailboxPayload,
});

/** The sealed blob exactly as {@link WORKJET_SEALED_PAYLOAD_DOMAIN} defines it. */
export const WorkjetTransportSealedBody = Schema.Struct({
  ephemeralKey: SealedField,
  nonce: SealedField,
  ciphertext: SealedField,
});

/**
 * What travels in `payload_json` today.
 *
 * The routing envelope keeps its own contract shape in `envelope_json`; this
 * wrapper exists solely to carry the interim sender keys alongside the payload
 * without touching the signed bytes. It carries BOTH of this environment's
 * public keys:
 *
 * - `senderSigningKey` verifies the routing envelope (the v1 `senderPublicKey`
 *   under its now-unambiguous name), and
 * - `senderEncryptionKey` is how the receiver learns where to seal its replies.
 *
 * `body` is the payload itself, in one of two forms:
 *
 * - `{sealed}` — the normal case. The payload's JSON encoding is sealed to the
 *   recipient's pinned encryption key and bound to this envelope id.
 * - `{plain, reason:"recipient-key-unknown"}` — the FIRST envelope to a peer
 *   whose encryption key this machine has not yet learned. See migration 044
 *   for why that case exists and why it is bounded to one envelope per peer.
 */
export const WorkjetTransportPayloadWrapperV2 = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  senderSigningKey: MeshPublicKey,
  senderEncryptionKey: MeshPublicKey,
  body: Schema.Union([
    Schema.Struct({ sealed: WorkjetTransportSealedBody }),
    Schema.Struct({
      plain: WorkjetMailboxPayload,
      reason: Schema.Literal("recipient-key-unknown"),
    }),
  ]),
});

/** A detached Ed25519 signature, base64url. 86 characters when well-formed. */
const KeyBindingSignature = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,512}$/));

/**
 * What this transport produces today: v2 plus a self-signed KEY BINDING.
 *
 * The binding is the whole point of v3 and the reason a wrapper version had to
 * change at all. `payload_json` is covered by NO signature — the routing
 * envelope's signature covers `envelope_json` only — so up to v2 any CTOX room
 * member could republish an honest peer's envelope with `senderEncryptionKey`
 * swapped for its own, and the receiver would pin the honest signing key beside
 * the attacker's encryption key. Every later reply to that peer would then be
 * sealed to the attacker.
 *
 * `keyBinding` is a detached Ed25519 signature by `senderSigningKey` over the
 * canonical claim documented at `WORKJET_MESH_KEY_BINDING_DOMAIN` (WorkjetMeshIdentity):
 * envelope id, claimed source pair, and BOTH public keys. The receiver verifies
 * it against the same key the routing envelope verified against, before pinning
 * anything, so the two keys are provably chosen by one holder and bound to the
 * mesh address being claimed.
 *
 * It is NOT a room-derived binding and does not pretend to be one; see the
 * domain constant for what remains open and why a room-keyed MAC would add
 * nothing against an in-room attacker.
 */
export const WorkjetTransportPayloadWrapperV3 = Schema.Struct({
  schemaVersion: Schema.Literal(3),
  senderSigningKey: MeshPublicKey,
  senderEncryptionKey: MeshPublicKey,
  keyBinding: KeyBindingSignature,
  body: Schema.Union([
    Schema.Struct({ sealed: WorkjetTransportSealedBody }),
    Schema.Struct({
      plain: WorkjetMailboxPayload,
      reason: Schema.Literal("recipient-key-unknown"),
    }),
  ]),
});

/** What a pull may legitimately find on the wire: v3, or a v2/v1 straggler. */
export const WorkjetTransportPayloadWrapper = Schema.Union([
  WorkjetTransportPayloadWrapperV3,
  WorkjetTransportPayloadWrapperV2,
  WorkjetTransportPayloadWrapperV1,
]);
export type WorkjetTransportPayloadWrapper = typeof WorkjetTransportPayloadWrapper.Type;

const encodeWrapperJson = Schema.encodeEffect(
  Schema.fromJsonString(WorkjetTransportPayloadWrapperV3),
);
const decodeWrapperJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WorkjetTransportPayloadWrapper),
);

/** The sealed plaintext IS the payload's canonical JSON encoding. */
const encodePayloadJson = Schema.encodeEffect(Schema.fromJsonString(WorkjetMailboxPayload));
const decodePayloadJson = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkjetMailboxPayload));
const encodeEnvelopeJson = Schema.encodeEffect(Schema.fromJsonString(WorkjetRoutingEnvelope));
const decodeEnvelopeJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WorkjetRoutingEnvelope),
);

/** One document as the daemon stores and returns it. */
const CtoxEnvelopeDocument = Schema.Struct({
  id: Schema.String,
  envelope_json: Schema.String,
  payload_json: Schema.optional(Schema.String),
});

const CtoxPendingPage = Schema.Struct({
  envelopes: Schema.Array(CtoxEnvelopeDocument),
  has_more: Schema.optional(Schema.Boolean),
  next_cursor: Schema.optional(Schema.NullOr(Schema.String)),
});

const CtoxPublishResult = Schema.Struct({
  duplicate: Schema.optional(Schema.Boolean),
});

const decodePendingPage = Schema.decodeUnknownEffect(CtoxPendingPage);
const decodePublishResult = Schema.decodeUnknownEffect(CtoxPublishResult);

/** `ctox secret get --json` answers `{"ok":true,…,"value":"<secret>"}`. */
const decodeCtoxSecretPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ value: Schema.String })),
);

// ===============================
// Injected sources
// ===============================

export interface WorkjetMailboxTransportSources {
  /** Wall clock as a contract timestamp. */
  readonly nowIso: Effect.Effect<string>;

  /**
   * The daemon's loopback base URL, or `None` with the bounded reason it could
   * not be resolved. Re-read every cycle: the daemon may start later.
   */
  readonly resolveEndpoint: Effect.Effect<
    | { readonly _tag: "resolved"; readonly endpoint: CtoxDaemonEndpoint }
    | { readonly _tag: "idle"; readonly reason: WorkjetMailboxTransportIdleReason }
  >;

  /** The bearer token, or `None` when it is genuinely unreachable. */
  readonly resolveAuthToken: Effect.Effect<Option.Option<string>>;

  /**
   * Best-effort redacted audit sink. Optional so a unit test can omit it (a
   * no-op) or inject a capturing double; the real layer wires the shared
   * {@link WorkjetMailboxAuditEmitter}.
   */
  readonly audit?: WorkjetMailboxAuditSink;
}

// ===============================
// Real source implementations
// ===============================

/**
 * Reads the CTOX instance descriptor and derives the loopback base URL.
 *
 * A missing file is the ordinary "CTOX is not installed or has never run" case
 * and is distinguished from an unreadable/undecodable one, because the two ask
 * the operator for different things.
 */
export const resolveCtoxEndpointFromDescriptor = (options: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: string;
  readonly nowMillis: Effect.Effect<number>;
}) =>
  Effect.gen(function* () {
    const raw = yield* options.fileSystem.readFileString(options.path).pipe(Effect.option);
    if (Option.isNone(raw)) return { _tag: "idle", reason: "descriptor-missing" } as const;

    const descriptor = yield* decodeDescriptor(raw.value).pipe(Effect.option);
    if (Option.isNone(descriptor)) {
      return { _tag: "idle", reason: "descriptor-unreadable" } as const;
    }

    const now = yield* options.nowMillis;
    const stale = now - descriptor.value.lastSeenAt > DESCRIPTOR_STALENESS_MILLIS;
    if (descriptor.value.status !== "running" || stale) {
      return { _tag: "idle", reason: "daemon-not-running" } as const;
    }

    const healthUrl = descriptor.value.healthUrl;
    if (healthUrl === undefined) {
      return { _tag: "idle", reason: "daemon-endpoint-unusable" } as const;
    }
    const baseUrl = ctoxBaseUrlFromHealthUrl(healthUrl);
    const instanceId = descriptor.value.instanceId?.trim();
    return Option.match(baseUrl, {
      onNone: () => ({ _tag: "idle", reason: "daemon-endpoint-unusable" }) as const,
      onSome: (url) =>
        ({
          _tag: "resolved",
          endpoint: {
            baseUrl: url,
            ...(instanceId !== undefined && instanceId.length > 0 ? { instanceId } : {}),
          },
        }) as const,
    });
  });

/**
 * How a legitimate same-user local client obtains the daemon's bearer token.
 *
 * The token is the CTOX per-instance secret `business_os/mcp_inbound_auth_token`.
 * The daemon generates it on first use and stores it ENCRYPTED in its secret
 * store (a SQLite database under the CTOX root, sealed with a `0600` master key
 * file). It is not readable by parsing a file, and it is deliberately not
 * published in the instance descriptor.
 *
 * CTOX's own documented retrieval path for an operator or a trusted local agent
 * is the CLI:
 *
 *     ctox secret get --scope business_os --name mcp_inbound_auth_token
 *     → {"ok":true,"scope":…,"name":…,"value":"<token>"}
 *
 * That is exactly what `mcp_connect_info_payload` hands to Codex and Claude Code
 * so they can call `POST /mcp`, so it is a first-class, read-only, same-user
 * path rather than a workaround. This resolver therefore:
 *
 *  1. accepts `WORKJET_CTOX_MAILBOX_TOKEN` when an operator supplies it
 *     directly (deployments where the `ctox` binary is not on PATH), and
 *  2. otherwise shells out to `ctox secret get` READ-ONLY and parses `value`.
 *
 * The token is never logged, never annotated on a span, and never placed in the
 * status snapshot. If neither path yields a token the transport idles.
 */
export const resolveCtoxAuthTokenFromCli = (options: {
  readonly runner: ProcessRunner.ProcessRunner["Service"];
  readonly env: NodeJS.ProcessEnv;
}): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const direct = options.env[WORKJET_CTOX_TOKEN_ENV]?.trim();
    if (direct !== undefined && direct.length > 0) return Option.some(direct);

    const binary = options.env[CTOX_BIN_ENV]?.trim();
    const command = binary !== undefined && binary.length > 0 ? binary : "ctox";

    const result = yield* options.runner
      .run({
        command,
        args: [
          "secret",
          "get",
          "--scope",
          CTOX_MCP_TOKEN_SECRET_SCOPE,
          "--name",
          CTOX_MCP_TOKEN_SECRET_NAME,
        ],
        timeout: Duration.seconds(10),
        timeoutBehavior: "timedOutResult",
        // The answer is a small JSON object; a chatty binary must not be
        // allowed to grow this process.
        maxOutputBytes: 64 * 1024,
        outputMode: "truncate",
      })
      .pipe(Effect.option);

    if (Option.isNone(result) || result.value.timedOut || result.value.code !== 0) {
      return Option.none();
    }

    const parsed = yield* decodeCtoxSecretPayload(result.value.stdout).pipe(Effect.option);
    if (Option.isNone(parsed)) return Option.none();
    const token = parsed.value.value.trim();
    return token.length === 0 ? Option.none() : Option.some(token);
  });

// ===============================
// Construction
// ===============================

const isBoundedMailboxError = (cause: WorkjetMailboxStoreError): cause is WorkjetMailboxError =>
  cause._tag === "WorkjetMailboxError";

/** A rejection is a decision about ONE envelope, never about the whole page. */
type RejectionKind = keyof WorkjetMailboxTransportRejections;

/** A mesh address reduced to the pair a routing envelope authenticates. */
interface ClaimedAddress {
  readonly workspaceId: string;
  readonly environmentId: string;
}

/**
 * The addresses and envelope id a payload CLAIMS about itself.
 *
 * `receipt` is the one variant whose `envelopeId` names a DIFFERENT envelope
 * (the one being acknowledged), so it contributes no envelope-id claim.
 */
interface PayloadClaim {
  readonly sources: ReadonlyArray<ClaimedAddress>;
  readonly targets: ReadonlyArray<ClaimedAddress>;
  readonly envelopeId: string | undefined;
}

const payloadClaim = (payload: WorkjetMailboxPayload): PayloadClaim => {
  switch (payload._tag) {
    case "message":
      return {
        sources: [payload.message.source],
        targets: [payload.message.target],
        envelopeId: payload.message.envelopeId,
      };
    case "delegation":
      return {
        sources: [payload.delegation.source],
        targets: [payload.delegation.target],
        envelopeId: payload.delegation.envelopeId,
      };
    case "handoff":
      return {
        sources: [payload.handoff.sourceThread],
        targets: [payload.handoff.target],
        envelopeId: payload.handoff.envelopeId,
      };
    case "result":
      // `reportedBy` and the delegation's `owner` are the SAME address by
      // construction (`WorkjetDelegationExecutor.buildResult`): the environment
      // that executed the work is authoritative for it and is the one sending.
      return {
        sources: [payload.result.reportedBy, payload.result.delegation.owner],
        targets: [],
        envelopeId: payload.result.envelopeId,
      };
    case "review":
      return {
        sources: [payload.verdict.reviewer],
        targets: [],
        envelopeId: payload.verdict.envelopeId,
      };
    case "receipt":
      return {
        sources: [payload.receipt.acknowledgedBy],
        targets: [],
        envelopeId: undefined,
      };
  }
};

/**
 * Whether the payload's own claims agree with what the routing envelope's
 * signature authenticates.
 *
 * The Ed25519 signature covers the routing envelope's canonical serialization
 * and the AES-GCM seal binds the ciphertext to the envelope id — so the payload
 * cannot be swapped between envelopes. Neither, however, constrains what the
 * payload SAYS about itself: the addresses inside it are attacker-chosen text
 * until they are compared with the authenticated ones. This is that comparison.
 */
export const payloadMatchesEnvelope = (
  payload: WorkjetMailboxPayload,
  envelope: WorkjetRoutingEnvelope,
): boolean => {
  const claim = payloadClaim(payload);
  if (claim.envelopeId !== undefined && claim.envelopeId !== envelope.envelopeId) return false;
  const agrees = (address: ClaimedAddress, workspaceId: string, environmentId: string) =>
    address.workspaceId === workspaceId && address.environmentId === environmentId;
  return (
    claim.sources.every((address) =>
      agrees(address, envelope.sourceWorkspaceId, envelope.sourceEnvironmentId),
    ) &&
    claim.targets.every((address) =>
      agrees(address, envelope.targetWorkspaceId, envelope.targetEnvironmentId),
    )
  );
};

/**
 * Which rejection bucket a refused identity claim belongs in. The three are
 * genuinely different events and are counted apart on purpose: a DOWNGRADE is
 * an attack on the binding, a key CONFLICT is an attack on continuity, and a
 * REVOKED key is a local operator decision being honoured. Exported so a test
 * can hold the mapping rather than re-deriving it.
 */
export const rejectionKindOfBindingRefusal = (
  reason: WorkjetMailboxPeerBindingRejection,
): RejectionKind => {
  switch (reason) {
    case "binding-downgrade":
    case "binding-invalid":
      return "keyBinding";
    case "key-revoked":
      return "keyRevoked";
    case "signing-key-conflict":
    case "encryption-key-conflict":
      return "keyContinuity";
  }
};

type IngestOutcome =
  | { readonly _tag: "accepted" }
  | { readonly _tag: "duplicate" }
  | { readonly _tag: "rejected"; readonly kind: RejectionKind }
  /** The local store failed. Do NOT consume: the envelope must be retried. */
  | { readonly _tag: "deferred" };

export const makeWorkjetMailboxTransportWithSources = Effect.fn(
  "WorkjetMailboxTransport.makeWithSources",
)(function* (sources: WorkjetMailboxTransportSources) {
  const store = yield* WorkjetMailboxStore;
  const snapshots = yield* WorkjetSnapshotStore;
  const identity = yield* WorkjetMeshIdentity;
  const environment = yield* ServerEnvironment;
  const httpClient = yield* HttpClient.HttpClient;
  const sql = yield* SqlClient.SqlClient;

  const localEnvironmentId = yield* environment.getEnvironmentId;

  /**
   * Best-effort redacted audit emission, mirroring the best-effort activity
   * append. A failed emit never fails a transport cycle.
   */
  const emit = (event: WorkjetMailboxAuditEventInput) => emitAudit(sources.audit, event);

  /**
   * Record one failed push attempt against the outbox row AND emit the matching
   * redacted audit events: always a `mesh-replication-error` with a bounded
   * reason code, plus an `envelope-dead-lettered` when that attempt exhausted
   * the delivery budget. Best-effort throughout — it never fails the cycle, and
   * it emits AFTER the durable attempt record.
   */
  const failPush = (
    envelopeId: WorkjetOutboxRecord["envelopeId"],
    reasonCode:
      | "recipient-key-unknown"
      | "encode-failed"
      | "payload-too-large"
      | "publish-failed"
      | "transport-unavailable",
    now: WorkjetMailboxTimestamp,
  ) =>
    Effect.gen(function* () {
      const outcome = yield* store.recordAttempt(envelopeId, now).pipe(Effect.option);
      yield* emit({
        _tag: "mesh-replication-error",
        occurredAt: now,
        envelopeId,
        reasonCode,
      });
      if (Option.isSome(outcome) && outcome.value._tag === "dead-lettered") {
        yield* emit({
          _tag: "envelope-dead-lettered",
          occurredAt: now,
          envelopeId,
          attemptCount: outcome.value.attemptCount,
        });
      }
    });

  let counters = EMPTY_COUNTERS;
  let rejections = EMPTY_REJECTIONS;
  let running = false;
  let idleReason: WorkjetMailboxTransportIdleReason | null = null;
  let lastPushAtMillis: number | null = null;
  let lastPullAtMillis: number | null = null;

  const bump = (key: keyof WorkjetMailboxTransportCounters, by = 1) => {
    counters = { ...counters, [key]: counters[key] + by };
  };
  const reject = (kind: RejectionKind) => {
    rejections = { ...rejections, [kind]: rejections[kind] + 1 };
    bump("rejected");
  };

  const snapshot = (): WorkjetMailboxTransportStatus => ({
    schemaVersion: 1,
    running,
    idleReason,
    lastPushAtMillis,
    lastPullAtMillis,
    counters,
    rejections,
  });

  const millisOf = (iso: WorkjetMailboxTimestamp): number =>
    Option.match(DateTime.make(iso), {
      onNone: () => 0,
      onSome: DateTime.toEpochMillis,
    });

  // -----------------------------
  // Peer key continuity (TOFU)
  // -----------------------------

  /**
   * Pins the first key seen for a source pair and refuses any later different
   * one. The read and the insert are NOT one transaction on purpose: SQLite's
   * primary key is the real arbiter, so a concurrent second pull that inserted
   * first simply loses the insert and is then re-checked against the winner.
   */
  const readPeerKeys = (input: { readonly workspaceId: string; readonly environmentId: string }) =>
    sql<{
      readonly publicKey: string;
      readonly encryptionPublicKey: string | null;
      readonly keyBinding: string;
    }>`
      SELECT public_key AS "publicKey", encryption_public_key AS "encryptionPublicKey",
             key_binding AS "keyBinding"
      FROM workjet_mailbox_peer_keys
      WHERE source_workspace_id = ${input.workspaceId}
        AND source_environment_id = ${input.environmentId}
      LIMIT 1
    `.pipe(Effect.map((rows) => rows[0]));

  /**
   * Whether either key this envelope advertises was REVOKED on this machine
   * (migration 053).
   *
   * Revocation deletes the pin so a rotated peer can be re-pinned; this read is
   * the other half, and without it revocation would be worse than useless. The
   * operator revokes precisely because a key may be in the wrong hands, and
   * whoever holds it can send an envelope the moment the pin is gone — pinning
   * it again as a fresh first-use event and undoing the revocation. Both keys
   * are checked: adopting a revoked X25519 key alongside a new signing key
   * would still redirect every future sealed reply.
   *
   * The read is by ADDRESS and the comparison is in memory, because the
   * encryption key is not part of the tombstone's primary key. The row count
   * per address is the number of key generations an operator has revoked there
   * — a handful at most.
   */
  const keyRevoked = (input: {
    readonly workspaceId: string;
    readonly environmentId: string;
    readonly publicKey: string;
    readonly encryptionPublicKey: string | undefined;
  }) =>
    sql<{
      readonly publicKey: string;
      readonly encryptionPublicKey: string | null;
    }>`
      SELECT public_key AS "publicKey", encryption_public_key AS "encryptionPublicKey"
      FROM workjet_mailbox_peer_revocations
      WHERE source_workspace_id = ${input.workspaceId}
        AND source_environment_id = ${input.environmentId}
    `.pipe(
      Effect.map((rows) =>
        rows.some(
          (row) =>
            row.publicKey === input.publicKey ||
            (input.encryptionPublicKey !== undefined &&
              row.encryptionPublicKey === input.encryptionPublicKey),
        ),
      ),
    );

  /**
   * The verdict on one envelope's identity claim. `accepted` carries the level
   * the pin now stands at, so the caller can count sealed-but-unbound peers
   * separately from bound ones; every refusal carries the bounded code that
   * goes into the audit event and the rejection counter.
   */
  type PeerKeyVerdict =
    | { readonly _tag: "accepted"; readonly binding: WorkjetMeshPeerBinding }
    | { readonly _tag: "refused"; readonly reason: WorkjetMailboxPeerBindingRejection };

  const acceptPeerKey = Effect.fn("WorkjetMailboxTransport.acceptPeerKey")(function* (input: {
    readonly workspaceId: WorkjetMeshWorkspaceId;
    readonly environmentId: EnvironmentId;
    readonly publicKey: string;
    /** Absent for a v1 wrapper, which predates the encryption key entirely. */
    readonly encryptionPublicKey: string | undefined;
    /**
     * `true` when this envelope carried a key binding that ALREADY verified
     * against `publicKey`. The caller does the crypto; this function only
     * decides what that verified fact means for the durable pin.
     */
    readonly bound: boolean;
    readonly nowMillis: number;
  }) {
    const level: WorkjetMeshPeerBinding = input.bound ? "self-signed" : "tofu";

    // BEFORE the pin is read, let alone written. A revoked key is refused
    // whatever state the pin table is in, so the re-pin window a revocation
    // opens can only ever be filled by a key the operator did not revoke.
    if (yield* keyRevoked(input)) {
      return { _tag: "refused", reason: "key-revoked" } as const;
    }

    const pinned = yield* readPeerKeys(input);

    if (pinned !== undefined) {
      if (pinned.publicKey !== input.publicKey) {
        return { _tag: "refused", reason: "signing-key-conflict" } as const;
      }

      // A peer whose keys were pinned under a verified binding must never fall
      // back to bare trust-on-first-use. Without this, an attacker strips the
      // `keyBinding` field (or replays a v2 wrapper) and is back to the exact
      // substitution the binding exists to prevent.
      if (pinned.keyBinding === "self-signed" && !input.bound) {
        return { _tag: "refused", reason: "binding-downgrade" } as const;
      }

      if (input.encryptionPublicKey === undefined) {
        // A v1 straggler. Its silence about the encryption key is not evidence
        // of a rotation, so an already-learned key must survive it untouched.
        return { _tag: "accepted", binding: pinned.keyBinding as WorkjetMeshPeerBinding } as const;
      }

      if (pinned.encryptionPublicKey === null) {
        // The signing key was pinned before this peer ever advertised an
        // encryption key (a pre-044 row, or a v1 first contact). Learning it now
        // is the SAME first-use event, one field later — and the binding level
        // is set with it, because the key and the proof of who chose it arrive
        // together or not at all.
        yield* sql`
          UPDATE workjet_mailbox_peer_keys
          SET encryption_public_key = ${input.encryptionPublicKey},
              key_binding = ${level}
          WHERE source_workspace_id = ${input.workspaceId}
            AND source_environment_id = ${input.environmentId}
            AND encryption_public_key IS NULL
        `;
        const winner = yield* readPeerKeys(input);
        // A concurrent pull may have filled the column first; whichever key won
        // is now THE pinned key, and this envelope is judged against it.
        return winner?.encryptionPublicKey === input.encryptionPublicKey
          ? ({
              _tag: "accepted",
              binding: (winner?.keyBinding ?? level) as WorkjetMeshPeerBinding,
            } as const)
          : ({ _tag: "refused", reason: "encryption-key-conflict" } as const);
      }

      // Continuity applies to both keys with the same severity: silently
      // adopting a rotated encryption key would let a room member redirect a
      // peer's future replies to itself.
      if (pinned.encryptionPublicKey !== input.encryptionPublicKey) {
        return { _tag: "refused", reason: "encryption-key-conflict" } as const;
      }

      // The keys are unchanged and this envelope proved the binding the stored
      // row never had. UPGRADING is safe in a way downgrading is not: it is the
      // same key material, now with evidence attached.
      if (input.bound && pinned.keyBinding !== "self-signed") {
        yield* sql`
          UPDATE workjet_mailbox_peer_keys
          SET key_binding = 'self-signed'
          WHERE source_workspace_id = ${input.workspaceId}
            AND source_environment_id = ${input.environmentId}
            AND public_key = ${input.publicKey}
            AND encryption_public_key = ${input.encryptionPublicKey}
        `;
        return { _tag: "accepted", binding: "self-signed" } as const;
      }
      return { _tag: "accepted", binding: pinned.keyBinding as WorkjetMeshPeerBinding } as const;
    }

    yield* sql`
      INSERT OR IGNORE INTO workjet_mailbox_peer_keys
        (source_workspace_id, source_environment_id, public_key, encryption_public_key,
         first_seen_at_ms, key_binding)
      VALUES (${input.workspaceId}, ${input.environmentId}, ${input.publicKey},
              ${input.encryptionPublicKey ?? null}, ${input.nowMillis}, ${level})
    `;

    const winner = yield* readPeerKeys(input);
    if (winner?.publicKey !== input.publicKey) {
      return { _tag: "refused", reason: "signing-key-conflict" } as const;
    }
    if (
      input.encryptionPublicKey !== undefined &&
      winner.encryptionPublicKey !== null &&
      winner.encryptionPublicKey !== input.encryptionPublicKey
    ) {
      return { _tag: "refused", reason: "encryption-key-conflict" } as const;
    }
    return {
      _tag: "accepted",
      binding: (winner.keyBinding ?? level) as WorkjetMeshPeerBinding,
    } as const;
  });

  /**
   * The recipient's pinned encryption key. The three outcomes are kept distinct
   * on purpose: `first-contact` is the documented, bounded plaintext case,
   * while `unreadable` is a LOCAL fault that must not be mistaken for it — a
   * broken table read may never silently downgrade an established peer back to
   * plaintext, so that push is deferred to the next cycle instead.
   */
  const recipientEncryptionKey = (input: {
    readonly workspaceId: string;
    readonly environmentId: string;
  }): Effect.Effect<
    | { readonly _tag: "pinned"; readonly key: string }
    | { readonly _tag: "first-contact" }
    | { readonly _tag: "unreadable" }
  > =>
    readPeerKeys(input).pipe(
      Effect.map((row) =>
        row?.encryptionPublicKey == null
          ? ({ _tag: "first-contact" } as const)
          : ({ _tag: "pinned", key: row.encryptionPublicKey } as const),
      ),
      Effect.orElseSucceed(() => ({ _tag: "unreadable" }) as const),
    );

  // -----------------------------
  // Loopback calls
  // -----------------------------

  /**
   * One authenticated loopback call. Everything a failure could reveal — the
   * daemon's status text, an HTTP error, a timeout — collapses into `None`: the
   * caller's only decision is "did the daemon answer usefully or not", and the
   * bounded status snapshot is the sole place a failure is ever counted.
   */
  const call = (input: {
    readonly endpoint: CtoxDaemonEndpoint;
    readonly token: string;
    readonly request: HttpClientRequest.HttpClientRequest;
  }): Effect.Effect<Option.Option<unknown>> =>
    Effect.gen(function* () {
      const response = yield* httpClient.execute(
        input.request.pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(input.token),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* Effect.fail({
          _tag: "CtoxMailboxRequestRejected",
          status: response.status,
        } as const);
      }
      return yield* response.json;
    }).pipe(
      Effect.scoped,
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.option,
      Effect.map((value) => value as Option.Option<unknown>),
    );

  // -----------------------------
  // PUSH
  // -----------------------------

  /**
   * The publish document. `id`, `target_environment_id`, `envelope_json` and
   * `payload_json` are required by CTOX; the routing hints are OPTIONAL there
   * and are omitted when they do not satisfy CTOX's narrower id charset — the
   * authoritative copy of every address lives inside the signed `envelope_json`
   * regardless, so omitting a hint costs nothing while sending an unacceptable
   * one would 400 a perfectly valid envelope.
   */
  const publishDocument = (input: {
    readonly record: WorkjetOutboxRecord;
    readonly envelopeJson: string;
    readonly payloadJson: string;
  }) => {
    const envelope = input.record.envelope;
    const hints: Record<string, string> = {};
    if (isCtoxSafeId(envelope.sourceWorkspaceId)) {
      hints["source_workspace_id"] = envelope.sourceWorkspaceId;
    }
    if (isCtoxSafeId(envelope.targetWorkspaceId)) {
      hints["target_workspace_id"] = envelope.targetWorkspaceId;
    }
    if (isCtoxSafeId(envelope.sourceEnvironmentId)) {
      hints["source_environment_id"] = envelope.sourceEnvironmentId;
    }
    return {
      id: envelope.envelopeId,
      target_environment_id: envelope.targetEnvironmentId,
      ...hints,
      created_at_ms: input.record.createdAtMillis,
      expires_at_ms: input.record.expiresAtMillis,
      envelope_json: input.envelopeJson,
      payload_json: input.payloadJson,
    };
  };

  const pushOne = Effect.fn("WorkjetMailboxTransport.pushOne")(function* (input: {
    readonly endpoint: CtoxDaemonEndpoint;
    readonly token: string;
    readonly record: WorkjetOutboxRecord;
    readonly now: WorkjetMailboxTimestamp;
  }) {
    const envelope = input.record.envelope;
    const envelopeJson = yield* encodeEnvelopeJson(envelope).pipe(Effect.option);

    // A local fault reading the pin is NOT first contact: defer rather than
    // downgrade a peer that may well have a pinned key.
    const recipient = yield* recipientEncryptionKey({
      workspaceId: envelope.targetWorkspaceId,
      environmentId: envelope.targetEnvironmentId,
    });
    if (recipient._tag === "unreadable") {
      yield* failPush(input.record.envelopeId, "recipient-key-unknown", input.now);
      bump("pushFailures");
      return;
    }

    /**
     * Encodes ONE payload into the wire wrapper for this recipient: sealed to
     * the pinned key, or plaintext on first contact. `None` is a genuine fault
     * (a pinned recipient whose payload will not seal — never a reason to fall
     * back to plaintext — or a wrapper that will not encode), distinct from an
     * oversized-but-valid wrapper, whose size is judged separately against the
     * wire ceiling below.
     */
    const buildWire = (
      payload: WorkjetMailboxPayload,
    ): Effect.Effect<Option.Option<{ readonly json: string; readonly sealed: boolean }>> =>
      Effect.gen(function* () {
        const sealed =
          recipient._tag === "pinned"
            ? yield* encodePayloadJson(payload).pipe(
                Effect.flatMap((plaintext) =>
                  identity.sealTo(
                    recipient.key,
                    new TextEncoder().encode(plaintext),
                    envelope.envelopeId,
                  ),
                ),
                Effect.option,
              )
            : Option.none();
        if (recipient._tag === "pinned" && Option.isNone(sealed)) return Option.none();

        // The binding is signed over the SIGNED envelope's own source pair and
        // envelope id, never over anything the caller chose, so a wrapper can
        // only ever assert the address the routing envelope already claims.
        const keyBinding = yield* identity
          .signKeyBinding({
            envelopeId: envelope.envelopeId,
            sourceWorkspaceId: envelope.sourceWorkspaceId,
            sourceEnvironmentId: envelope.sourceEnvironmentId,
          })
          .pipe(Effect.option);
        // A wrapper without a binding would be pinned as bare `tofu` by the
        // receiver and would fail outright against a peer that has already seen
        // a bound wrapper. Shipping one is worse than not shipping the
        // envelope, so a signing fault takes the ordinary attempt budget.
        if (Option.isNone(keyBinding)) return Option.none();

        const json = yield* encodeWrapperJson({
          schemaVersion: 3,
          senderSigningKey: identity.publicKey,
          senderEncryptionKey: identity.encryptionPublicKey,
          keyBinding: keyBinding.value,
          body: Option.match(sealed, {
            onSome: (blob) => ({ sealed: blob }) as const,
            onNone: () => ({ plain: payload, reason: "recipient-key-unknown" }) as const,
          }),
        }).pipe(Effect.option);
        return Option.map(json, (value) => ({ json: value, sealed: Option.isSome(sealed) }));
      });

    const withinCeiling = (json: string): boolean =>
      Buffer.byteLength(json, "utf8") <= WORKJET_TRANSPORT_PAYLOAD_CEILING_BYTES;

    // A cross-environment delegation carries only a snapshot REFERENCE; its
    // bytes live in THIS machine's snapshot store. Attach them so the receiver
    // can run the task without waiting for a separate snapshot transfer, but
    // only when the sealed wrapper still fits the wire — a bounded transfer,
    // never an unbounded one. If they will not fit, ship the delegation
    // reference-only with a `snapshot-oversized` marker rather than dropping it.
    let attachedSnapshot = false;
    let markedOversized = false;
    let wire: Option.Option<{ readonly json: string; readonly sealed: boolean }>;

    if (input.record.payload._tag === "delegation" || input.record.payload._tag === "handoff") {
      // A handoff carries a CONTEXT snapshot where a delegation carries a
      // PROMPT snapshot. Both are one content-addressed object pinned by digest
      // on this machine, and both must arrive with their bytes or the receiver
      // has a reference it cannot resolve — so they take the identical path,
      // with the same ceiling, the same fallback marker, and the same counters.
      const carrier = input.record.payload;
      const digest =
        carrier._tag === "delegation"
          ? carrier.delegation.prompt.digest
          : carrier.handoff.contextSnapshot.digest;
      const snapshotText = yield* snapshots.get(digest).pipe(Effect.option);

      if (Option.isSome(snapshotText)) {
        const withBytes = {
          ...carrier,
          snapshotBytes: snapshotText.value,
        } as const satisfies WorkjetMailboxPayload;
        const attached = yield* buildWire(withBytes);
        if (Option.isSome(attached) && withinCeiling(attached.value.json)) {
          wire = attached;
          attachedSnapshot = true;
        } else {
          // The snapshot will not fit sealed. Fall back to reference-only plus
          // the marker, which the receiver surfaces as a bounded reason.
          const { snapshotBytes: _dropped, ...refOnly } = withBytes;
          wire = yield* buildWire({
            ...refOnly,
            snapshotOversized: true,
          } as const satisfies WorkjetMailboxPayload);
          markedOversized = true;
        }
      } else {
        // The bytes are not on this machine (a source-side gap; cross-machine
        // snapshot fetch is a later slice). Ship the reference exactly as before
        // so the receiver's executor waits on `missingSnapshot`, unchanged, and
        // a handoff arrives listed as not-continuable rather than not at all.
        wire = yield* buildWire(carrier);
      }
    } else {
      wire = yield* buildWire(input.record.payload);
    }

    // An outbox row that cannot be re-encoded — or a pinned recipient whose
    // payload will not seal — is a local fault. It still walks the ordinary
    // attempt budget to its dead-letter state rather than being deleted behind
    // the operator's back.
    if (Option.isNone(envelopeJson) || Option.isNone(wire)) {
      yield* failPush(input.record.envelopeId, "encode-failed", input.now);
      bump("pushFailures");
      return;
    }

    // The daemon refuses a `payload_json` over 200 000 bytes, and base64url
    // plus the GCM tag make a sealed wrapper measurably larger than the payload
    // it wraps. A delegation whose snapshot pushes it over already took the
    // reference-only path above, so anything still over the ceiling here is a
    // genuinely oversized payload: a typed `payload-too-large` decision with the
    // real wire bytes in hand, rather than a 400 the loop would keep retrying.
    const wireBytes = Buffer.byteLength(wire.value.json, "utf8");
    if (wireBytes > WORKJET_TRANSPORT_PAYLOAD_CEILING_BYTES) {
      yield* failPush(input.record.envelopeId, "payload-too-large", input.now);
      yield* Effect.logDebug("Workjet mailbox transport refused an oversized payload").pipe(
        Effect.annotateLogs({
          reason: new WorkjetMailboxError({ reason: "payload-too-large" }).reason,
          wireBytes,
          ceiling: WORKJET_TRANSPORT_PAYLOAD_CEILING_BYTES,
        }),
      );
      bump("payloadTooLarge");
      bump("pushFailures");
      return;
    }

    const result = yield* call({
      endpoint: input.endpoint,
      token: input.token,
      request: HttpClientRequest.post(`${input.endpoint.baseUrl}/workjet/mailbox/publish`).pipe(
        HttpClientRequest.bodyJsonUnsafe(
          publishDocument({
            record: input.record,
            envelopeJson: envelopeJson.value,
            payloadJson: wire.value.json,
          }),
        ),
      ),
    });

    if (Option.isNone(result)) {
      yield* failPush(input.record.envelopeId, "publish-failed", input.now);
      bump("pushFailures");
      return;
    }

    // A duplicate is a SUCCESS: the document is already in the replicating
    // collection, which is exactly what "delivered" means on this hop.
    const decoded = yield* decodePublishResult(result.value).pipe(Effect.option);
    const duplicate = Option.isSome(decoded) && decoded.value.duplicate === true;

    yield* store.markDelivered(input.record.envelopeId, input.now).pipe(Effect.ignore);
    bump(duplicate ? "pushDuplicates" : "pushed");
    bump(wire.value.sealed ? "sealed" : "plainFirstContact");
    if (attachedSnapshot) bump("snapshotAttached");
    if (markedOversized) bump("snapshotOversized");
  });

  const push = Effect.fn("WorkjetMailboxTransport.push")(function* (input: {
    readonly endpoint: CtoxDaemonEndpoint;
    readonly token: string;
    readonly now: WorkjetMailboxTimestamp;
  }) {
    const pending = yield* store
      .listPendingOutbound(input.now, WORKJET_TRANSPORT_PUSH_LIMIT)
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<WorkjetOutboxRecord>));

    // Same-environment envelopes were already delivered by the local fast path;
    // handing them to the daemon would replicate them back to this machine.
    const remote = pending.filter(
      (record) => record.envelope.targetEnvironmentId !== localEnvironmentId,
    );
    for (const record of remote) {
      yield* pushOne({ ...input, record });
    }
    if (remote.length > 0) lastPushAtMillis = millisOf(input.now);
  });

  // -----------------------------
  // PULL
  // -----------------------------

  /**
   * The payload a wrapper carries, whichever wire form it arrived in:
   *
   * - a v1 wrapper (migration window) carries it directly,
   * - a v2 `{plain}` body carries it directly and says why it is not sealed,
   * - a v2 `{sealed}` body is opened with this environment's encryption key and
   *   the envelope id as AAD, then decoded from its canonical JSON encoding.
   *
   * `None` means the payload could not be recovered — a blob sealed to another
   * environment, a tampered ciphertext, a replay lifted onto a different
   * envelope id, or a plaintext that no longer decodes. All of them are one
   * bounded rejection so a peer cannot probe which check it tripped.
   */
  const unwrapPayload = (
    wrapper: WorkjetTransportPayloadWrapper,
    envelopeId: string,
  ): Effect.Effect<
    Option.Option<{
      readonly payload: WorkjetMailboxPayload;
      readonly sealed: boolean;
    }>
  > => {
    if (wrapper.schemaVersion === 1) {
      return Effect.succeed(Option.some({ payload: wrapper.payload, sealed: false }));
    }
    if ("plain" in wrapper.body) {
      return Effect.succeed(Option.some({ payload: wrapper.body.plain, sealed: false }));
    }
    return identity.openSealed(wrapper.body.sealed, envelopeId).pipe(
      Effect.flatMap((plaintext) => decodePayloadJson(new TextDecoder().decode(plaintext))),
      Effect.map((payload) => ({ payload, sealed: true })),
      Effect.option,
    );
  };

  const ingest = (input: {
    readonly document: typeof CtoxEnvelopeDocument.Type;
    readonly now: WorkjetMailboxTimestamp;
    readonly nowMillis: number;
  }): Effect.Effect<IngestOutcome> =>
    Effect.gen(function* () {
      const envelope = yield* decodeEnvelopeJson(input.document.envelope_json).pipe(Effect.option);
      if (Option.isNone(envelope)) return { _tag: "rejected", kind: "malformed" } as const;

      const payloadJson = input.document.payload_json;
      if (payloadJson === undefined) return { _tag: "rejected", kind: "malformed" } as const;
      const wrapper = yield* decodeWrapperJson(payloadJson).pipe(Effect.option);
      if (Option.isNone(wrapper)) return { _tag: "rejected", kind: "malformed" } as const;

      // The daemon's document id and the signed envelope id must agree, and the
      // envelope must actually be addressed here. Neither is checked by CTOX: it
      // does not read the envelope at all.
      if (
        input.document.id !== envelope.value.envelopeId ||
        envelope.value.targetEnvironmentId !== localEnvironmentId
      ) {
        return { _tag: "rejected", kind: "misaddressed" } as const;
      }

      if (millisOf(envelope.value.expiresAt) <= input.nowMillis) {
        return { _tag: "rejected", kind: "expired" } as const;
      }

      // v1, v2 and v3 wrappers are normalized to one shape here, so nothing
      // below has to know which migration-window form arrived. `binding` is
      // `undefined` for every form that predates it.
      const keys =
        wrapper.value.schemaVersion === 1
          ? {
              signing: wrapper.value.senderPublicKey,
              encryption: undefined,
              binding: undefined,
            }
          : {
              signing: wrapper.value.senderSigningKey,
              encryption: wrapper.value.senderEncryptionKey,
              binding: wrapper.value.schemaVersion === 3 ? wrapper.value.keyBinding : undefined,
            };

      const verified = yield* identity.verifyRoutingEnvelope(envelope.value, keys.signing);
      if (!verified) return { _tag: "rejected", kind: "signature" } as const;

      /** Refuse this envelope's identity claim, audited with its bounded code. */
      const refuseBinding = (reasonCode: WorkjetMailboxPeerBindingRejection, kind: RejectionKind) =>
        emit({
          _tag: "mesh-peer-binding-rejected",
          occurredAt: input.now,
          envelopeId: envelope.value.envelopeId,
          sourceWorkspaceId: envelope.value.sourceWorkspaceId,
          sourceEnvironmentId: envelope.value.sourceEnvironmentId,
          reasonCode,
        }).pipe(Effect.as({ _tag: "rejected", kind } as const));

      // The key binding is checked against the SAME key the routing envelope
      // just verified against — not against the key the binding names — so a
      // peer cannot bind its own keypair onto somebody else's signed envelope.
      // The claim is rebuilt from the SIGNED envelope's fields, so a binding
      // lifted from another envelope or another source pair cannot verify here
      // even though it is a genuine signature somewhere else.
      let bound = false;
      if (keys.binding !== undefined && keys.encryption !== undefined) {
        bound = yield* identity.verifyKeyBinding(
          {
            envelopeId: envelope.value.envelopeId,
            sourceWorkspaceId: envelope.value.sourceWorkspaceId,
            sourceEnvironmentId: envelope.value.sourceEnvironmentId,
            senderSigningKey: keys.signing,
            senderEncryptionKey: keys.encryption,
          },
          keys.binding,
        );
        // A wrapper that CARRIES a binding and fails it is not a peer without
        // one: it is a forgery or a lifted signature, and it is refused rather
        // than quietly demoted to trust-on-first-use.
        if (!bound) return yield* refuseBinding("binding-invalid", "keyBinding");
      }

      // Continuity is checked only AFTER the signature and the binding verify,
      // so a forged envelope can never pin a key for a source it does not
      // control, and an unverifiable binding never reaches the pin table.
      const verdict = yield* acceptPeerKey({
        workspaceId: envelope.value.sourceWorkspaceId,
        environmentId: envelope.value.sourceEnvironmentId,
        publicKey: keys.signing,
        encryptionPublicKey: keys.encryption,
        bound,
        nowMillis: input.nowMillis,
      }).pipe(Effect.orElseSucceed(() => null));
      if (verdict === null) return { _tag: "deferred" } as const;
      if (verdict._tag === "refused") {
        // A downgrade is an attack on the binding, the two key conflicts are
        // attacks on continuity. They are audited alike and counted apart.
        return yield* refuseBinding(verdict.reason, rejectionKindOfBindingRefusal(verdict.reason));
      }
      bump(verdict.binding === "self-signed" ? "bindingVerified" : "bindingAbsent");

      // Unsealing happens only after signature AND continuity: a blob is opened
      // solely for a sender whose key this machine has already accepted.
      const opened = yield* unwrapPayload(wrapper.value, envelope.value.envelopeId);
      if (Option.isNone(opened)) return { _tag: "rejected", kind: "sealing" } as const;
      const openedPayload = opened.value.payload;
      if (opened.value.sealed) bump("unsealed");

      // The signature authenticates the ENVELOPE's addresses; nothing so far
      // constrains the addresses the payload claims for itself. An authenticated
      // peer that is free to name a different source or target speaks for
      // environments it does not hold a key for, so the two must agree before
      // any durable write — including the snapshot `put` immediately below.
      if (!payloadMatchesEnvelope(openedPayload, envelope.value)) {
        return { _tag: "rejected", kind: "addressMismatch" } as const;
      }

      // A cross-machine delegation may carry its prompt snapshot bytes (or a
      // marker that they were too large to seal). Handle that BEFORE any durable
      // write: store the bytes into the LOCAL snapshot store with digest
      // re-verification, then strip them so the persisted envelope and
      // delegation row stay reference-only, exactly like the local fast path.
      let payload = openedPayload;
      let storedSnapshot = false;
      let receivedOversized = false;
      if (openedPayload._tag === "delegation" || openedPayload._tag === "handoff") {
        const declaredDigest =
          openedPayload._tag === "delegation"
            ? openedPayload.delegation.prompt.digest
            : openedPayload.handoff.contextSnapshot.digest;
        if (openedPayload.snapshotBytes !== undefined) {
          const stored = yield* snapshots.put(openedPayload.snapshotBytes).pipe(Effect.result);
          if (stored._tag === "Failure") {
            // A local snapshot-store fault (I/O). Retry rather than consume: the
            // envelope is still on the daemon and the next cycle re-reads it.
            return { _tag: "deferred" } as const;
          }
          if (stored.success.digest !== declaredDigest) {
            // The declared digest and the actual bytes disagree. The bytes are
            // worthless and a matching snapshot could only arrive under a
            // different envelope, so this one is consumed, never looped.
            return { _tag: "rejected", kind: "snapshotDigest" } as const;
          }
          storedSnapshot = true;
        } else if (openedPayload.snapshotOversized === true) {
          receivedOversized = true;
        }
        // Reference-only from here on, whichever branch ran, so the persisted
        // envelope, delegation row, and handoff row match the local fast path
        // exactly.
        payload =
          openedPayload._tag === "delegation"
            ? ({ _tag: "delegation", delegation: openedPayload.delegation } as const)
            : ({ _tag: "handoff", handoff: openedPayload.handoff } as const);
      }

      const recorded = yield* store
        .recordInboundEnvelope(envelope.value, payload, input.now)
        .pipe(Effect.result);

      if (recorded._tag === "Failure") {
        // A bounded mailbox reason is a DECISION about this envelope (expired,
        // malformed) and is final; anything else is a local store fault and must
        // be retried rather than consumed.
        return isBoundedMailboxError(recorded.failure)
          ? ({ _tag: "rejected", kind: "malformed" } as const)
          : ({ _tag: "deferred" } as const);
      }

      // A replay re-`put`s the same content-addressed bytes (an idempotent
      // no-op) but must not re-count: the counters describe the FIRST acceptance
      // of each envelope, exactly like `accepted` itself.
      if (recorded.success._tag !== "accepted-new") return { _tag: "duplicate" } as const;

      if (storedSnapshot) bump("snapshotStored");
      if (receivedOversized) {
        // The source could not seal the snapshot within the wire ceiling. The
        // delegation is still valid; it stays `delivered` (the executor waits on
        // `missingSnapshot`) and this bounded reason is surfaced, never dropped.
        bump("snapshotOversizedReceived");
        yield* Effect.logDebug("Workjet delegation arrived reference-only: snapshot oversized");
      }

      if (payload._tag === "delegation") {
        // The SAME store semantics the local fast path applies, through the same
        // shared helper — `upsert: true` because this machine has never seen the
        // delegation before, so its `queued` row does not exist yet.
        const applied = yield* applyDeliveredDelegation({
          store,
          delegation: payload.delegation,
          now: input.now,
          upsert: true,
        }).pipe(Effect.result);
        if (applied._tag === "Failure") return { _tag: "deferred" } as const;
      }

      if (payload._tag === "handoff") {
        // The receiving half of a handoff: one durable inbox row, keyed by the
        // sender's handoff id, so a replay offers ONE continuation and not two.
        // It is written through the same store the local fast path uses, so the
        // two arrival routes cannot drift into two inbox shapes.
        const recorded = yield* store
          .upsertReceivedHandoff(payload.handoff, input.now)
          .pipe(Effect.result);
        if (recorded._tag === "Failure") return { _tag: "deferred" } as const;
      }

      return { _tag: "accepted" } as const;
    });

  const markConsumed = Effect.fn("WorkjetMailboxTransport.markConsumed")(function* (input: {
    readonly endpoint: CtoxDaemonEndpoint;
    readonly token: string;
    readonly envelopeIds: ReadonlyArray<string>;
  }) {
    for (let index = 0; index < input.envelopeIds.length; index += CONSUMED_BATCH_LIMIT) {
      const batch = input.envelopeIds.slice(index, index + CONSUMED_BATCH_LIMIT);
      const result = yield* call({
        endpoint: input.endpoint,
        token: input.token,
        request: HttpClientRequest.post(`${input.endpoint.baseUrl}/workjet/mailbox/consumed`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            environment_id: localEnvironmentId,
            envelope_ids: batch,
          }),
        ),
      });
      // A failed consume is safe: the envelope is already durable and idempotent
      // locally, so the next cycle re-reads it and re-consumes it.
      if (Option.isSome(result)) bump("consumed", batch.length);
    }
  });

  const pull = Effect.fn("WorkjetMailboxTransport.pull")(function* (input: {
    readonly endpoint: CtoxDaemonEndpoint;
    readonly token: string;
    readonly now: WorkjetMailboxTimestamp;
  }) {
    const nowMillis = millisOf(input.now);
    const url = new URL(`${input.endpoint.baseUrl}/workjet/mailbox/pending`);
    url.searchParams.set("environment_id", localEnvironmentId);
    url.searchParams.set("limit", String(WORKJET_TRANSPORT_PULL_LIMIT));

    const raw = yield* call({
      endpoint: input.endpoint,
      token: input.token,
      request: HttpClientRequest.get(url.toString()),
    });
    if (Option.isNone(raw)) return;

    const page = yield* decodePendingPage(raw.value).pipe(Effect.option);
    if (Option.isNone(page)) return;

    lastPullAtMillis = nowMillis;
    const consumable: Array<string> = [];

    for (const document of page.value.envelopes) {
      bump("pulled");
      const outcome = yield* ingest({ document, now: input.now, nowMillis });
      switch (outcome._tag) {
        case "accepted":
          bump("accepted");
          consumable.push(document.id);
          break;
        case "duplicate":
          // A replay is consumed WITHOUT re-running any effect: at-least-once
          // transport, exactly-once delegation effects by deduplication.
          bump("inboundDuplicates");
          consumable.push(document.id);
          break;
        case "rejected":
          // Poison envelopes are consumed too, or every cycle would re-read the
          // same unusable document forever.
          reject(outcome.kind);
          consumable.push(document.id);
          break;
        case "deferred":
          bump("deferred");
          break;
      }
    }

    if (consumable.length > 0) {
      yield* markConsumed({
        endpoint: input.endpoint,
        token: input.token,
        envelopeIds: consumable,
      });
    }
  });

  // -----------------------------
  // Cycle
  // -----------------------------

  const runCycle = Effect.fn("WorkjetMailboxTransport.runCycle")(function* () {
    // CTOX rejects an environment id outside `[A-Za-z0-9_-]{1,128}` on every
    // route, so an unsupported id is an honest permanent idle rather than a
    // per-request 400 storm.
    if (!isCtoxSafeId(localEnvironmentId)) {
      running = false;
      idleReason = "environment-id-unsupported";
      yield* Effect.logDebug("Workjet mailbox transport idle").pipe(
        Effect.annotateLogs({ idleReason }),
      );
      return snapshot();
    }

    const resolved = yield* sources.resolveEndpoint;
    if (resolved._tag === "idle") {
      running = false;
      idleReason = resolved.reason;
      yield* Effect.logDebug("Workjet mailbox transport idle").pipe(
        Effect.annotateLogs({ idleReason }),
      );
      return snapshot();
    }

    const token = yield* sources.resolveAuthToken;
    if (Option.isNone(token)) {
      running = false;
      idleReason = "token-unavailable";
      // The token itself never appears here, only the fact that it is missing.
      yield* Effect.logDebug("Workjet mailbox transport idle").pipe(
        Effect.annotateLogs({ idleReason }),
      );
      return snapshot();
    }

    running = true;
    idleReason = null;

    const now = yield* sources.nowIso;
    const context = { endpoint: resolved.endpoint, token: token.value, now };
    yield* push(context);
    yield* pull(context);
    return snapshot();
  });

  return WorkjetMailboxTransport.of({
    status: Effect.sync(snapshot),
    // One wedged cycle must never take the server down or stop the loop: the
    // next cycle re-resolves the daemon and starts clean.
    runCycle: runCycle().pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(60),
        orElse: () => Effect.sync(snapshot),
      }),
      Effect.catchCause(() => Effect.sync(snapshot)),
    ),
  });
});

export const makeWorkjetMailboxTransport = Effect.fn("WorkjetMailboxTransport.make")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const auditEmitter = yield* WorkjetMailboxAuditEmitter;

  return yield* makeWorkjetMailboxTransportWithSources({
    nowIso: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
    audit: { emit: auditEmitter.publish },
    // Re-resolved every cycle on purpose: the daemon may be installed, started,
    // restarted on a new port, or stopped while this server keeps running.
    resolveEndpoint: Effect.suspend(() =>
      resolveCtoxEndpointFromDescriptor({
        fileSystem,
        path: ctoxDescriptorPath(path, process.env),
        nowMillis: DateTime.now.pipe(Effect.map(DateTime.toEpochMillis)),
      }),
    ),
    resolveAuthToken: Effect.suspend(() =>
      resolveCtoxAuthTokenFromCli({ runner, env: process.env }),
    ),
  });
});

/**
 * The service plus its jittered poll loop. The loop is forked into the layer's
 * scope, so it stops exactly when the server's runtime does, and it is jittered
 * so several machines in one room never align their polls on the same second.
 */
export const layer = Layer.effect(
  WorkjetMailboxTransport,
  Effect.gen(function* () {
    const transport = yield* makeWorkjetMailboxTransport();
    yield* transport.runCycle.pipe(
      Effect.repeat(Schedule.spaced(WORKJET_TRANSPORT_POLL_INTERVAL).pipe(Schedule.jittered)),
      Effect.forkScoped,
    );
    return transport;
  }),
);
