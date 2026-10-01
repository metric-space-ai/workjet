/** Explicit integration runner: each phase runs in a fresh process against an owned native HTTP MCP fixture.
 * Run: node native-http-acceptance.ts <private-fixture.json> <first|resume|stop|verify>
 * This does not establish desktop UI, connection-registry, provider or installed acceptance.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import {
  ThreadId,
  WorkjetConnectionId,
  WorkjetDecisionHubConnectionError,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import * as NodeSqliteClient from "../../../persistence/NodeSqliteClient.ts";
import migration60 from "../../../persistence/Migrations/060_WorkjetCtoxNativeRequests.ts";
import migration61 from "../../../persistence/Migrations/061_WorkjetCtoxNativeTurns.ts";
import { CtoxNativeRequestError, CtoxNativeRequests } from "../CtoxNativeRequests.ts";
import { CtoxMcpTransportError, makeCtoxMcpTransport } from "../CtoxMcpTransport.ts";
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
const decodeFixture = Schema.decodeUnknownSync(Fixture);
const decodeIntentRow = Schema.decodeUnknownSync(IntentRow);
const decodeNativeReceipt = Schema.decodeUnknownSync(NativeReceipt);
const decodeSavedReceipt = Schema.decodeUnknownSync(SavedReceipt);
const decodeTokenCapture = Schema.decodeUnknownSync(
  Schema.Struct({ value: Schema.String.check(Schema.isMinLength(1)) }),
);
const fixtureFile = process.argv[2];
const phase = process.argv[3];
NodeAssert.ok(
  fixtureFile && ["first", "resume", "stop", "verify"].includes(phase ?? ""),
  "Private fixture and explicit phase required",
);
NodeAssert.equal(NodeFS.statSync(fixtureFile).mode & 0o077, 0, "Fixture must be private");
function loadPrivateFixture() {
  try {
    return decodeFixture(JSON.parse(NodeFS.readFileSync(fixtureFile!, "utf8")));
  } catch {
    throw new Error("Private acceptance fixture is invalid");
  }
}
const fixture = loadPrivateFixture();
const directory = NodeFS.realpathSync(fixture.directory);
NodeAssert.ok(
  directory.startsWith("/Volumes/tmp/dev-artifacts/workjet/pr73-http-acceptance/"),
  "Owned tmp fixture required",
);
NodeAssert.equal(
  NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 5000,
  }).trim(),
  fixture.workjetSource,
);
NodeAssert.equal(
  NodeChildProcess.execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
    timeout: 5000,
  }).trim(),
  "",
);
function loopbackEndpoint() {
  try {
    return new URL(fixture.endpoint);
  } catch {
    throw new Error("Owned loopback MCP endpoint required");
  }
}
const endpoint = loopbackEndpoint();
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
const listeners = NodeChildProcess.execFileSync(
  "lsof",
  ["-nP", "-t", `-iTCP:${endpoint.port}`, "-sTCP:LISTEN"],
  {
    encoding: "utf8",
    timeout: 5000,
  },
)
  .trim()
  .split("\n");
NodeAssert.deepEqual(
  listeners,
  [String(fixture.serverPid)],
  "Only the captured fixture server may own the port",
);
const nativeRoot = NodeFS.realpathSync(fixture.nativeRoot);
NodeAssert.ok(
  nativeRoot.startsWith(directory + NodePath.sep),
  "Native root must be inside the owned fixture",
);
const serverCommand = NodeChildProcess.execFileSync(
  "ps",
  ["-p", String(fixture.serverPid), "-o", "command="],
  {
    encoding: "utf8",
    timeout: 5000,
  },
).trim();
NodeAssert.ok(
  serverCommand.includes(" business-os mcp serve ") &&
    serverCommand.endsWith(" --root " + nativeRoot),
  "Captured native server must use the owned isolated root",
);
NodeAssert.ok(NodeFS.realpathSync(fixture.tokenFile).startsWith(directory + NodePath.sep));
NodeAssert.equal(
  NodeFS.statSync(fixture.tokenFile).mode & 0o077,
  0,
  "Token capture must be private",
);
function loadPrivateToken() {
  try {
    return decodeTokenCapture(JSON.parse(NodeFS.readFileSync(fixture.tokenFile, "utf8"))).value;
  } catch {
    throw new Error("Private token capture is invalid");
  }
}
const token = loadPrivateToken();
const target = { endpoint: fixture.endpoint, token };
const database = NodePath.join(directory, "workjet-ledger.sqlite");
const proofFile = NodePath.join(directory, "accepted-native-ids.json");
if (phase === "first")
  NodeAssert.ok(!NodeFS.existsSync(database), "First phase must use a fresh ledger");
else NodeAssert.ok(NodeFS.existsSync(database), "A later phase must reopen the retained ledger");
const key = nativeTurnKeyForRequestId(fixture.requestId);
const identity = { ...fixture.scope, requestKey: key };
let httpCalls = 0;
let nativeKey: string | null = null;

function committedIntent() {
  const db = new NodeSqlite.DatabaseSync(database, { readOnly: true });
  try {
    const rows = db.prepare("SELECT * FROM workjet_ctox_native_requests").all();
    NodeAssert.equal(rows.length, 1, "One durable local request, observed from a separate reader");
    const row = decodeIntentRow(rows[0]);
    NodeAssert.equal(row.thread_id, fixture.scope.threadId);
    NodeAssert.equal(row.request_key, key);
    NodeAssert.equal(row.connection_id, fixture.scope.connectionId);
    NodeAssert.equal(row.instance_id, fixture.scope.instanceId);
    const { request } = JSON.parse(row.intent_json);
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
          NodeFS.writeFileSync(
            proofFile,
            JSON.stringify({ commandId: receipt.command_id, taskId: receipt.task_id, nativeKey }) +
              "\n",
            { mode: 0o600, flag: "wx" },
          );
          dropped = true;
          // Deliberate fault between real HTTP acceptance and local receipt storage; no automatic replay.
          return Effect.fail(new CtoxMcpTransportError({ reason: "connection-unavailable" }));
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
  } else {
    const saved = decodeSavedReceipt(JSON.parse(NodeFS.readFileSync(proofFile, "utf8")));
    nativeKey = saved.nativeKey;
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

try {
  const result = await Effect.runPromise(program);
  NodeFS.writeFileSync(
    NodePath.join(directory, `workjet-${phase}-result.json`),
    JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify(result));
} catch (error) {
  const reason =
    Schema.is(CtoxNativeRequestError)(error) || Schema.is(CtoxMcpTransportError)(error)
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
  NodeFS.writeFileSync(
    NodePath.join(directory, `workjet-${phase}-result.json`),
    JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.error(`Native HTTP acceptance failed in ${phase}; no raw error or credentials emitted.`);
  process.exitCode = 1;
}
