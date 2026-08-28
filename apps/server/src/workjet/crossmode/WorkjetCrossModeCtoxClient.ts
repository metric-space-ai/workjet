import { WorkjetCrossModeError, type CtoxManagedInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as ProcessRunner from "../../processRunner.ts";
import {
  ctoxDescriptorPath,
  resolveCtoxAuthTokenFromCli,
  resolveCtoxEndpointFromDescriptor,
  type CtoxDaemonEndpoint,
} from "../mailbox/WorkjetMailboxTransport.ts";
import {
  WorkjetCrossModeCtoxPort,
  type WorkjetCrossModeCtoxCommand,
  type WorkjetCrossModeCtoxDispatch,
  type WorkjetCrossModeCtoxPortShape,
} from "./WorkjetCrossModeCtoxPort.ts";

/**
 * The FIRST outbound MCP client in this repository, and deliberately the
 * smallest one that can be correct.
 *
 * WHAT IT TALKS TO, verified against the CTOX daemon's own source rather than
 * assumed (`ctox` rc7 checkout, `src/core/business_os/mcp_channel.rs`):
 *
 * - Transport: PLAIN JSON-RPC 2.0 over `POST /mcp`, one JSON request, one JSON
 *   response. `handle_mcp_http_request` matches `(Method::Post, "/mcp")` and
 *   answers with `respond_json_value`; there is no SSE stream, no
 *   `Mcp-Session-Id`, and no streamable-HTTP upgrade to negotiate. That is why
 *   this file uses the repository's ordinary `HttpClient` instead of pulling in
 *   an MCP SDK client: the wire IS a single authenticated JSON POST.
 * - Origin: the SAME loopback listener the mailbox transport already resolves.
 *   `handle_mcp_http_request` dispatches the Workjet mailbox routes from the
 *   very same `match`, so `<state-root>/instance.json`'s `healthUrl` minus
 *   `/health` is the base URL for both. Hence
 *   {@link resolveCtoxEndpointFromDescriptor} is reused rather than re-derived.
 * - Auth: `Authorization: Bearer <secret business_os/mcp_inbound_auth_token>`,
 *   compared with a constant-time HMAC in `mcp_request_authorized`, which fails
 *   closed on a missing token, a wrong token, or an unreadable secret store.
 *   {@link resolveCtoxAuthTokenFromCli} is the existing, documented same-user
 *   retrieval path and is reused unchanged.
 * - Methods: `initialize`, `tools/list`, `tools/call`. Anything else is
 *   `-32601 unsupported JSON-RPC method`.
 *
 * WHAT IT DOES NOT DO. It is not a general MCP client and must not become one.
 * It knows two calls — an `initialize` handshake and exactly one `tools/call` —
 * because those are the two the cross-mode port's contract needs. Every other
 * `business_os.*` tool stays out of reach of this server on purpose: a wider
 * client here would be an unaudited second window into the CTOX authority,
 * which is the thing the port exists to prevent.
 */

// ===============================
// Bounds
// ===============================

/**
 * One call, one bounded wait, no retry. The daemon is on loopback; a call that
 * has not answered in ten seconds is not going to, and a retry loop against a
 * command surface risks dispatching the same Business OS command twice.
 */
const REQUEST_TIMEOUT = Duration.seconds(10);

/**
 * CTOX's own answers are bounded (`ensure_mcp_response_size`), but this client
 * must not depend on the peer to bound them. A `tools/call` answer larger than
 * this is treated as an unusable surface rather than parsed.
 */
const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * The one Business OS action every module exposes.
 *
 * `list_module_actions` prepends `generic_delegate_action(&module.id)` for EVERY
 * module and only then extends the list with module-specific ids for a handful
 * of hardcoded modules (`tickets`, `customers`, `outbound`, …). So
 * `ctox.delegate_task` is the only action id this bridge can name for an
 * arbitrary module and still be certain the authority will recognise it. It is
 * declared `risk_class: "write"`, `confirmation_required: false`,
 * `external_effect: false` — a durable CTOX task scoped to the module, which is
 * exactly what "a linked Code thread returned something" should become.
 *
 * VERIFIED LIVE against the daemon on this machine: `list_module_actions` for
 * module `kundenpipeline` answers exactly one item, `ctox.delegate_task`.
 */
export const CTOX_DELEGATE_TASK_ACTION_ID = "ctox.delegate_task";

/** The MCP tool that enqueues an approved, typed Business OS action. */
export const CTOX_EXECUTE_ACTION_TOOL = "business_os.execute_action";

/** Audit attribution for every call this bridge makes. */
export const CTOX_CROSS_MODE_CHANNEL = "t3_cross_mode";
export const CTOX_CROSS_MODE_SURFACE = "workjet_cross_mode";

// ===============================
// Wire schemas
// ===============================

/**
 * The typed error CTOX attaches to a JSON-RPC failure
 * (`json_rpc_error_response`): `data.code` is the serialized
 * `BusinessOsMcpErrorCode`, which is the ONLY part of a failure this bridge
 * interprets. The daemon's message text stays on its side of the boundary.
 */
const CtoxJsonRpcErrorData = Schema.Struct({
  code: Schema.optional(Schema.String),
});

const CtoxJsonRpcEnvelope = Schema.Struct({
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.Number),
      data: Schema.optional(CtoxJsonRpcErrorData),
    }),
  ),
});

/** Decoded straight from the response TEXT so the size bound is checked first. */
const decodeJsonRpcEnvelope = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CtoxJsonRpcEnvelope),
);

/** `mcp_tool_result` always wraps the tool's own value under `structuredContent`. */
const CtoxToolResult = Schema.Struct({
  structuredContent: Schema.optional(Schema.Unknown),
});

const decodeToolResult = Schema.decodeUnknownEffect(CtoxToolResult);

/**
 * The fields of `BusinessOsActionExecution` this bridge reads. `ok`, `status`
 * and `confirmation_required` are non-optional in the Rust struct; everything
 * else it returns (the action descriptor, the command id, the client context)
 * is deliberately NOT decoded, because carrying it any further would leak CTOX
 * internals into a T3 result the contract says holds two words.
 */
const CtoxActionExecution = Schema.Struct({
  ok: Schema.Boolean,
  status: Schema.String,
  confirmation_required: Schema.Boolean,
});

const decodeActionExecution = Schema.decodeUnknownEffect(CtoxActionExecution);

/** `initialize` answers a `serverInfo.name`; this bridge only requires that it is CTOX's. */
const CtoxServerInfo = Schema.Struct({
  serverInfo: Schema.Struct({ name: Schema.String }),
});

const decodeServerInfo = Schema.decodeUnknownEffect(CtoxServerInfo);

export const CTOX_MCP_SERVER_NAME = "ctox-business-os-mcp";

// ===============================
// Failure classification
// ===============================

/**
 * Which side of the boundary a typed CTOX error belongs to.
 *
 * `unavailable` — the surface could not serve the command at all (the channel is
 * off, the runtime is down, sync is not ready, we are being rate limited). The
 * request was fine; the authority was not there to answer it.
 *
 * `awaiting-approval` — CTOX's own gate. `execute_action` raises
 * `confirmation_required` when an action needs a human before it runs, which IS
 * "propose and await a human" expressed as an error, so it is surfaced as the
 * contract's `awaiting-approval` outcome rather than as a refusal.
 *
 * Everything else — not authorized, permission denied, action not allowed,
 * validation failed, external effect blocked, module/record not found — is the
 * authority REFUSING this specific command, which is `ctox-command-rejected`.
 */
const UNAVAILABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  "channel_disabled",
  "runtime_unavailable",
  "sync_not_ready",
  "rate_limited",
  "response_too_large",
]);

/**
 * A single call's failure, before it is mapped onto the port's typed reasons.
 * `malformed` is kept distinct from `unreachable` so the mapping below can be
 * read as a decision rather than inferred from a collapsed `undefined`.
 */
type CtoxCallFailure =
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "malformed" }
  | { readonly _tag: "error"; readonly code: string | undefined };

type CtoxCallOutcome<A> = { readonly _tag: "ok"; readonly value: A } | CtoxCallFailure;

// ===============================
// Sources
// ===============================

export interface WorkjetCrossModeCtoxSources {
  /**
   * The daemon's loopback endpoint AND the instance identity it published, or
   * `idle` when there is no usable daemon. Re-read on every call on purpose: a
   * link created while CTOX ran must not keep dispatching after it stopped, and
   * an instance id is a live fact, not a cached one.
   */
  readonly resolveEndpoint: Effect.Effect<
    | { readonly _tag: "resolved"; readonly endpoint: CtoxDaemonEndpoint }
    | { readonly _tag: "idle"; readonly reason: string }
  >;

  /** The bearer token, or `None` when it is genuinely unreachable. */
  readonly resolveAuthToken: Effect.Effect<Option.Option<string>>;
}

// ===============================
// Construction
// ===============================

export const makeWorkjetCrossModeCtoxPortWithSources = Effect.fn(
  "WorkjetCrossModeCtoxPort.makeWithSources",
)(function* (sources: WorkjetCrossModeCtoxSources) {
  const httpClient = yield* HttpClient.HttpClient;

  /**
   * One authenticated JSON-RPC call. Every transport-level failure — a refused
   * connection, a 401, a timeout, a body that is not the envelope CTOX
   * documents — collapses into a bounded {@link CtoxCallFailure}. Nothing the
   * daemon said is propagated: the port's typed reasons are the whole vocabulary
   * a caller gets, and a daemon error string could carry record material.
   */
  const call = (input: {
    readonly baseUrl: string;
    readonly token: string;
    readonly body: unknown;
  }): Effect.Effect<CtoxCallOutcome<unknown>> =>
    Effect.gen(function* () {
      const request = HttpClientRequest.post(`${input.baseUrl}/mcp`).pipe(
        HttpClientRequest.bodyJsonUnsafe(input.body),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(input.token),
      );
      const response = yield* httpClient.execute(request);
      if (response.status < 200 || response.status >= 300) {
        return { _tag: "unreachable" } as const;
      }
      const text = yield* response.text;
      if (text.length > MAX_RESPONSE_BYTES) return { _tag: "malformed" } as const;

      const envelope = yield* decodeJsonRpcEnvelope(text).pipe(Effect.option);
      if (Option.isNone(envelope)) return { _tag: "malformed" } as const;

      if (envelope.value.error !== undefined) {
        return { _tag: "error", code: envelope.value.error.data?.code } as const;
      }
      if (envelope.value.result === undefined) return { _tag: "malformed" } as const;
      return { _tag: "ok", value: envelope.value.result } as const;
    }).pipe(
      Effect.scoped,
      Effect.timeout(REQUEST_TIMEOUT),
      // A connection error, a DNS failure and a timeout are the same fact to
      // this caller: the surface did not answer.
      Effect.catchCause(() => Effect.succeed({ _tag: "unreachable" } as const)),
    );

  /**
   * The endpoint plus the token, or `None` when either is missing.
   *
   * Both halves are required for ANY call, so resolving them together keeps the
   * "no local CTOX" case a single branch that every entry point takes
   * identically — which is what makes the unavailable fallback a property of
   * this implementation rather than a separate wiring decision.
   */
  const resolveTarget = Effect.gen(function* () {
    const endpoint = yield* sources.resolveEndpoint;
    if (endpoint._tag === "idle") return Option.none();
    const token = yield* sources.resolveAuthToken;
    if (Option.isNone(token)) return Option.none();
    return Option.some({ endpoint: endpoint.endpoint, token: token.value });
  });

  /**
   * Authority verification, against a genuine daemon fact.
   *
   * Two conditions, both required:
   *
   *  1. IDENTITY — the running daemon's own descriptor publishes an
   *     `instanceId`, and it equals the one the caller named. The descriptor is
   *     written by the daemon process itself and refreshed every 45 s
   *     (`instance_descriptor.rs`), and the endpoint resolver already refuses a
   *     descriptor whose `status` is not `running` or whose `lastSeenAt` is
   *     stale, so a match means "the CTOX instance running on this machine right
   *     now IS the one this link names".
   *  2. REACHABILITY AND AUTH — an `initialize` handshake on that endpoint
   *     succeeds with this machine's bearer token and identifies itself as
   *     CTOX's Business OS MCP server. Identity alone would vouch for a daemon
   *     this server cannot actually command.
   *
   * A daemon that publishes no `instanceId` verifies NOTHING: absence is not a
   * match. Every failure answers `false` rather than raising, because
   * "cannot vouch" is the honest answer to "can you vouch", and the caller's
   * single `requireVerifiedCtoxAuthority` turns it into `unverified-authority`.
   */
  const verifyAuthority = (
    instanceId: CtoxManagedInstanceId,
  ): Effect.Effect<boolean, WorkjetCrossModeError> =>
    Effect.gen(function* () {
      const target = yield* resolveTarget;
      if (Option.isNone(target)) return false;

      const published = target.value.endpoint.instanceId;
      if (published === undefined || published !== instanceId) return false;

      const outcome = yield* call({
        baseUrl: target.value.endpoint.baseUrl,
        token: target.value.token,
        body: { jsonrpc: "2.0", id: 1, method: "initialize" },
      });
      if (outcome._tag !== "ok") return false;

      const info = yield* decodeServerInfo(outcome.value).pipe(Effect.option);
      return Option.isSome(info) && info.value.serverInfo.name === CTOX_MCP_SERVER_NAME;
    });

  /**
   * The command payload.
   *
   * `record_id` is the linked object's id and `objective` is the operator-facing
   * evidence summary, because those are the two fields `ctox.delegate_task`'s
   * own input schema names. Everything else the bridge knows travels in
   * `payload` under an explicitly versioned key, so a Business OS module reading
   * the resulting task can tell a cross-mode return from any other delegated
   * task without pattern-matching on prose.
   *
   * Nothing here is a record, a diff, a file body or a credential: `summary` and
   * `artifacts` already crossed the contract's redaction bounds, and no other
   * caller-supplied value reaches this object.
   */
  const executeActionArguments = (command: WorkjetCrossModeCtoxCommand) => ({
    module_id: command.moduleId,
    action_id: CTOX_DELEGATE_TASK_ACTION_ID,
    record_id: command.objectId,
    title: `Workjet: ${command.operation}`,
    objective: command.summary,
    payload: {
      source: "t3_cross_mode",
      schema_version: 1,
      operation: command.operation,
      link_id: command.linkId,
      object_kind: command.objectKind,
      object_id: command.objectId,
      code_environment_id: command.codeEnvironmentId,
      code_thread_id: command.codeThreadId,
      ...(command.runTurnId !== undefined ? { run_turn_id: command.runTurnId } : {}),
      ...(command.outcome !== undefined ? { outcome: command.outcome } : {}),
      artifacts: {
        ...(command.artifacts.branch !== undefined
          ? {
              branch: {
                name: command.artifacts.branch.branch,
                head_commit: command.artifacts.branch.headCommit,
                delivery: command.artifacts.branch.delivery,
              },
            }
          : {}),
        commit_hashes: command.artifacts.commitHashes,
        paths: command.artifacts.paths,
      },
    },
    // Audit attribution only. `actor` and `workspace` are deliberately NOT set:
    // CTOX resolves them itself (`mcp:local` / `local` for a direct loopback
    // client), and naming an actor here would let this bridge assert an identity
    // the daemon never authenticated.
    _context: {
      channel: CTOX_CROSS_MODE_CHANNEL,
      surface: CTOX_CROSS_MODE_SURFACE,
      request_id: command.linkId,
    },
  });

  const dispatch = (
    command: WorkjetCrossModeCtoxCommand,
  ): Effect.Effect<WorkjetCrossModeCtoxDispatch, WorkjetCrossModeError> =>
    Effect.gen(function* () {
      const target = yield* resolveTarget;
      if (Option.isNone(target)) {
        return yield* Effect.fail(
          new WorkjetCrossModeError({ reason: "ctox-command-unavailable" }),
        );
      }

      // The link was verified moments ago by `requireVerifiedCtoxAuthority`, but
      // the daemon can restart under a different identity between the two calls
      // and this is the call that actually WRITES. Re-checking here costs one
      // string comparison and closes that window.
      const published = target.value.endpoint.instanceId;
      if (published === undefined || published !== command.instanceId) {
        return yield* Effect.fail(new WorkjetCrossModeError({ reason: "unverified-authority" }));
      }

      const outcome = yield* call({
        baseUrl: target.value.endpoint.baseUrl,
        token: target.value.token,
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: CTOX_EXECUTE_ACTION_TOOL,
            arguments: executeActionArguments(command),
          },
        },
      });

      if (outcome._tag === "unreachable") {
        return yield* Effect.fail(
          new WorkjetCrossModeError({ reason: "ctox-command-unavailable" }),
        );
      }
      if (outcome._tag === "malformed") {
        // The command may or may not have landed and this server cannot tell.
        // Of the two words the contract allows, "unavailable" is the one that
        // does not claim knowledge it lacks: it reports that the surface did not
        // usefully answer, whereas "rejected" would assert a refusal that was
        // never observed.
        return yield* Effect.fail(
          new WorkjetCrossModeError({ reason: "ctox-command-unavailable" }),
        );
      }
      if (outcome._tag === "error") {
        if (outcome.code === "confirmation_required") {
          return { _tag: "awaiting-approval" } as const;
        }
        return yield* Effect.fail(
          new WorkjetCrossModeError({
            reason:
              outcome.code !== undefined && UNAVAILABLE_ERROR_CODES.has(outcome.code)
                ? "ctox-command-unavailable"
                : "ctox-command-rejected",
          }),
        );
      }

      const result = yield* decodeToolResult(outcome.value).pipe(Effect.option);
      if (Option.isNone(result) || result.value.structuredContent === undefined) {
        return yield* Effect.fail(
          new WorkjetCrossModeError({ reason: "ctox-command-unavailable" }),
        );
      }
      const execution = yield* decodeActionExecution(result.value.structuredContent).pipe(
        Effect.option,
      );
      if (Option.isNone(execution)) {
        return yield* Effect.fail(
          new WorkjetCrossModeError({ reason: "ctox-command-unavailable" }),
        );
      }

      // CTOX's own gate, read off the answer rather than inferred. A command it
      // accepted but held for a human is `awaiting-approval`; one it recorded as
      // failed is a refusal; everything else it accepted is dispatched. There is
      // deliberately no attempt to interpret `status` further — `accepted`,
      // `waiting_dependencies` and `completed` are all "CTOX has it now", which
      // is the most this server can honestly claim.
      if (execution.value.confirmation_required) return { _tag: "awaiting-approval" } as const;
      if (!execution.value.ok || execution.value.status === "failed") {
        return yield* Effect.fail(new WorkjetCrossModeError({ reason: "ctox-command-rejected" }));
      }
      return { _tag: "dispatched" } as const;
    });

  return { verifyAuthority, dispatch } satisfies WorkjetCrossModeCtoxPortShape;
});

/**
 * The real port over this machine's local CTOX daemon.
 *
 * There is no separate "is CTOX installed" decision at wiring time and there
 * must not be one: both sources are re-resolved per call, so a machine with no
 * daemon, a stopped daemon, or an unreachable secret store degrades to exactly
 * the {@link workjetCrossModeCtoxPortUnavailable} behaviour — verify answers
 * `false`, dispatch fails `ctox-command-unavailable` — while a daemon that
 * starts later begins working without a server restart.
 */
export const makeWorkjetCrossModeCtoxPort = Effect.fn("WorkjetCrossModeCtoxPort.make")(
  function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runner = yield* ProcessRunner.ProcessRunner;

    return yield* makeWorkjetCrossModeCtoxPortWithSources({
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
  },
);

export const layer = Layer.effect(WorkjetCrossModeCtoxPort, makeWorkjetCrossModeCtoxPort());
