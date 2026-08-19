import * as NodeOS from "node:os";

import {
  WorkjetMailboxError,
  WorkjetMailboxPayload,
  WorkjetRoutingEnvelope,
  type EnvironmentId,
  type WorkjetMailboxTimestamp,
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
import { applyDeliveredDelegation } from "./WorkjetMailboxDelivery.ts";
import {
  WorkjetMailboxStore,
  type WorkjetMailboxStoreError,
  type WorkjetOutboxRecord,
} from "./WorkjetMailboxStore.ts";
import { WorkjetMeshIdentity } from "./WorkjetMeshIdentity.ts";

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
 * ## Interim sender-key distribution — READ THIS
 *
 * A pulled envelope must be verified against the SENDER's public key, and the
 * daemon cannot supply it: it is opaque to the envelope's contents by design.
 * Until the CTOX-room-derived identity binding lands (the same open plan item
 * that will replace the generated {@link WorkjetMeshWorkspaceId}), this slice
 * uses a documented interim mechanism:
 *
 *   payload_json = { schemaVersion, senderPublicKey, payload }
 *
 * The sender's public key travels WITH the payload. On its own that proves
 * nothing — anyone who can write to the collection could assert any key — so it
 * is paired with two independent constraints:
 *
 *  1. **CTOX room membership.** Only machines already paired into the room
 *     replicate this collection at all. The room, its password, and the
 *     capability/session layer are the daemon's existing admission control.
 *  2. **Key continuity (TOFU).** The first key seen for a
 *     `(sourceWorkspaceId, sourceEnvironmentId)` pair is pinned durably
 *     (migration 043). A later envelope from that same source carrying a
 *     DIFFERENT key is rejected with `invalid-signature`, counted, and consumed
 *     — never silently adopted, which would make the self-asserted key useless.
 *
 * Trust root = room membership + continuity. This is strictly weaker than a
 * room-derived binding and is explicitly interim. It does NOT weaken the local
 * fast path, which continues to verify against this environment's own key and
 * never consults a peer key at all.
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
}

/** Why a pulled envelope was refused. Poison envelopes are consumed, not looped. */
export interface WorkjetMailboxTransportRejections {
  readonly malformed: number;
  readonly misaddressed: number;
  readonly expired: number;
  readonly signature: number;
  readonly keyContinuity: number;
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
};

const EMPTY_REJECTIONS: WorkjetMailboxTransportRejections = {
  malformed: 0,
  misaddressed: 0,
  expired: 0,
  signature: 0,
  keyContinuity: 0,
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
  status: Schema.String,
  lastSeenAt: Schema.Number,
  healthUrl: Schema.optional(Schema.String),
});

const decodeDescriptor = Schema.decodeUnknownEffect(Schema.fromJsonString(CtoxInstanceDescriptor));

export interface CtoxDaemonEndpoint {
  /** Base URL of the loopback MCP-channel listener, with no trailing slash. */
  readonly baseUrl: string;
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

/**
 * What travels in `payload_json`. The routing envelope keeps its own contract
 * shape in `envelope_json`; this wrapper exists solely to carry the interim
 * sender key alongside the payload without touching the signed bytes.
 */
export const WorkjetTransportPayloadWrapper = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  senderPublicKey: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,512}$/)),
  payload: WorkjetMailboxPayload,
});
export type WorkjetTransportPayloadWrapper = typeof WorkjetTransportPayloadWrapper.Type;

const encodeWrapperJson = Schema.encodeEffect(
  Schema.fromJsonString(WorkjetTransportPayloadWrapper),
);
const decodeWrapperJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WorkjetTransportPayloadWrapper),
);
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
    return Option.match(baseUrl, {
      onNone: () => ({ _tag: "idle", reason: "daemon-endpoint-unusable" }) as const,
      onSome: (url) => ({ _tag: "resolved", endpoint: { baseUrl: url } }) as const,
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
  const identity = yield* WorkjetMeshIdentity;
  const environment = yield* ServerEnvironment;
  const httpClient = yield* HttpClient.HttpClient;
  const sql = yield* SqlClient.SqlClient;

  const localEnvironmentId = yield* environment.getEnvironmentId;

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
  const acceptPeerKey = Effect.fn("WorkjetMailboxTransport.acceptPeerKey")(function* (input: {
    readonly workspaceId: WorkjetMeshWorkspaceId;
    readonly environmentId: EnvironmentId;
    readonly publicKey: string;
    readonly nowMillis: number;
  }) {
    const existing = yield* sql<{ readonly publicKey: string }>`
      SELECT public_key AS "publicKey"
      FROM workjet_mailbox_peer_keys
      WHERE source_workspace_id = ${input.workspaceId}
        AND source_environment_id = ${input.environmentId}
      LIMIT 1
    `;
    const pinned = existing[0];
    if (pinned !== undefined) return pinned.publicKey === input.publicKey;

    yield* sql`
      INSERT OR IGNORE INTO workjet_mailbox_peer_keys
        (source_workspace_id, source_environment_id, public_key, first_seen_at_ms)
      VALUES (${input.workspaceId}, ${input.environmentId}, ${input.publicKey}, ${input.nowMillis})
    `;

    const winner = yield* sql<{ readonly publicKey: string }>`
      SELECT public_key AS "publicKey"
      FROM workjet_mailbox_peer_keys
      WHERE source_workspace_id = ${input.workspaceId}
        AND source_environment_id = ${input.environmentId}
      LIMIT 1
    `;
    return winner[0]?.publicKey === input.publicKey;
  });

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
    const envelopeJson = yield* encodeEnvelopeJson(input.record.envelope).pipe(Effect.option);
    const payloadJson = yield* encodeWrapperJson({
      schemaVersion: 1,
      senderPublicKey: identity.publicKey,
      payload: input.record.payload,
    }).pipe(Effect.option);

    // An outbox row that cannot be re-encoded is corrupt beyond retrying, but
    // it still walks the ordinary attempt budget to its dead-letter state
    // rather than being deleted behind the operator's back.
    if (Option.isNone(envelopeJson) || Option.isNone(payloadJson)) {
      yield* store.recordAttempt(input.record.envelopeId, input.now).pipe(Effect.ignore);
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
            payloadJson: payloadJson.value,
          }),
        ),
      ),
    });

    if (Option.isNone(result)) {
      yield* store.recordAttempt(input.record.envelopeId, input.now).pipe(Effect.ignore);
      bump("pushFailures");
      return;
    }

    // A duplicate is a SUCCESS: the document is already in the replicating
    // collection, which is exactly what "delivered" means on this hop.
    const decoded = yield* decodePublishResult(result.value).pipe(Effect.option);
    const duplicate = Option.isSome(decoded) && decoded.value.duplicate === true;

    yield* store.markDelivered(input.record.envelopeId, input.now).pipe(Effect.ignore);
    bump(duplicate ? "pushDuplicates" : "pushed");
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

      const verified = yield* identity.verifyRoutingEnvelope(
        envelope.value,
        wrapper.value.senderPublicKey,
      );
      if (!verified) return { _tag: "rejected", kind: "signature" } as const;

      // Continuity is checked only AFTER the signature verifies, so a forged
      // envelope can never pin a key for a source it does not control.
      const continuous = yield* acceptPeerKey({
        workspaceId: envelope.value.sourceWorkspaceId,
        environmentId: envelope.value.sourceEnvironmentId,
        publicKey: wrapper.value.senderPublicKey,
        nowMillis: input.nowMillis,
      }).pipe(Effect.orElseSucceed(() => null));
      if (continuous === null) return { _tag: "deferred" } as const;
      if (!continuous) return { _tag: "rejected", kind: "keyContinuity" } as const;

      const recorded = yield* store
        .recordInboundEnvelope(envelope.value, wrapper.value.payload, input.now)
        .pipe(Effect.result);

      if (recorded._tag === "Failure") {
        // A bounded mailbox reason is a DECISION about this envelope (expired,
        // malformed) and is final; anything else is a local store fault and must
        // be retried rather than consumed.
        return isBoundedMailboxError(recorded.failure)
          ? ({ _tag: "rejected", kind: "malformed" } as const)
          : ({ _tag: "deferred" } as const);
      }

      if (recorded.success._tag !== "accepted-new") return { _tag: "duplicate" } as const;

      const payload = wrapper.value.payload;
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

  return yield* makeWorkjetMailboxTransportWithSources({
    nowIso: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
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
