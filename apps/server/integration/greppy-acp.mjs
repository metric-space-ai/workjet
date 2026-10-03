// Run through the shared heavy-job gate with Node24 and an explicitly built Greppy binary.
// This exercises the real Workjet adapter and Greppy process against a local model fixture.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  GreppySettings,
  ProviderInstanceId,
  ThreadId,
} from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeGreppyAdapter } from "../src/provider/Layers/GreppyAdapter.ts";

const binary = process.argv[2];
NodeAssert.ok(
  binary && NodePath.isAbsolute(binary),
  "Pass the absolute path to a built ACP Greppy binary.",
);
NodeAssert.ok(
  process.env.TMPDIR?.startsWith("/Volumes/tmp/"),
  "Use the shared admission gate and tmp volume.",
);
const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "greppy-acp-acceptance-"));
const deniedMarker = NodePath.join(root, "denied-tool.txt");
const approvedMarker = NodePath.join(root, "approved-tool.txt");
const requests = [];
const failures = [];
const sockets = new Set();
let hangingRequest;
const hanging = new Promise((resolve) => {
  hangingRequest = resolve;
});

function answer(response, content, stopReason, model) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const write = (event, data) =>
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  write("message_start", {
    type: "message_start",
    message: {
      id: "fixture",
      type: "message",
      role: "assistant",
      model,
      content: [],
      usage: { input_tokens: 7, output_tokens: 0 },
    },
  });
  if (content.type === "text") {
    write("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    write("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: content.text },
    });
  } else {
    write("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: content.id, name: content.name, input: {} },
    });
    write("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(content.arguments) },
    });
  }
  write("content_block_stop", { type: "content_block_stop", index: 0 });
  write("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason },
    usage: { output_tokens: 3 },
  });
  write("message_stop", { type: "message_stop" });
  response.end();
}

const server = NodeHttp.createServer(async (request, response) => {
  try {
    NodeAssert.equal(request.url, "/v1/messages");
    NodeAssert.equal(request.headers["x-api-key"], "fixture-only");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const user = body.messages.filter((message) => message.role === "user").at(-1);
    const text =
      typeof user?.content === "string"
        ? user.content
        : (user?.content ?? [])
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
    if (text === "hang") {
      hangingRequest();
      return;
    }
    if (text === "permission-denial" || text === "permission-approval") {
      const tool = body.tools?.find((candidate) => candidate.name === "greppy");
      NodeAssert.ok(tool, "Greppy must advertise its actual greppy tool.");
      NodeAssert.equal(tool.input_schema.properties.args.type, "array");
      const approved = text === "permission-approval";
      answer(
        response,
        {
          type: "tool_use",
          id: approved ? "fixture-approved-tool" : "fixture-denied-tool",
          name: tool.name,
          arguments: {
            args: ["bash-smart", "--", "/usr/bin/touch", approved ? approvedMarker : deniedMarker],
          },
        },
        "tool_use",
        body.model,
      );
      return;
    }
    answer(response, { type: "text", text: "Greppy ✓: fixture answer" }, "end_turn", body.model);
  } catch (error) {
    failures.push(String(error));
    response.writeHead(500);
    response.end("Fixture request failed");
  }
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const instanceId = ProviderInstanceId.make("greppy-fixture");
const threadId = ThreadId.make("greppy-fixture-thread");
const seen = [];
let approveNextPermission = false;
let resumeCursor;

try {
  await Effect.runPromise(
    Effect.gen(function* () {
      const adapter = yield* makeGreppyAdapter(
        Schema.decodeUnknownSync(GreppySettings)({
          enabled: true,
          binaryPath: binary,
          endpoint,
          model: "fixture-model",
          maxTurns: 4,
        }),
        {
          instanceId,
          resolveSessionEnvironment: () =>
            Effect.succeed({
              PATH: process.env.PATH,
              TMPDIR: process.env.TMPDIR,
              GREPPY_STORE_DIR: NodePath.join(root, "store"),
              GREPPY_API_KEY: "fixture-only",
            }),
        },
      );
      const completed = yield* Queue.unbounded();
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => {
          seen.push(event);
          if (event.type === "request.opened") {
            const decision = approveNextPermission ? "accept" : "decline";
            approveNextPermission = false;
            return adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(event.requestId),
              decision,
            );
          }
          if (event.type === "turn.completed")
            return Queue.offer(completed, event).pipe(Effect.asVoid);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const start = { threadId, cwd: root, runtimeMode: "approval-required" };
      const session = yield* adapter.startSession(start);
      resumeCursor = session.resumeCursor;
      yield* adapter.sendTurn({ threadId, input: "first" });
      NodeAssert.equal((yield* Queue.take(completed)).payload.state, "completed");
      yield* adapter.sendTurn({
        threadId,
        input: "follow-up",
        modelSelection: { instanceId, model: "fixture-alt-model" },
      });
      NodeAssert.equal((yield* Queue.take(completed)).payload.state, "completed");
      NodeAssert.equal(requests.at(-1).model, "fixture-alt-model");
      NodeAssert.ok(
        requests.at(-1).messages.some((message) => message.role === "assistant"),
        "Follow-up must include prior assistant history.",
      );
      yield* adapter.sendTurn({ threadId, input: "permission-denial" });
      NodeAssert.equal((yield* Queue.take(completed)).payload.state, "completed");
      NodeAssert.ok(
        seen.some(
          (event) => event.type === "request.resolved" && event.payload.decision === "decline",
        ),
      );
      NodeAssert.ok(
        requests.some((body) =>
          body.messages.some(
            (message) =>
              Array.isArray(message.content) &&
              message.content.some(
                (part) =>
                  part.type === "tool_result" &&
                  part.tool_use_id === "fixture-denied-tool" &&
                  part.is_error === true,
              ),
          ),
        ),
        "Denied tool must produce an error result without execution.",
      );
      yield* Effect.promise(() =>
        NodeAssert.rejects(NodeFSP.stat(deniedMarker), { code: "ENOENT" }),
      );
      approveNextPermission = true;
      yield* adapter.sendTurn({ threadId, input: "permission-approval" });
      NodeAssert.equal((yield* Queue.take(completed)).payload.state, "completed");
      yield* Effect.promise(() => NodeFSP.stat(approvedMarker));
      NodeAssert.ok(
        seen.some(
          (event) => event.type === "request.resolved" && event.payload.decision === "accept",
        ),
      );
      NodeAssert.ok(
        requests.some((body) =>
          body.messages.some(
            (message) =>
              Array.isArray(message.content) &&
              message.content.some(
                (part) =>
                  part.type === "tool_result" &&
                  part.tool_use_id === "fixture-approved-tool" &&
                  part.is_error !== true,
              ),
          ),
        ),
        "Approved tool must execute and return a successful result to the model.",
      );
      const prompt = yield* adapter
        .sendTurn({ threadId, input: "hang" })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => hanging);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(prompt).pipe(Effect.timeout("2 seconds"));
      NodeAssert.equal((yield* Queue.take(completed)).payload.state, "cancelled");
      yield* adapter.sendTurn({ threadId, input: "after-cancel" });
      NodeAssert.equal((yield* Queue.take(completed)).payload.state, "completed");
      yield* adapter.stopSession(threadId);
      const restarted = yield* adapter.startSession({ ...start, resumeCursor });
      NodeAssert.deepEqual(restarted.resumeCursor, resumeCursor);
      yield* adapter.sendTurn({ threadId, input: "after-restart" });
      NodeAssert.equal((yield* Queue.take(completed)).payload.state, "completed");
      NodeAssert.ok(
        requests
          .at(-1)
          .messages.some((message) => JSON.stringify(message.content).includes("after-cancel")),
        "Restart must restore persisted conversation history.",
      );
      NodeAssert.ok(
        seen.some((event) => event.type === "content.delta"),
        "Assistant text must reach canonical Workjet events.",
      );
      NodeAssert.deepEqual(failures, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.timeout("60 seconds")),
  );
  process.stdout.write(
    `${JSON.stringify({ status: "passed", workflow: "greppy-real-process-acp", prompts: requests.length, streamedEvents: seen.length, gates: ["start", "follow-up", "model-switch", "deny", "allow-once", "blocked-model-cancel", "immediate-follow-up", "restart-history"], uiAcceptance: "not-run" })}\n`,
  );
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  await NodeFSP.rm(root, { recursive: true, force: true });
}
