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
import type * as Scope from "effect/Scope";
import * as Layer from "effect/Layer";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { layerTest as configLayerTest } from "../../config.ts";
import { layerTest as settingsLayerTest } from "../../serverSettings.ts";
import { MiniMaxDriver } from "../Drivers/MiniMaxDriver.ts";
import { ApprovalRequestId, MiniMaxSettings, ProviderInstanceId, ThreadId, type ProviderRuntimeEvent } from "@workjet/contracts";
import { describe, expect, it } from "vite-plus/test";
import { makeMiniMaxAdapter } from "./MiniMaxAdapter.ts";
import { MINIMAX_PREVIEW_MODEL } from "../minimax/MiniMaxProtocol.ts";
import { checkMiniMaxProviderStatus } from "./MiniMaxProvider.ts";

const fixture = fileURLToPath(new URL("../acp/fixtures/minimax-agent.mjs", import.meta.url));
const instanceId = ProviderInstanceId.make("minimax-test");
const threadId = ThreadId.make("minimax-test-thread");
const modelSelection = { instanceId, model: MINIMAX_PREVIEW_MODEL, options: [{ id: "thinkingEffort", value: "high" }] };
const input = (cwd: string) => ({ threadId, cwd, modelSelection, runtimeMode: "approval-required" as const });
const turn = (text: string) => ({ threadId, modelSelection, input: text, runtimeMode: "approval-required" as const, interactionMode: "default" as const });

async function runTest(test: (cwd: string, binaryPath: string, log: string) => Effect.Effect<void, unknown, NodeServices.NodeServices | Scope.Scope>) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "minimax-adapter-"));
  const binary = path.join(cwd, "mcode-test");
  const log = path.join(cwd, "wire.jsonl");
  fs.writeFileSync(binary, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
  try { await Effect.runPromise(test(cwd, binary, log).pipe(Effect.scoped, Effect.provide(NodeServices.layer))); }
  finally { fs.rmSync(cwd, { recursive: true, force: true }); }
}

const settings = (binaryPath: string) => Schema.decodeSync(MiniMaxSettings)({ binaryPath });
const environment = (log: string) => Effect.succeed({ ...process.env, MINIMAX_TEST_LOG: log });

describe("MiniMax Code adapter protocol fixture", () => {
  it("streams reasoning/tools, waits for approval, edits a fixture, answers a question and resumes without replay", async () => {
    await runTest((cwd, binaryPath, log) => Effect.gen(function* () {
      const adapter = yield* makeMiniMaxAdapter(settings(binaryPath), { instanceId, resolveSessionEnvironment: () => environment(log) });
      const recorded: ProviderRuntimeEvent[] = [];
      const completed = yield* Deferred.make<void>();
      const consumer = yield* adapter.streamEvents.pipe(Stream.runForEach((event) => Effect.gen(function* () {
        recorded.push(event);
        if (event.type === "turn.completed") yield* Deferred.succeed(completed, undefined);
        if (event.type === "request.opened" && event.requestId) yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(event.requestId), "accept");
        if (event.type === "user-input.requested" && event.requestId) yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(event.requestId), { scope: "Small" });
      })), Effect.forkChild({ startImmediately: true }));
      const session = yield* adapter.startSession(input(cwd));
      yield* adapter.sendTurn(turn("ask-question approved-edit"));
      yield* Deferred.await(completed);
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
      const cancelled = yield* Deferred.make<void>();
      const recorded: ProviderRuntimeEvent[] = [];
      const consumer = yield* adapter.streamEvents.pipe(Stream.runForEach((event) => {
        recorded.push(event);
        if (event.type === "turn.completed" && event.payload.state === "cancelled") return Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid);
        return event.type === "content.delta" && event.payload.delta === "waiting" ? Deferred.succeed(waiting, undefined).pipe(Effect.asVoid) : Effect.void;
      }), Effect.forkChild({ startImmediately: true }));
      const session = yield* adapter.startSession(input(cwd));
      const running = yield* adapter.sendTurn(turn("wait-for-cancel")).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(waiting);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(running);
      yield* Deferred.await(cancelled);
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
  it("retains a live session when a resume cursor belongs to another profile", async () => {
    await runTest((cwd, binaryPath, log) => Effect.gen(function* () {
      const adapter = yield* makeMiniMaxAdapter(settings(binaryPath), { instanceId, resolveSessionEnvironment: () => environment(log) });
      const session = yield* adapter.startSession(input(cwd));
      const failure = yield* adapter.startSession({ ...input(cwd), resumeCursor: { protocol: "minimax-acp", sessionId: "minimax-fixture-session", profileKey: "foreign-profile" } }).pipe(Effect.flip);
      expect(failure.message).toContain("different profile");
      expect((yield* adapter.listSessions())[0]?.resumeCursor).toEqual(session.resumeCursor);
      yield* adapter.sendTurn(turn("original session still works"));
      const methods = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).method);
      expect(methods.filter((method) => method === "session/new")).toHaveLength(1);
      expect(methods).not.toContain("session/load");
    }));
  });
  it("reports a disconnected turn, rejects further prompts and loads the saved session", async () => {
    await runTest((cwd, binaryPath, log) => Effect.gen(function* () {
      const adapter = yield* makeMiniMaxAdapter(settings(binaryPath), { instanceId, resolveSessionEnvironment: () => environment(log) });
      const failed = yield* Deferred.make<void>();
      const consumer = yield* adapter.streamEvents.pipe(Stream.runForEach((event) => event.type === "turn.completed" && event.payload.state === "failed" ? Deferred.succeed(failed, undefined).pipe(Effect.asVoid) : Effect.void), Effect.forkChild({ startImmediately: true }));
      const session = yield* adapter.startSession(input(cwd));
      yield* adapter.sendTurn(turn("disconnect")).pipe(Effect.flip);
      yield* Deferred.await(failed);
      const disconnected = yield* adapter.sendTurn(turn("must reconnect")).pipe(Effect.flip);
      expect(disconnected.message).toContain("Resume the saved");
      const resumed = yield* adapter.startSession({ ...input(cwd), resumeCursor: session.resumeCursor, resumePolicy: "require-existing" });
      expect(resumed.resumeCursor).toEqual(session.resumeCursor);
      yield* adapter.sendTurn(turn("reconnected"));
      yield* Fiber.interrupt(consumer);
    }));
  });
  it("reuses its persisted health session after refresh and discovers only native models", async () => {
    await runTest((cwd, binaryPath, log) => Effect.gen(function* () {
      const cache = path.join(cwd, "probe.json");
      const env = { ...process.env, MINIMAX_TEST_LOG: log };
      const first = yield* checkMiniMaxProviderStatus(settings(binaryPath), env, cache, cwd);
      const second = yield* checkMiniMaxProviderStatus(settings(binaryPath), env, cache, cwd);
      expect(first.status).toBe("ready");
      expect(second.auth.status).toBe("authenticated");
      expect(second.models.map((entry) => entry.slug)).toEqual([MINIMAX_PREVIEW_MODEL]);
      const methods = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line).method);
      expect(methods.filter((method) => method === "session/new")).toHaveLength(1);
      expect(methods.filter((method) => method === "session/load")).toHaveLength(1);
      expect(methods.filter((method) => method === "session/close")).toHaveLength(2);
    }));
  });
  it("keeps an unsupported gateway route unavailable without probing direct credentials", async () => {
    await runTest((cwd, binaryPath, log) => Effect.gen(function* () {
      const provider = yield* MiniMaxDriver.create({ instanceId, displayName: undefined, environment: [{ name: "MINIMAX_TEST_LOG", value: log, sensitive: false }], enabled: true, routeViaGateway: true, config: settings(binaryPath) });
      const snapshot = yield* provider.snapshot.refresh;
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.models).toEqual([]);
      expect(snapshot.message).toContain("Disable the gateway option");
      const failure = yield* provider.adapter.startSession(input(cwd)).pipe(Effect.flip);
      expect(failure.message).toContain("gateway injection is not verified");
      expect(fs.existsSync(log)).toBe(false);
    }).pipe(Effect.provide(Layer.mergeAll(configLayerTest(cwd, path.join(cwd, "server-state")), settingsLayerTest(), Layer.mock(BackgroundPolicy.BackgroundPolicy)({ shouldRunScopeWork: () => Effect.succeed(false) })))));
  });
  it("distinguishes missing login, unsupported release and unavailable model", async () => {
    await runTest((cwd, binaryPath, log) => Effect.gen(function* () {
      const env = { ...process.env, MINIMAX_TEST_LOG: log };
      const unauthenticated = yield* checkMiniMaxProviderStatus(settings(binaryPath), { ...env, MINIMAX_TEST_AUTH_REQUIRED: "1" }, undefined, cwd);
      expect(unauthenticated.auth.status).toBe("unauthenticated");
      expect(unauthenticated.models).toEqual([]);
      const unsupported = yield* checkMiniMaxProviderStatus(settings(binaryPath), { ...env, MINIMAX_TEST_VERSION: "0.5.0" }, undefined, cwd);
      expect(unsupported.status).toBe("error");
      expect(unsupported.version).toBe("0.5.0");
      const noModels = yield* checkMiniMaxProviderStatus(settings(binaryPath), { ...env, MINIMAX_TEST_NO_MODELS: "1" }, undefined, cwd);
      expect(noModels.auth.status).toBe("authenticated");
      expect(noModels.status).toBe("warning");
      expect(noModels.models).toEqual([]);
      expect(noModels.message).toContain("does not advertise");
    }));
  });
});
