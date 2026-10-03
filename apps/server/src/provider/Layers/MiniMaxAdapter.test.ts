// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { ApprovalRequestId, MiniMaxSettings, ProviderInstanceId, ThreadId, type ProviderRuntimeEvent } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { makeMiniMaxAdapter } from "./MiniMaxAdapter.ts";
import { MINIMAX_PREVIEW_MODEL } from "../minimax/MiniMaxProtocol.ts";

const fixture = fileURLToPath(new URL("../acp/fixtures/minimax-agent.mjs", import.meta.url));
const instanceId = ProviderInstanceId.make("minimax-test");
const threadId = ThreadId.make("minimax-test-thread");
const modelSelection = { instanceId, model: MINIMAX_PREVIEW_MODEL, options: [{ id: "thinkingEffort", value: "high" }] };
const input = (cwd: string) => ({ threadId, cwd, modelSelection, runtimeMode: "approval-required" as const });
const turn = (text: string) => ({ threadId, modelSelection, input: text, runtimeMode: "approval-required" as const, interactionMode: "default" as const });

async function runTest(test: (cwd: string, binaryPath: string, log: string) => Effect.Effect<void, unknown, unknown>) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-adapter-"));
  const binary = path.join(cwd, "mcode-test");
  const log = path.join(cwd, "wire.jsonl");
  fs.writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
  try { await Effect.runPromise(test(cwd, binary, log).pipe(Effect.scoped, Effect.provide(NodeServices.layer)) as Effect.Effect<void, unknown>); }
  finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

const settings = (binaryPath: string) => Schema.decodeSync(MiniMaxSettings)({ binaryPath });
const environment = (log: string) => Effect.succeed({ ...process.env, MINIMAX_TEST_LOG: log });

describe("MiniMax Code adapter protocol fixture", () => {
  it("streams reasoning/tools, waits for approval, edits a fixture, answers a question and resumes without replay", async () => {
    await runTest((cwd, binaryPath, log) => Effect.gen(function* () {
      const adapter = yield* makeMiniMaxAdapter(settings(binaryPath), { instanceId, resolveSessionEnvironment: () => environment(log) });
      const recorded: ProviderRuntimeEvent[] = [];
      const consumer = yield* adapter.streamEvents.pipe(Stream.runForEach((event) => Effect.gen(function* () {
        recorded.push(event);
        if (event.type === "request.opened" && event.requestId) yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(event.requestId), "accept");
        if (event.type === "user-input.requested" && event.requestId) yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(event.requestId), { scope: "Small" });
      })), Effect.forkChild({ startImmediately: true }));
      const session = yield* adapter.startSession(input(cwd));
      yield* adapter.sendTurn(turn("ask-question approved-edit"));
      expect(fs.readFileSync(path.join(cwd, "result.txt"), "utf8")).toBe("approved change\n");
      expect(recorded.some((event) => event.type === "content.delta" && event.payload.streamKind === "reasoning_text")).toBe(true);
      expect(recorded.some((event) => event.type === "user-input.resolved")).toBe(true);
      yield* adapter.stopSession(threadId);
      const resumed = yield* adapter.startSession({ ...input(cwd), resumeCursor: session.resumeCursor, resumePolicy: "require-existing" });
      expect(resumed.resumeCursor).toEqual(session.resumeCursor);
      yield* adapter.sendTurn(turn("continued"));
      expect(recorded.some((event) => event.type === "content.delta" && event.payload.delta === "old replay")).toBe(false);
      const wire = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(wire.filter((entry) => entry.method === "session/new")).toHaveLength(1);
      expect(wire.filter((entry) => entry.method === "session/load")).toHaveLength(1);
      expect(wire.some((entry) => entry.method === "session/set_model")).toBe(false);
      expect(wire.some((entry) => entry.params?.configId === "thinkingEffort" && entry.params.value === "high")).toBe(true);
      yield* Fiber.interrupt(consumer);
    }));
  });
  it("sends cooperative cancellation, waits for its receipt, then reuses the same session", async () => {
    await runTest((cwd, binaryPath, log) => Effect.gen(function* () {
      const adapter = yield* makeMiniMaxAdapter(settings(binaryPath), { instanceId, resolveSessionEnvironment: () => environment(log) });
      const waiting = yield* Deferred.make<void>();
      const recorded: ProviderRuntimeEvent[] = [];
      const consumer = yield* adapter.streamEvents.pipe(Stream.runForEach((event) => {
        recorded.push(event);
        return event.type === "content.delta" && event.payload.delta === "waiting" ? Deferred.succeed(waiting, undefined).pipe(Effect.asVoid) : Effect.void;
      }), Effect.forkChild({ startImmediately: true }));
      const session = yield* adapter.startSession(input(cwd));
      const running = yield* adapter.sendTurn(turn("wait-for-cancel")).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(waiting);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(running);
      expect(recorded.some((event) => event.type === "turn.completed" && event.payload.state === "cancelled")).toBe(true);
      expect((yield* adapter.listSessions())[0]?.resumeCursor).toEqual(session.resumeCursor);
      yield* adapter.sendTurn(turn("after cancellation"));
      expect(fs.readFileSync(log, "utf8")).toContain('"method":"session/cancel"');
      yield* Fiber.interrupt(consumer);
    }));
  });
  it("rejects another instance's model and an unavailable model before sending a prompt", async () => {
    await runTest((cwd, binaryPath, log) => Effect.gen(function* () {
      const adapter = yield* makeMiniMaxAdapter(settings(binaryPath), { instanceId, resolveSessionEnvironment: () => environment(log) });
      const mismatched = yield* adapter.startSession({ ...input(cwd), modelSelection: { ...modelSelection, instanceId: ProviderInstanceId.make("other-instance") } }).pipe(Effect.flip);
      expect(mismatched.message).toContain("another harness instance");
      const missing = yield* adapter.startSession({ ...input(cwd), modelSelection: { instanceId, model: "unavailable-model" } }).pipe(Effect.flip);
      expect(missing.message).toContain("does not advertise");
      expect(fs.readFileSync(log, "utf8")).not.toContain('"method":"session/prompt"');
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }));
  });
});
