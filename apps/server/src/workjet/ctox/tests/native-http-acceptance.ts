/** Explicit integration runner: each phase runs in a fresh process against an owned native HTTP MCP fixture.
 * Run: node native-http-acceptance.ts <private-fixture.json> <first|resume|revoked|stop|verify>
 * This does not establish desktop UI, connection-registry, provider or installed acceptance.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeSqlite from "node:sqlite";
import {
  ThreadId,
  WorkjetConnectionId,
  WorkjetDecisionHubConnectionError,
} from "@workjet/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Result from "effect/Result";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as NodeSqliteClient from "../../../persistence/NodeSqliteClient.ts";
import migration60 from "../../../persistence/Migrations/060_WorkjetCtoxNativeRequests.ts";
import migration61 from "../../../persistence/Migrations/061_WorkjetCtoxNativeTurns.ts";
import { CtoxNativeRequestError, CtoxNativeRequests } from "../CtoxNativeRequests.ts";
import {
  CtoxMcpTransportError,
  isCtoxMcpResponseWithinLimit,
  makeCtoxMcpTransport,
} from "../CtoxMcpTransport.ts";
import { makeCtoxNativeTaskClient, nativeTurnKeyForRequestId } from "../CtoxNativeTaskClient.ts";

const Fixture = Schema.Struct({
  workjetSource: Schema.String,
  nativeSource: Schema.String,
  nativeWorkjetPin: Schema.String,
  nativeBinarySha256: Schema.String,
  serverPid: Schema.Number,
  directory: Schema.String,
  nativeRoot: Schema.String,
  endpoint: Schema.String,
  tokenFile: Schema.String,
  scope: Schema.Struct({
    threadId: ThreadId,
    connectionId: WorkjetConnectionId,
    instanceId: Schema.String,
  }),
  requestId: Schema.String,
  projectTask: Schema.Struct({
    project_id: Schema.String,
    title: Schema.String,
    instruction: Schema.String,
  }),
  cancelKey: Schema.String,
});
const NativeReceipt = Schema.Struct({
  schema: Schema.Literal("ctox.native_project_task.v1"),
  project_id: Schema.String,
  command_id: Schema.String,
  task_id: Schema.String,
});
const SavedReceipt = Schema.Struct({
  commandId: Schema.String,
  taskId: Schema.String,
  nativeKey: Schema.String,
});
const IntentRow = Schema.Struct({
  thread_id: Schema.String,
  request_key: Schema.String,
  remote_request_key: Schema.String,
  connection_id: Schema.String,
  instance_id: Schema.String,
  intent_json: Schema.String,
  command_id: Schema.NullOr(Schema.String),
  task_id: Schema.NullOr(Schema.String),
});
const LocalIdentity = Schema.Struct({
  actor: Schema.Literal("mcp:local"),
  workspace: Schema.Literal("local"),
  policy: Schema.Struct({
    enabled: Schema.Literal(true),
    allow_reads: Schema.Literal(true),
    allow_writes: Schema.Literal(true),
    allowed_actors: Schema.Array(Schema.String),
    allowed_workspaces: Schema.Array(Schema.String),
  }),
});
const JsonRpcRejection = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.Number,
  error: Schema.Struct({ code: Schema.Number, message: Schema.String }),
});
const isNativeRequestError = Schema.is(CtoxNativeRequestError);
const isMcpTransportError = Schema.is(CtoxMcpTransportError);
const decodeLocalIdentity = Schema.decodeUnknownEffect(LocalIdentity);
const decodeJsonRpcRejection = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonRpcRejection));
const decodeFixture = Schema.decodeUnknownEffect(Schema.fromJsonString(Fixture));
const decodeIntentRow = Schema.decodeUnknownSync(IntentRow);
const decodeNativeReceipt = Schema.decodeUnknownSync(NativeReceipt);
const decodeSavedReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(SavedReceipt));
const decodeTokenCapture = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ value: Schema.String.check(Schema.isMinLength(1)) })),
);
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
const decodeStoredIntent = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ request: Schema.Unknown })),
);
const fixtureFile = process.argv[2];
const phase = process.argv[3];
NodeAssert.ok(
  fixtureFile && ["first", "resume", "revoked", "stop", "verify"].includes(phase ?? ""),
  "Private fixture and explicit phase required",
);
const execution = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const commandOutput = Effect.fn("NativeHttpAcceptance.commandOutput")(
    function* (command: string, args: ReadonlyArray<string>) {
      const child = yield* spawner.spawn(ChildProcess.make(command, args));
      const chunks = yield* child.stdout.pipe(Stream.decodeText(), Stream.runCollect);
      NodeAssert.equal(yield* child.exitCode, ChildProcessSpawner.ExitCode(0));
      return chunks.join("").trim();
    },
    Effect.scoped,
    Effect.timeout("5 seconds"),
  );
  NodeAssert.equal((yield* fs.stat(fixtureFile)).mode & 0o077, 0, "Fixture must be private");
  const fixture = yield* decodeFixture(yield* fs.readFileString(fixtureFile));
  const directory = yield* fs.realPath(fixture.directory);
  NodeAssert.ok(
    directory.startsWith("/Volumes/tmp/dev-artifacts/workjet/pr73-http-acceptance/"),
    "Owned tmp fixture required",
  );
  NodeAssert.equal(yield* commandOutput("git", ["rev-parse", "HEAD"]), fixture.workjetSource);
  NodeAssert.equal(yield* commandOutput("git", ["status", "--porcelain"]), "");
  const endpoint = new URL(fixture.endpoint);
  NodeAssert.ok(
    endpoint.protocol === "http:" &&
      endpoint.hostname === "127.0.0.1" &&
      endpoint.pathname === "/mcp",
    "Owned loopback MCP endpoint required",
  );
  NodeAssert.ok(
    endpoint.username === "" &&
      endpoint.password === "" &&
      endpoint.search === "" &&
      endpoint.hash === "",
    "Credentials and query parameters are forbidden in the endpoint",
  );
  const listeners = (yield* commandOutput("lsof", [
    "-nP",
    "-t",
    `-iTCP:${endpoint.port}`,
    "-sTCP:LISTEN",
  ])).split("\n");
  NodeAssert.deepEqual(
    listeners,
    [String(fixture.serverPid)],
    "Only the captured fixture server may own the port",
  );
  const nativeRoot = yield* fs.realPath(fixture.nativeRoot);
  NodeAssert.ok(
    nativeRoot.startsWith(directory + path.sep),
    "Native root must be inside the owned fixture",
  );
  const serverCommand = yield* commandOutput("ps", [
    "-p",
    String(fixture.serverPid),
    "-o",
    "command=",
  ]);
  NodeAssert.ok(
    serverCommand.includes(" business-os mcp serve ") &&
      serverCommand.endsWith(" --root " + nativeRoot),
    "Captured native server must use the owned isolated root",
  );
  NodeAssert.ok((yield* fs.realPath(fixture.tokenFile)).startsWith(directory + path.sep));
  NodeAssert.equal(
    (yield* fs.stat(fixture.tokenFile)).mode & 0o077,
    0,
    "Token capture must be private",
  );
  const token = (yield* decodeTokenCapture(yield* fs.readFileString(fixture.tokenFile))).value;
  const target = { endpoint: fixture.endpoint, token };
  const database = path.join(directory, "workjet-ledger.sqlite");
  const proofFile = path.join(directory, "accepted-native-ids.json");
  const exists = yield* fs.exists(database);
  NodeAssert.equal(
    exists,
    phase !== "first",
    "Fresh first ledger or retained later ledger required",
  );
  const key = nativeTurnKeyForRequestId(fixture.requestId);
  const identity = { ...fixture.scope, requestKey: key };
  let httpCalls = 0;
  let nativeKey: string | null = null;

  function committedIntent() {
    const db = new NodeSqlite.DatabaseSync(database, { readOnly: true });
    try {
      const rows = db.prepare("SELECT * FROM workjet_ctox_native_requests").all();
      NodeAssert.equal(
        rows.length,
        1,
        "One durable local request, observed from a separate reader",
      );
      const row = decodeIntentRow(rows[0]);
      NodeAssert.equal(row.thread_id, fixture.scope.threadId);
      NodeAssert.equal(row.request_key, key);
      NodeAssert.equal(row.connection_id, fixture.scope.connectionId);
      NodeAssert.equal(row.instance_id, fixture.scope.instanceId);
      const { request } = decodeStoredIntent(row.intent_json);
      NodeAssert.deepEqual(request, {
        ...fixture.projectTask,
        operation: "start_project_task",
        idempotency_key: key,
      });
      if (nativeKey !== null) NodeAssert.equal(row.remote_request_key, nativeKey);
      nativeKey = row.remote_request_key;
      return row;
    } finally {
      db.close();
    }
  }

  const program = Effect.gen(function* () {
    if (phase === "first") {
      yield* migration60;
      yield* migration61;
    }
    const requests = yield* CtoxNativeRequests.pipe(Effect.provide(CtoxNativeRequests.layer));
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequestEffect((request) =>
        Effect.sync(() => {
          committedIntent(); // Before every real HTTP request, including initialize and tools/list.
          httpCalls++;
          return request;
        }),
      ),
    );
    const realTransport = makeCtoxMcpTransport(http);
    const rejectedTool = Effect.fn("NativeHttpAcceptance.rejectedTool")(
      function* (name: string, args: Readonly<Record<string, unknown>>, expectedMessage: string) {
        const response = yield* http.execute(
          HttpClientRequest.post(target.endpoint).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              jsonrpc: "2.0",
              id: 9001,
              method: "tools/call",
              params: { name, arguments: args },
            }),
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(token),
          ),
        );
        NodeAssert.equal(response.status, 200, "Authorization rejection must be native JSON-RPC");
        const body = yield* response.text;
        NodeAssert.ok(isCtoxMcpResponseWithinLimit(body));
        const rejection = yield* decodeJsonRpcRejection(body);
        NodeAssert.equal(rejection.id, 9001);
        NodeAssert.ok(
          rejection.error.message.includes(expectedMessage),
          "Exact native authorization denial required",
        );
      },
      Effect.scoped,
      Effect.timeout("10 seconds"),
    );
    let dropped = false;
    const transport = {
      ...realTransport,
      callTool: (...args: Parameters<typeof realTransport.callTool>) =>
        realTransport.callTool(...args).pipe(
          Effect.flatMap((result) => {
            if (phase !== "first" || args[1] !== "business_os.start_project_task" || dropped)
              return Effect.succeed(result);
            NodeAssert.notEqual(
              result.isError,
              true,
              "The real native operation must be accepted before discarding its reply",
            );
            const receipt = decodeNativeReceipt(result.structuredContent);
            NodeAssert.equal(receipt.project_id, fixture.projectTask.project_id);
            NodeAssert.ok(nativeKey !== null);
            return Effect.gen(function* () {
              yield* fs
                .writeFileString(
                  proofFile,
                  encodeJson({
                    commandId: receipt.command_id,
                    taskId: receipt.task_id,
                    nativeKey,
                  }) + "\n",
                  { mode: 0o600, flag: "wx" },
                )
                .pipe(Effect.orDie);
              dropped = true;
              // Deliberate fault after actual HTTP acceptance, before the local receipt; no automatic replay.
              return yield* new CtoxMcpTransportError({ reason: "connection-unavailable" });
            });
          }),
        ),
    };
    const connections = {
      resolveReadyTarget: (connectionId: WorkjetConnectionId, instanceId?: string) =>
        connectionId === fixture.scope.connectionId && instanceId === fixture.scope.instanceId
          ? Effect.succeed(target)
          : Effect.fail(
              new WorkjetDecisionHubConnectionError({ reason: "connection-instance-mismatch" }),
            ),
    };
    const client = makeCtoxNativeTaskClient({ requests, connections, transport });
    if (phase === "first") {
      const failure = yield* Effect.flip(
        client.submitTurn(fixture.scope, fixture.requestId, fixture.projectTask),
      );
      NodeAssert.equal(failure._tag, "CtoxMcpTransportError");
      NodeAssert.equal(failure.reason, "connection-unavailable");
      NodeAssert.ok(dropped);
      const reference = yield* requests.get(identity);
      NodeAssert.equal(reference.commandId, null);
      NodeAssert.equal(reference.taskId, null);
      NodeAssert.equal(committedIntent().command_id, null);
      yield* realTransport.probe(target, ["business_os.status", "business_os.cancel_project_task"]);
      const status = yield* realTransport.callTool(target, "business_os.status", {});
      NodeAssert.notEqual(status.isError, true);
      const local = yield* decodeLocalIdentity(status.structuredContent);
      NodeAssert.deepEqual(local.policy.allowed_actors, ["mcp:local"]);
      NodeAssert.deepEqual(local.policy.allowed_workspaces, ["local"]);
      for (const credential of [null, "deliberately-invalid-fixture-bearer"]) {
        let request = HttpClientRequest.post(target.endpoint).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyJsonUnsafe({ jsonrpc: "2.0", id: 9002, method: "initialize" }),
        );
        if (credential !== null) request = HttpClientRequest.bearerToken(credential)(request);
        const denied = yield* http
          .execute(request)
          .pipe(Effect.scoped, Effect.timeout("10 seconds"));
        NodeAssert.equal(
          denied.status,
          401,
          "Missing and wrong bearer must fail at HTTP authentication",
        );
      }
      yield* rejectedTool(
        "business_os.status",
        {
          _context: { actor: "foreign-http-actor", workspace: "local" },
        },
        "actor is not allowed for Business OS MCP channel",
      );
      yield* rejectedTool(
        "business_os.status",
        {
          _context: { actor: "mcp:local", workspace: "foreign-http-workspace" },
        },
        "workspace is not allowed for Business OS MCP channel",
      );
    } else {
      const saved = yield* decodeSavedReceipt(yield* fs.readFileString(proofFile));
      nativeKey = saved.nativeKey;
      if (phase !== "revoked") {
        const recovered = yield* client.submitTurn(
          fixture.scope,
          fixture.requestId,
          fixture.projectTask,
        );
        NodeAssert.equal(recovered.reference.commandId, saved.commandId);
        NodeAssert.equal(recovered.reference.taskId, saved.taskId);
        NodeAssert.equal(committedIntent().command_id, saved.commandId);
        NodeAssert.equal(committedIntent().task_id, saved.taskId);
        const beforeDenial = httpCalls;
        const changed = yield* Effect.flip(
          client.submitTurn(fixture.scope, fixture.requestId, {
            ...fixture.projectTask,
            instruction: "Changed acceptance intent",
          }),
        );
        NodeAssert.equal(changed.reason, "native-request-conflict");
        const foreign = yield* Effect.flip(
          client.submitTurn(
            { ...fixture.scope, instanceId: "another-fixture-instance" },
            fixture.requestId,
            fixture.projectTask,
          ),
        );
        NodeAssert.equal(foreign.reason, "connection-instance-mismatch");
        NodeAssert.equal(
          httpCalls,
          beforeDenial,
          "Conflicting intent and scope must fail before transport",
        );
      } else {
        const reference = yield* requests.get(identity);
        NodeAssert.equal(reference.commandId, saved.commandId);
        NodeAssert.equal(reference.taskId, saved.taskId);
        const before = yield* client.readStatus(identity);
        NodeAssert.ok(["queued", "running", "waiting"].includes(before.state));
        yield* rejectedTool(
          "business_os.cancel_project_task",
          {
            target_command_id: saved.commandId,
            idempotency_key: fixture.cancelKey,
            reason: "Explicit isolated Workjet HTTP acceptance stop",
            // Negative probe only: the controller downgraded the actual stored actor to user.
            _context: { actor: "mcp:local", workspace: "local", role: "admin" },
          },
          "project task management denied:",
        );
        const after = yield* client.readStatus(identity);
        NodeAssert.equal(
          after.state,
          before.state,
          "Denied cancellation must not mutate native work",
        );
        NodeAssert.equal(after.reference.commandId, saved.commandId);
        NodeAssert.equal(after.reference.taskId, saved.taskId);
      }
      if (phase === "stop") {
        const args = {
          target_command_id: saved.commandId,
          idempotency_key: fixture.cancelKey,
          reason: "Explicit isolated Workjet HTTP acceptance stop",
        };
        yield* realTransport.probe(target, ["business_os.cancel_project_task"], {
          "business_os.cancel_project_task": ["idempotency_key"],
        });
        const stopped = yield* realTransport.callTool(
          target,
          "business_os.cancel_project_task",
          args,
        );
        NodeAssert.notEqual(stopped.isError, true);
        NodeAssert.notEqual(stopped.structuredContent, undefined);
        const repeated = yield* realTransport.callTool(
          target,
          "business_os.cancel_project_task",
          args,
        );
        NodeAssert.notEqual(repeated.isError, true);
        NodeAssert.deepEqual(repeated.structuredContent, stopped.structuredContent);
      }
      const status = yield* client.readStatus(identity);
      NodeAssert.equal(status.reference.commandId, saved.commandId);
      NodeAssert.equal(status.reference.taskId, saved.taskId);
      if (phase === "stop" || phase === "verify") NodeAssert.equal(status.state, "cancelled");
      else
        NodeAssert.ok(
          ["queued", "running", "waiting"].includes(status.state),
          "Closing the first Workjet process must not cancel native work",
        );
    }
    const final = committedIntent();
    return {
      status: "passed",
      phase,
      workjetSource: fixture.workjetSource,
      nativeSource: fixture.nativeSource,
      nativeWorkjetPin: fixture.nativeWorkjetPin,
      nativeBinarySha256: fixture.nativeBinarySha256,
      httpCalls,
      nativeKey: final.remote_request_key,
      localRequestRows: 1,
      commandId: final.command_id,
      taskId: final.task_id,
      scopeLimit:
        "Real native HTTP MCP plus Workjet task client and file-backed ledger; fixture supplies connection target. No GUI, connection-registry, provider execution, WebRTC, installed or native task-count acceptance.",
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeSqliteClient.layer({ filename: database }), FetchHttpClient.layer),
    ),
  );

  const outcome = yield* program.pipe(Effect.result);
  if (Result.isSuccess(outcome)) {
    yield* fs.writeFileString(
      path.join(directory, `workjet-${phase}-result.json`),
      encodeJson(outcome.success) + "\n",
      { mode: 0o600 },
    );
    yield* Console.log(encodeJson(outcome.success));
  } else {
    const error = outcome.failure;
    const reason =
      isNativeRequestError(error) || isMcpTransportError(error)
        ? error.reason
        : "acceptance-assertion-or-configuration";
    const result = {
      status: "failed",
      phase,
      reason,
      workjetSource: fixture.workjetSource,
      nativeSource: fixture.nativeSource,
      httpCalls,
    };
    yield* fs.writeFileString(
      path.join(directory, `workjet-${phase}-result.json`),
      encodeJson(result) + "\n",
      { mode: 0o600 },
    );
    yield* Console.error(
      `Native HTTP acceptance failed in ${phase}; no raw error or credentials emitted.`,
    );
    process.exitCode = 1;
  }
}).pipe(
  Effect.provide(NodeServices.layer),
  Effect.scoped,
  Effect.catchCause(() =>
    Effect.gen(function* () {
      yield* Console.error(
        `Native HTTP acceptance preflight or assertion failed in ${phase}; no raw error or credentials emitted.`,
      );
      process.exitCode = 1;
    }),
  ),
);

await Effect.runPromise(execution);
