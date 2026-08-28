// @effect-diagnostics preferSchemaOverJson:off -- the fake daemon is a WIRE stand-in: it must read and write the same raw JSON strings the real CTOX `/mcp` route exchanges, so encoding through a schema here would stop testing the wire.
import {
  EnvironmentId,
  ThreadId,
  WorkjetBusinessOsObjectId,
  WorkjetBusinessOsObjectKind,
  WorkjetGitBranchName,
  WorkjetGitCommitHash,
  WorkjetRepositoryPath,
  type CtoxAppModuleId,
  type CtoxManagedInstanceId,
  type WorkjetCrossModeLinkId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { type WorkjetCrossModeCtoxCommand } from "./WorkjetCrossModeCtoxPort.ts";
import {
  CTOX_CROSS_MODE_CHANNEL,
  CTOX_DELEGATE_TASK_ACTION_ID,
  CTOX_EXECUTE_ACTION_TOOL,
  CTOX_MCP_SERVER_NAME,
  makeWorkjetCrossModeCtoxPortWithSources,
  type WorkjetCrossModeCtoxSources,
} from "./WorkjetCrossModeCtoxClient.ts";

const INSTANCE: CtoxManagedInstanceId = "biz_2a75d5c5-da16-4a17-90d2-a941ad53f095";
const OTHER_INSTANCE: CtoxManagedInstanceId = "biz_00000000-0000-0000-0000-000000000000";
const MODULE = "kundenpipeline" as CtoxAppModuleId;
const BASE_URL = "http://127.0.0.1:8788";
const TOKEN = "test-inbound-token";
const LINK = "link_0001" as WorkjetCrossModeLinkId;

const command = (
  overrides: Partial<WorkjetCrossModeCtoxCommand> = {},
): WorkjetCrossModeCtoxCommand => ({
  instanceId: INSTANCE,
  moduleId: MODULE,
  objectKind: WorkjetBusinessOsObjectKind.make("deal"),
  objectId: WorkjetBusinessOsObjectId.make("deal_4711"),
  operation: "submit-result",
  summary: "Renewal discount rule implemented and covered by tests.",
  artifacts: { schemaVersion: 1, commitHashes: [], paths: [] },
  linkId: LINK,
  codeEnvironmentId: EnvironmentId.make("environment-local"),
  codeThreadId: ThreadId.make("thread-host"),
  ...overrides,
});

// ===============================
// Fake daemon
// ===============================

interface DaemonCall {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: {
    readonly method?: string;
    readonly params?: { readonly name?: string; readonly arguments?: Record<string, unknown> };
  };
}

/**
 * An in-process stand-in for the daemon's `POST /mcp` route, wired in through
 * the SAME injected `HttpClient` boundary the real port uses — mirroring the
 * mailbox transport's `makeFakeDaemon`. It reproduces the three behaviours the
 * port depends on, all read off `mcp_channel.rs`:
 *
 *  - a missing or wrong bearer token answers HTTP 401 (`mcp_request_authorized`
 *    fails closed),
 *  - `initialize` answers `serverInfo.name = "ctox-business-os-mcp"`,
 *  - `tools/call` answers `{content, structuredContent}` on success
 *    (`mcp_tool_result`) and a JSON-RPC `error` with
 *    `data.code = <BusinessOsMcpErrorCode>` on failure
 *    (`json_rpc_error_response`).
 */
const makeFakeDaemon = (options?: {
  readonly token?: string;
  readonly execution?: unknown;
  readonly toolError?: { readonly code: string };
  readonly rawBody?: string;
  readonly status?: number;
  readonly hang?: boolean;
}) => {
  const calls: Array<DaemonCall> = [];

  const client = HttpClient.make((request, url) =>
    Effect.suspend(() => {
      const bytes = (request.body as { readonly body?: Uint8Array }).body;
      const body =
        bytes === undefined
          ? {}
          : (JSON.parse(new TextDecoder().decode(bytes)) as DaemonCall["body"]);
      const authorization = request.headers["authorization"];
      calls.push({ path: url.pathname, authorization, body });

      const answer = (status: number, payload: string) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(payload, { status, headers: { "content-type": "application/json" } }),
          ),
        );

      if (options?.hang === true) return Effect.never;
      if (authorization !== `Bearer ${options?.token ?? TOKEN}`) {
        return answer(401, JSON.stringify({ ok: false, error: "unauthorized" }));
      }
      if (options?.status !== undefined && options.status !== 200) {
        return answer(options.status, JSON.stringify({ ok: false, error: "boom" }));
      }
      if (options?.rawBody !== undefined) return answer(200, options.rawBody);

      if (body.method === "initialize") {
        return answer(
          200,
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: CTOX_MCP_SERVER_NAME, version: "0.3.22" },
            },
          }),
        );
      }
      if (body.method === "tools/call") {
        if (options?.toolError !== undefined) {
          return answer(
            200,
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: {
                code: -32003,
                message: "refused",
                data: { code: options.toolError.code, type: "business_os_mcp_error" },
              },
            }),
          );
        }
        const structuredContent = options?.execution ?? {
          ok: true,
          action: { action_id: CTOX_DELEGATE_TASK_ACTION_ID },
          module_id: MODULE,
          command_type: CTOX_DELEGATE_TASK_ACTION_ID,
          command_id: "cmd_1",
          status: "accepted",
          confirmation_required: false,
          client_context: {},
        };
        return answer(
          200,
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              content: [{ type: "text", text: JSON.stringify(structuredContent) }],
              structuredContent,
            },
          }),
        );
      }
      return answer(
        200,
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          error: { code: -32601, message: "unsupported JSON-RPC method" },
        }),
      );
    }),
  );

  return { client, calls };
};

const sources = (
  overrides?: Partial<WorkjetCrossModeCtoxSources>,
): WorkjetCrossModeCtoxSources => ({
  resolveEndpoint: Effect.succeed({
    _tag: "resolved",
    endpoint: { baseUrl: BASE_URL, instanceId: INSTANCE },
  } as const),
  resolveAuthToken: Effect.succeed(Option.some(TOKEN)),
  ...overrides,
});

const makePort = (input: {
  readonly client: HttpClient.HttpClient;
  readonly sources?: Partial<WorkjetCrossModeCtoxSources>;
}) =>
  makeWorkjetCrossModeCtoxPortWithSources(sources(input.sources)).pipe(
    Effect.provideService(HttpClient.HttpClient, input.client),
  );

const toolCall = (calls: ReadonlyArray<DaemonCall>): DaemonCall => {
  const call = calls.find((entry) => entry.body.method === "tools/call");
  if (call === undefined) throw new Error("expected a tools/call request");
  return call;
};

// ===============================
// verifyAuthority
// ===============================

it.effect("verifies the instance the running daemon publishes", () =>
  Effect.gen(function* () {
    const daemon = makeFakeDaemon();
    const port = yield* makePort({ client: daemon.client });

    assert.isTrue(yield* port.verifyAuthority(INSTANCE));
    const call = daemon.calls[0];
    assert.strictEqual(call?.path, "/mcp");
    assert.strictEqual(call?.body.method, "initialize");
    assert.strictEqual(call?.authorization, `Bearer ${TOKEN}`);
  }),
);

it.effect("refuses an instance the daemon did not publish", () =>
  Effect.gen(function* () {
    const daemon = makeFakeDaemon();
    const port = yield* makePort({ client: daemon.client });

    assert.isFalse(yield* port.verifyAuthority(OTHER_INSTANCE));
    // The identity mismatch is decided locally: no call is made at all, so a
    // caller cannot use an invented id to probe the daemon.
    assert.strictEqual(daemon.calls.length, 0);
  }),
);

it.effect("refuses every instance when the descriptor publishes no identity", () =>
  Effect.gen(function* () {
    const daemon = makeFakeDaemon();
    const port = yield* makePort({
      client: daemon.client,
      sources: {
        resolveEndpoint: Effect.succeed({
          _tag: "resolved",
          endpoint: { baseUrl: BASE_URL },
        } as const),
      },
    });

    assert.isFalse(yield* port.verifyAuthority(INSTANCE));
  }),
);

it.effect("refuses when the token is wrong: a 401 is not an authority", () =>
  Effect.gen(function* () {
    const daemon = makeFakeDaemon({ token: "a-different-token" });
    const port = yield* makePort({ client: daemon.client });

    assert.isFalse(yield* port.verifyAuthority(INSTANCE));
  }),
);

it.effect("refuses when the endpoint answers something that is not CTOX", () =>
  Effect.gen(function* () {
    const daemon = makeFakeDaemon({
      rawBody: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { serverInfo: { name: "some-other-mcp" } },
      }),
    });
    const port = yield* makePort({ client: daemon.client });

    assert.isFalse(yield* port.verifyAuthority(INSTANCE));
  }),
);

it.effect("refuses when there is no daemon at all", () =>
  Effect.gen(function* () {
    const daemon = makeFakeDaemon();
    const port = yield* makePort({
      client: daemon.client,
      sources: {
        resolveEndpoint: Effect.succeed({ _tag: "idle", reason: "descriptor-missing" } as const),
      },
    });

    assert.isFalse(yield* port.verifyAuthority(INSTANCE));
    assert.strictEqual(daemon.calls.length, 0);
  }),
);

it.effect("refuses when no bearer token can be resolved", () =>
  Effect.gen(function* () {
    const daemon = makeFakeDaemon();
    const port = yield* makePort({
      client: daemon.client,
      sources: { resolveAuthToken: Effect.succeed(Option.none()) },
    });

    assert.isFalse(yield* port.verifyAuthority(INSTANCE));
    assert.strictEqual(daemon.calls.length, 0);
  }),
);

// ===============================
// dispatch — happy path
// ===============================

it.effect("dispatches a command as the module's generic delegate action", () =>
  Effect.gen(function* () {
    const daemon = makeFakeDaemon();
    const port = yield* makePort({ client: daemon.client });

    const outcome = yield* port.dispatch(
      command({
        outcome: "completed",
        artifacts: {
          schemaVersion: 1,
          branch: {
            schemaVersion: 1,
            branch: WorkjetGitBranchName.make("feature/x"),
            headCommit: WorkjetGitCommitHash.make("abc1234"),
            delivery: "pushed",
          },
          commitHashes: [],
          paths: [WorkjetRepositoryPath.make("src/a.ts")],
        },
      }),
    );

    assert.deepStrictEqual(outcome, { _tag: "dispatched" });

    const call = toolCall(daemon.calls);
    assert.strictEqual(call.path, "/mcp");
    assert.strictEqual(call.authorization, `Bearer ${TOKEN}`);
    assert.strictEqual(call.body.params?.name, CTOX_EXECUTE_ACTION_TOOL);

    const args = call.body.params?.arguments ?? {};
    assert.strictEqual(args["module_id"], MODULE);
    assert.strictEqual(args["action_id"], CTOX_DELEGATE_TASK_ACTION_ID);
    assert.strictEqual(args["record_id"], "deal_4711");
    assert.strictEqual(
      args["objective"],
      "Renewal discount rule implemented and covered by tests.",
    );

    const payload = args["payload"] as Record<string, unknown>;
    assert.strictEqual(payload["operation"], "submit-result");
    assert.strictEqual(payload["link_id"], LINK);
    assert.strictEqual(payload["object_kind"], "deal");
    assert.strictEqual(payload["outcome"], "completed");
    assert.deepStrictEqual(payload["artifacts"], {
      branch: { name: "feature/x", head_commit: "abc1234", delivery: "pushed" },
      commit_hashes: [],
      paths: ["src/a.ts"],
    });

    // Audit attribution only: the bridge never asserts an actor the daemon did
    // not authenticate, so CTOX resolves `mcp:local` itself.
    const context = args["_context"] as Record<string, unknown>;
    assert.strictEqual(context["channel"], CTOX_CROSS_MODE_CHANNEL);
    assert.isUndefined(context["actor"]);
    assert.isUndefined(context["workspace"]);
  }),
);

it.effect("carries request-review and follow-up through the same action", () =>
  Effect.gen(function* () {
    for (const operation of ["request-review", "follow-up"] as const) {
      const daemon = makeFakeDaemon();
      const port = yield* makePort({ client: daemon.client });

      const outcome = yield* port.dispatch(command({ operation }));
      assert.deepStrictEqual(outcome, { _tag: "dispatched" });
      const payload = toolCall(daemon.calls).body.params?.arguments?.["payload"] as Record<
        string,
        unknown
      >;
      assert.strictEqual(payload["operation"], operation);
    }
  }),
);

it.effect("treats a queued command that is waiting on dependencies as dispatched", () =>
  Effect.gen(function* () {
    const daemon = makeFakeDaemon({
      execution: { ok: true, status: "waiting_dependencies", confirmation_required: false },
    });
    const port = yield* makePort({ client: daemon.client });

    assert.deepStrictEqual(yield* port.dispatch(command()), { _tag: "dispatched" });
  }),
);

// ===============================
// dispatch — CTOX's own approval gate
// ===============================

it.effect("reports CTOX's confirmation_required error as awaiting-approval", () =>
  Effect.gen(function* () {
    const daemon = makeFakeDaemon({ toolError: { code: "confirmation_required" } });
    const port = yield* makePort({ client: daemon.client });

    assert.deepStrictEqual(yield* port.dispatch(command()), { _tag: "awaiting-approval" });
  }),
);

it.effect("reports an accepted-but-held command as awaiting-approval", () =>
  Effect.gen(function* () {
    const daemon = makeFakeDaemon({
      execution: { ok: true, status: "accepted", confirmation_required: true },
    });
    const port = yield* makePort({ client: daemon.client });

    assert.deepStrictEqual(yield* port.dispatch(command()), { _tag: "awaiting-approval" });
  }),
);

// ===============================
// dispatch — refusals versus outages
// ===============================

it.effect("maps an authority refusal onto ctox-command-rejected", () =>
  Effect.gen(function* () {
    for (const code of [
      "not_authorized",
      "permission_denied",
      "action_not_allowed",
      "validation_failed",
      "external_effect_blocked",
      "module_not_found",
      "record_not_found",
    ]) {
      const daemon = makeFakeDaemon({ toolError: { code } });
      const port = yield* makePort({ client: daemon.client });

      const error = yield* port.dispatch(command()).pipe(Effect.flip);
      assert.strictEqual(error.reason, "ctox-command-rejected", code);
    }
  }),
);

it.effect("maps an outage onto ctox-command-unavailable", () =>
  Effect.gen(function* () {
    for (const code of [
      "channel_disabled",
      "runtime_unavailable",
      "sync_not_ready",
      "rate_limited",
      "response_too_large",
    ]) {
      const daemon = makeFakeDaemon({ toolError: { code } });
      const port = yield* makePort({ client: daemon.client });

      const error = yield* port.dispatch(command()).pipe(Effect.flip);
      assert.strictEqual(error.reason, "ctox-command-unavailable", code);
    }
  }),
);

it.effect("reports a command CTOX recorded as failed as rejected", () =>
  Effect.gen(function* () {
    const daemon = makeFakeDaemon({
      execution: { ok: false, status: "failed", confirmation_required: false },
    });
    const port = yield* makePort({ client: daemon.client });

    const error = yield* port.dispatch(command()).pipe(Effect.flip);
    assert.strictEqual(error.reason, "ctox-command-rejected");
  }),
);

it.effect("refuses a command naming an instance the daemon is not", () =>
  Effect.gen(function* () {
    const daemon = makeFakeDaemon();
    const port = yield* makePort({ client: daemon.client });

    const error = yield* port.dispatch(command({ instanceId: OTHER_INSTANCE })).pipe(Effect.flip);
    assert.strictEqual(error.reason, "unverified-authority");
    // Nothing was sent: a mismatched instance never reaches the command surface.
    assert.strictEqual(daemon.calls.length, 0);
  }),
);

it.effect("reports a 401 as unavailable rather than as a refusal", () =>
  Effect.gen(function* () {
    const daemon = makeFakeDaemon({ token: "a-different-token" });
    const port = yield* makePort({ client: daemon.client });

    const error = yield* port.dispatch(command()).pipe(Effect.flip);
    assert.strictEqual(error.reason, "ctox-command-unavailable");
  }),
);

it.effect("reports a malformed answer as unavailable, never as a landed command", () =>
  Effect.gen(function* () {
    for (const rawBody of [
      "not json at all",
      JSON.stringify({ jsonrpc: "2.0", id: 1 }),
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { structuredContent: { ok: "yes", status: 7 } },
      }),
    ]) {
      const daemon = makeFakeDaemon({ rawBody });
      const port = yield* makePort({ client: daemon.client });

      const error = yield* port.dispatch(command()).pipe(Effect.flip);
      assert.strictEqual(error.reason, "ctox-command-unavailable", rawBody);
    }
  }),
);

it.effect("reports an HTTP failure as unavailable", () =>
  Effect.gen(function* () {
    const daemon = makeFakeDaemon({ status: 500 });
    const port = yield* makePort({ client: daemon.client });

    const error = yield* port.dispatch(command()).pipe(Effect.flip);
    assert.strictEqual(error.reason, "ctox-command-unavailable");
  }),
);

it.effect("bounds a hung daemon instead of waiting forever", () =>
  Effect.gen(function* () {
    const daemon = makeFakeDaemon({ hang: true });
    const port = yield* makePort({ client: daemon.client });

    const fiber = yield* port.dispatch(command()).pipe(Effect.flip, Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.seconds(11));

    const error = yield* Fiber.join(fiber);
    assert.strictEqual(error.reason, "ctox-command-unavailable");
  }).pipe(Effect.provide(TestClock.layer())),
);

// ===============================
// The fallback: no daemon, no crash
// ===============================

it.effect("falls back to refusing honestly when no descriptor can be resolved", () =>
  Effect.gen(function* () {
    const daemon = makeFakeDaemon();
    const port = yield* makePort({
      client: daemon.client,
      sources: {
        resolveEndpoint: Effect.succeed({ _tag: "idle", reason: "descriptor-missing" } as const),
      },
    });

    assert.isFalse(yield* port.verifyAuthority(INSTANCE));
    const error = yield* port.dispatch(command()).pipe(Effect.flip);
    assert.strictEqual(error.reason, "ctox-command-unavailable");
    assert.strictEqual(daemon.calls.length, 0);
  }),
);

it.effect("falls back to refusing honestly when no token can be resolved", () =>
  Effect.gen(function* () {
    const daemon = makeFakeDaemon();
    const port = yield* makePort({
      client: daemon.client,
      sources: { resolveAuthToken: Effect.succeed(Option.none()) },
    });

    const error = yield* port.dispatch(command()).pipe(Effect.flip);
    assert.strictEqual(error.reason, "ctox-command-unavailable");
    assert.strictEqual(daemon.calls.length, 0);
  }),
);
