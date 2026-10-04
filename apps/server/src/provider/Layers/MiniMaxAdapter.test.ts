// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
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
import {
  ApprovalRequestId,
  MiniMaxSettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@workjet/contracts";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { makeMiniMaxAdapter } from "./MiniMaxAdapter.ts";
import { MINIMAX_PREVIEW_MODEL } from "../minimax/MiniMaxProtocol.ts";
import { checkMiniMaxProviderStatus } from "./MiniMaxProvider.ts";

const fixture = NodeURL.fileURLToPath(
  new URL("../acp/fixtures/minimax-agent.mjs", import.meta.url),
);
const instanceId = ProviderInstanceId.make("minimax-test");
const threadId = ThreadId.make("minimax-test-thread");
const modelSelection = {
  instanceId,
  model: MINIMAX_PREVIEW_MODEL,
  options: [{ id: "thinkingEffort", value: "high" }],
};
const input = (cwd: string) => ({
  threadId,
  cwd,
  modelSelection,
  runtimeMode: "approval-required" as const,
});
const turn = (text: string) => ({
  threadId,
  modelSelection,
  input: text,
  runtimeMode: "approval-required" as const,
  interactionMode: "default" as const,
});

function runTest(
  test: (
    cwd: string,
    binaryPath: string,
    log: string,
  ) => Effect.Effect<void, unknown, NodeServices.NodeServices | Scope.Scope>,
) {
  return Effect.gen(function* () {
    const cwd = yield* Effect.acquireRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "minimax-adapter-"))),
      (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    const binary = NodePath.join(cwd, "mcode-test");
    const log = NodePath.join(cwd, "wire.jsonl");
    yield* Effect.sync(() =>
      NodeFS.writeFileSync(
        binary,
        `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.replaceAll("'", "'\\''")}' "$@"\n`,
        { mode: 0o700 },
      ),
    );
    yield* test(cwd, binary, log);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
}

const decodeMiniMaxSettings = Schema.decodeSync(MiniMaxSettings);
const settings = (binaryPath: string) => decodeMiniMaxSettings({ binaryPath });
const environment = (log: string) => Effect.succeed({ ...process.env, MINIMAX_TEST_LOG: log });

describe("MiniMax Code adapter protocol fixture", () => {
  it.live("refuses approval-required turns on a permissive native profile without changing it", () =>
    runTest((cwd, binaryPath, log) =>
      Effect.gen(function* () {
        for (const permissionMode of ["auto", "bypassPermissions"]) {
          const adapter = yield* makeMiniMaxAdapter(settings(binaryPath), {
            instanceId,
            resolveSessionEnvironment: () =>
              Effect.succeed({
                ...process.env,
                MINIMAX_TEST_LOG: log,
                MINIMAX_TEST_PERMISSION_MODE: permissionMode,
              }),
          });
          const refusedStart = yield* adapter.startSession(input(cwd)).pipe(Effect.flip);
          expect(refusedStart.message).toContain('permission mode "Ask"');
          expect(yield* adapter.hasSession(threadId)).toBe(false);
          const session = yield* adapter.startSession({ ...input(cwd), runtimeMode: "full-access" });
          const initialWire = NodeFS.readFileSync(log, "utf8");
          const refusedTurn = yield* adapter.sendTurn(turn("must not run")).pipe(Effect.flip);
          expect(refusedTurn.message).toContain('permission mode "Ask"');
          expect((yield* adapter.listSessions())[0]).toEqual(session);
          expect(NodeFS.readFileSync(log, "utf8")).toBe(initialWire);
          expect(initialWire).not.toContain('"configId":"permissionMode"');
          yield* adapter.stopSession(threadId);
        }
      }),
    ),
  );
  it.live("uses the current turn's approval mode when switching out of full access", () =>
    runTest((cwd, binaryPath, log) =>
      Effect.gen(function* () {
        const adapter = yield* makeMiniMaxAdapter(settings(binaryPath), {
          instanceId,
          resolveSessionEnvironment: () => environment(log),
        });
        let approvalRequests = 0;
        const consumer = yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.type === "request.opened" && event.requestId) {
                approvalRequests++;
                yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(event.requestId), "accept");
              }
            }),
          ),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* adapter.startSession({ ...input(cwd), runtimeMode: "full-access" });
        yield* adapter.sendTurn({ ...turn("approved-edit"), runtimeMode: "full-access" });
        expect(approvalRequests).toBe(0);
        yield* adapter.sendTurn(turn("approved-edit"));
        expect(approvalRequests).toBe(1);
        expect((yield* adapter.listSessions())[0]?.runtimeMode).toBe("approval-required");
        expect(NodeFS.readFileSync(log, "utf8")).not.toContain('"configId":"permissionMode"');
        yield* Fiber.interrupt(consumer);
      }),
    ),
  );
  it.live(
    "streams reasoning/tools, waits for approval, edits a fixture, answers a question and resumes without replay",
    () => {
      return runTest((cwd, binaryPath, log) =>
        Effect.gen(function* () {
          const adapter = yield* makeMiniMaxAdapter(settings(binaryPath), {
            instanceId,
            resolveSessionEnvironment: () => environment(log),
          });
          const recorded: ProviderRuntimeEvent[] = [];
          const completed = yield* Deferred.make<void>();
          const consumer = yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                recorded.push(event);
                if (event.type === "turn.completed") yield* Deferred.succeed(completed, undefined);
                if (event.type === "request.opened" && event.requestId)
                  yield* adapter.respondToRequest(
                    threadId,
                    ApprovalRequestId.make(event.requestId),
                    "accept",
                  );
                if (event.type === "user-input.requested" && event.requestId) {
                  const requestId = ApprovalRequestId.make(event.requestId);
                  const invalid = yield* adapter
                    .respondToUserInput(threadId, requestId, { scope: ["unadvertised"] })
                    .pipe(Effect.flip);
                  expect(invalid.message).toContain("Unadvertised answer");
                  yield* adapter.respondToUserInput(threadId, requestId, { scope: ["Small"] });
                }
              }),
            ),
            Effect.forkChild({ startImmediately: true }),
          );
          const session = yield* adapter.startSession(input(cwd));
          yield* adapter.sendTurn(turn("ask-question approved-edit"));
          yield* Deferred.await(completed);
          expect(NodeFS.readFileSync(NodePath.join(cwd, "result.txt"), "utf8")).toBe(
            "approved change\n",
          );
          expect(
            recorded.some(
              (event) =>
                event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
            ),
          ).toBe(true);
          expect(recorded.some((event) => event.type === "user-input.resolved")).toBe(true);
          yield* adapter.stopSession(threadId);
          const resumed = yield* adapter.startSession({
            ...input(cwd),
            resumeCursor: session.resumeCursor,
            resumePolicy: "require-existing",
          });
          expect(resumed.resumeCursor).toEqual(session.resumeCursor);
          yield* adapter.sendTurn(turn("continued"));
          expect(
            recorded.some(
              (event) => event.type === "content.delta" && event.payload.delta === "old replay",
            ),
          ).toBe(false);
          const wire = NodeFS.readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(wire.filter((entry) => entry.method === "session/new")).toHaveLength(1);
          expect(wire.filter((entry) => entry.method === "session/load")).toHaveLength(1);
          expect(wire.some((entry) => entry.method === "session/set_model")).toBe(false);
          expect(
            wire.some(
              (entry) =>
                entry.params?.configId === "thinkingEffort" && entry.params.value === "high",
            ),
          ).toBe(true);
          yield* Fiber.interrupt(consumer);
        }),
      );
    },
  );
  it.live(
    "sends cooperative cancellation, waits for its receipt, then reuses the same session",
    () => {
      return runTest((cwd, binaryPath, log) =>
        Effect.gen(function* () {
          const adapter = yield* makeMiniMaxAdapter(settings(binaryPath), {
            instanceId,
            resolveSessionEnvironment: () => environment(log),
          });
          const waiting = yield* Deferred.make<void>();
          const cancelled = yield* Deferred.make<void>();
          const recorded: ProviderRuntimeEvent[] = [];
          const consumer = yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) => {
              recorded.push(event);
              if (event.type === "turn.completed" && event.payload.state === "cancelled")
                return Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid);
              return event.type === "content.delta" && event.payload.delta === "waiting"
                ? Deferred.succeed(waiting, undefined).pipe(Effect.asVoid)
                : Effect.void;
            }),
            Effect.forkChild({ startImmediately: true }),
          );
          const session = yield* adapter.startSession(input(cwd));
          const running = yield* adapter
            .sendTurn(turn("wait-for-cancel"))
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(waiting);
          yield* adapter.interruptTurn(threadId);
          expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
          yield* Fiber.join(running);
          yield* Deferred.await(cancelled);
          expect(
            recorded.some(
              (event) => event.type === "turn.completed" && event.payload.state === "cancelled",
            ),
          ).toBe(true);
          expect((yield* adapter.listSessions())[0]?.resumeCursor).toEqual(session.resumeCursor);
          yield* adapter.sendTurn(turn("after cancellation"));
          expect(NodeFS.readFileSync(log, "utf8")).toContain('"method":"session/cancel"');
          yield* Fiber.interrupt(consumer);
        }),
      );
    },
  );
  it.live("settles an unacknowledged cancellation before a concurrent same-cursor resume", () => {
    return runTest((cwd, binaryPath, log) =>
      Effect.gen(function* () {
        let ignoreCancel = true;
        const adapter = yield* makeMiniMaxAdapter(settings(binaryPath), {
          instanceId,
          resolveSessionEnvironment: () =>
            Effect.succeed({
              ...process.env,
              MINIMAX_TEST_LOG: log,
              ...(ignoreCancel ? { MINIMAX_TEST_IGNORE_CANCEL: "1" } : {}),
            }),
        });
        const waiting = yield* Deferred.make<void>();
        const notified = yield* Deferred.make<void>();
        const failed = yield* Deferred.make<void>();
        const recorded: ProviderRuntimeEvent[] = [];
        const consumer = yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => {
            recorded.push(event);
            if (event.type === "content.delta" && event.payload.delta === "waiting")
              return Deferred.succeed(waiting, undefined).pipe(Effect.asVoid);
            if (
              event.type === "content.delta" &&
              event.payload.delta === "cancel-notification-received"
            )
              return Deferred.succeed(notified, undefined).pipe(Effect.asVoid);
            if (event.type === "turn.completed" && event.payload.state === "failed")
              return Deferred.succeed(failed, undefined).pipe(Effect.asVoid);
            return Effect.void;
          }),
          Effect.forkChild({ startImmediately: true }),
        );
        const session = yield* adapter.startSession(input(cwd));
        const running = yield* adapter
          .sendTurn(turn("wait-for-cancel"))
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(waiting);
        const interrupted = yield* adapter
          .interruptTurn(threadId)
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(notified);
        ignoreCancel = false;
        const replacing = yield* adapter
          .startSession({
            ...input(cwd),
            resumeCursor: session.resumeCursor,
            resumePolicy: "require-existing",
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        expect((yield* adapter.listSessions())[0]?.status).toBe("running");
        const failure = yield* Fiber.join(interrupted);
        expect(failure.message).toContain("within 30 seconds");
        yield* Deferred.await(failed);
        yield* Fiber.await(running);
        const completed = recorded.filter((event) => event.type === "turn.completed");
        expect(completed).toHaveLength(1);
        expect(completed[0]?.payload).toMatchObject({ state: "failed" });
        const resumed = yield* Fiber.join(replacing);
        expect(yield* adapter.hasSession(threadId)).toBe(true);
        expect(resumed.resumeCursor).toEqual(session.resumeCursor);
        yield* adapter.sendTurn(turn("recovered after unacknowledged cancellation"));
        const methods = NodeFS.readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).method);
        expect(methods.filter((method) => method === "session/new")).toHaveLength(1);
        expect(methods.filter((method) => method === "session/load")).toHaveLength(1);
        yield* Fiber.interrupt(consumer);
      }),
    );
  });
  it.live(
    "retains the native completion reason when the CLI finishes as cancellation arrives",
    () => {
      return runTest((cwd, binaryPath, log) =>
        Effect.gen(function* () {
          const adapter = yield* makeMiniMaxAdapter(settings(binaryPath), {
            instanceId,
            resolveSessionEnvironment: () =>
              Effect.succeed({
                ...process.env,
                MINIMAX_TEST_LOG: log,
                MINIMAX_TEST_CANCEL_END_TURN: "1",
              }),
          });
          const waiting = yield* Deferred.make<void>();
          const completed = yield* Deferred.make<void>();
          const recorded: ProviderRuntimeEvent[] = [];
          const consumer = yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) => {
              recorded.push(event);
              if (event.type === "turn.completed")
                return Deferred.succeed(completed, undefined).pipe(Effect.asVoid);
              return event.type === "content.delta" && event.payload.delta === "waiting"
                ? Deferred.succeed(waiting, undefined).pipe(Effect.asVoid)
                : Effect.void;
            }),
            Effect.forkChild({ startImmediately: true }),
          );
          const session = yield* adapter.startSession(input(cwd));
          const running = yield* adapter
            .sendTurn(turn("wait-for-cancel"))
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(waiting);
          yield* adapter.interruptTurn(threadId);
          expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
          yield* Deferred.await(completed);
          expect(
            recorded.some(
              (event) =>
                event.type === "turn.completed" &&
                event.payload.state === "completed" &&
                event.payload.stopReason === "end_turn",
            ),
          ).toBe(true);
          expect(
            recorded.some(
              (event) => event.type === "turn.completed" && event.payload.state === "cancelled",
            ),
          ).toBe(false);
          yield* Fiber.join(running);
          expect((yield* adapter.listSessions())[0]?.resumeCursor).toEqual(session.resumeCursor);
          yield* adapter.sendTurn(turn("same session after the completed turn"));
          yield* Fiber.interrupt(consumer);
        }),
      );
    },
  );
  it.live(
    "rejects another instance's model and an unavailable model before sending a prompt",
    () => {
      return runTest((cwd, binaryPath, log) =>
        Effect.gen(function* () {
          const adapter = yield* makeMiniMaxAdapter(settings(binaryPath), {
            instanceId,
            resolveSessionEnvironment: () => environment(log),
          });
          const mismatched = yield* adapter
            .startSession({
              ...input(cwd),
              modelSelection: {
                ...modelSelection,
                instanceId: ProviderInstanceId.make("other-instance"),
              },
            })
            .pipe(Effect.flip);
          expect(mismatched.message).toContain("another harness instance");
          const missing = yield* adapter
            .startSession({
              ...input(cwd),
              modelSelection: { instanceId, model: "unavailable-model" },
            })
            .pipe(Effect.flip);
          expect(missing.message).toContain("does not advertise");
          expect(NodeFS.readFileSync(log, "utf8")).not.toContain('"method":"session/prompt"');
          expect(yield* adapter.hasSession(threadId)).toBe(false);
        }),
      );
    },
  );
  it.live("retains an idle session after a rejected replacement or turn selection", () => {
    return runTest((cwd, binaryPath, log) =>
      Effect.gen(function* () {
        const adapter = yield* makeMiniMaxAdapter(settings(binaryPath), {
          instanceId,
          resolveSessionEnvironment: () => environment(log),
        });
        const session = yield* adapter.startSession(input(cwd));
        const rejectedReplacement = yield* adapter
          .startSession({
            ...input(cwd),
            modelSelection: { instanceId, model: "unavailable-model" },
          })
          .pipe(Effect.flip);
        expect(rejectedReplacement.message).toContain("does not advertise");
        expect((yield* adapter.listSessions())[0]).toEqual(session);
        for (const selection of [
          { ...modelSelection, instanceId: ProviderInstanceId.make("foreign-instance") },
          { instanceId, model: "unavailable-model" },
          { ...modelSelection, options: [{ id: "thinkingEffort", value: "none" }] },
        ]) {
          yield* adapter
            .sendTurn({ ...turn("must not be sent"), modelSelection: selection })
            .pipe(Effect.flip);
          expect((yield* adapter.listSessions())[0]).toEqual(session);
        }
        expect(NodeFS.readFileSync(log, "utf8")).not.toContain('"method":"session/prompt"');
        yield* adapter.sendTurn(turn("original session remains usable"));
        expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
        expect((yield* adapter.listSessions())[0]?.resumeCursor).toEqual(session.resumeCursor);
      }),
    );
  });
  it.live("rejects disabled thinking before changing an advertised model or idle session", () => {
    return runTest((cwd, binaryPath, log) =>
      Effect.gen(function* () {
        const adapter = yield* makeMiniMaxAdapter(settings(binaryPath), {
          instanceId,
          resolveSessionEnvironment: () =>
            Effect.succeed({
              ...process.env,
              MINIMAX_TEST_LOG: log,
              MINIMAX_TEST_SECOND_MODEL: "1",
            }),
        });
        const session = yield* adapter.startSession(input(cwd));
        const initialWire = NodeFS.readFileSync(log, "utf8");
        for (const effort of ["none", "disabled"]) {
          const rejected = yield* adapter
            .sendTurn({
              ...turn("must not change the native model"),
              modelSelection: {
                instanceId,
                model: "MiniMax-M2.7",
                options: [{ id: "thinkingEffort", value: effort }],
              },
            })
            .pipe(Effect.flip);
          expect(rejected.message).toContain("does not advertise thinking effort");
          expect((yield* adapter.listSessions())[0]).toEqual(session);
          expect(NodeFS.readFileSync(log, "utf8")).toBe(initialWire);
        }
        yield* adapter.sendTurn(turn("original preview session remains usable"));
        expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
        expect((yield* adapter.listSessions())[0]?.model).toBe(MINIMAX_PREVIEW_MODEL);
        expect((yield* adapter.listSessions())[0]?.resumeCursor).toEqual(session.resumeCursor);
      }),
    );
  });
  it.live("retains a live session when a resume cursor belongs to another profile", () => {
    return runTest((cwd, binaryPath, log) =>
      Effect.gen(function* () {
        const adapter = yield* makeMiniMaxAdapter(settings(binaryPath), {
          instanceId,
          resolveSessionEnvironment: () => environment(log),
        });
        const session = yield* adapter.startSession(input(cwd));
        const failure = yield* adapter
          .startSession({
            ...input(cwd),
            resumeCursor: {
              protocol: "minimax-acp",
              sessionId: "minimax-fixture-session",
              profileKey: "foreign-profile",
            },
          })
          .pipe(Effect.flip);
        expect(failure.message).toContain("different profile");
        expect((yield* adapter.listSessions())[0]?.resumeCursor).toEqual(session.resumeCursor);
        yield* adapter.sendTurn(turn("original session still works"));
        const methods = NodeFS.readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).method);
        expect(methods.filter((method) => method === "session/new")).toHaveLength(1);
        expect(methods).not.toContain("session/load");
      }),
    );
  });
  it.live("requires the saved cursor and never creates a fresh session after a failed load", () => {
    return runTest((cwd, binaryPath, log) =>
      Effect.gen(function* () {
        let missing = false;
        const adapter = yield* makeMiniMaxAdapter(settings(binaryPath), {
          instanceId,
          resolveSessionEnvironment: () =>
            Effect.succeed({
              ...process.env,
              MINIMAX_TEST_LOG: log,
              ...(missing ? { MINIMAX_TEST_LOAD_MISSING: "1" } : {}),
            }),
        });
        const session = yield* adapter.startSession(input(cwd));
        const absentCursor = yield* adapter
          .startSession({ ...input(cwd), resumePolicy: "require-existing" })
          .pipe(Effect.flip);
        expect(absentCursor.message).toContain("saved MiniMax Code session cursor is required");
        expect((yield* adapter.listSessions())[0]).toEqual(session);
        const emptyCursor = yield* adapter
          .startSession({
            ...input(cwd),
            resumeCursor: { protocol: "minimax-acp", sessionId: "", profileKey: "foreign-profile" },
            resumePolicy: "require-existing",
          })
          .pipe(Effect.flip);
        expect(emptyCursor.message).toContain("cursor does not identify");
        expect((yield* adapter.listSessions())[0]).toEqual(session);
        yield* adapter.stopSession(threadId);
        missing = true;
        const missingSession = yield* adapter
          .startSession({
            ...input(cwd),
            resumeCursor: session.resumeCursor,
            resumePolicy: "require-existing",
          })
          .pipe(Effect.flip);
        expect(missingSession.message).toContain("not found");
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        missing = false;
        const resumed = yield* adapter.startSession({
          ...input(cwd),
          resumeCursor: session.resumeCursor,
          resumePolicy: "require-existing",
        });
        expect(resumed.resumeCursor).toEqual(session.resumeCursor);
        yield* adapter.sendTurn(turn("recovered original saved session"));
        const methods = NodeFS.readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).method);
        expect(methods.filter((method) => method === "session/new")).toHaveLength(1);
        expect(methods.filter((method) => method === "session/load")).toHaveLength(2);
      }),
    );
  });
  it.live(
    "reports a disconnected turn, rejects further prompts and loads the saved session",
    () => {
      return runTest((cwd, binaryPath, log) =>
        Effect.gen(function* () {
          const adapter = yield* makeMiniMaxAdapter(settings(binaryPath), {
            instanceId,
            resolveSessionEnvironment: () => environment(log),
          });
          const failed = yield* Deferred.make<void>();
          const consumer = yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              event.type === "turn.completed" && event.payload.state === "failed"
                ? Deferred.succeed(failed, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
            Effect.forkChild({ startImmediately: true }),
          );
          const session = yield* adapter.startSession(input(cwd));
          yield* adapter.sendTurn(turn("disconnect")).pipe(Effect.flip);
          yield* Deferred.await(failed);
          const disconnected = yield* adapter.sendTurn(turn("must reconnect")).pipe(Effect.flip);
          expect(disconnected.message).toContain("Resume the saved");
          const resumed = yield* adapter.startSession({
            ...input(cwd),
            resumeCursor: session.resumeCursor,
            resumePolicy: "require-existing",
          });
          expect(resumed.resumeCursor).toEqual(session.resumeCursor);
          yield* adapter.sendTurn(turn("reconnected"));
          yield* Fiber.interrupt(consumer);
        }),
      );
    },
  );
  it.live(
    "reuses its persisted health session after refresh and discovers only native models",
    () => {
      return runTest((cwd, binaryPath, log) =>
        Effect.gen(function* () {
          const cache = NodePath.join(cwd, "probe.json");
          const env = { ...process.env, MINIMAX_TEST_LOG: log };
          const first = yield* checkMiniMaxProviderStatus(settings(binaryPath), env, cache, cwd);
          const second = yield* checkMiniMaxProviderStatus(settings(binaryPath), env, cache, cwd);
          expect(first.status).toBe("ready");
          expect(second.auth.status).toBe("authenticated");
          expect(second.models.map((entry) => entry.slug)).toEqual([MINIMAX_PREVIEW_MODEL]);
          const methods = NodeFS.readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line).method);
          expect(methods.filter((method) => method === "session/new")).toHaveLength(1);
          expect(methods.filter((method) => method === "session/load")).toHaveLength(1);
          expect(methods.filter((method) => method === "session/close")).toHaveLength(2);
        }),
      );
    },
  );
  it.live("replaces only a missing dedicated health session and persists its replacement", () => {
    return runTest((cwd, binaryPath, log) =>
      Effect.gen(function* () {
        const cache = NodePath.join(cwd, "probe.json");
        const env = { ...process.env, MINIMAX_TEST_LOG: log };
        yield* checkMiniMaxProviderStatus(settings(binaryPath), env, cache, cwd);
        const saved = JSON.parse(NodeFS.readFileSync(cache, "utf8"));
        NodeFS.writeFileSync(
          cache,
          JSON.stringify({ ...saved, sessionId: "deleted-status-session" }),
        );
        const recovered = yield* checkMiniMaxProviderStatus(
          settings(binaryPath),
          { ...env, MINIMAX_TEST_LOAD_MISSING: "1" },
          cache,
          cwd,
        );
        expect(recovered.status).toBe("ready");
        const replacement = JSON.parse(NodeFS.readFileSync(cache, "utf8"));
        expect(replacement.sessionId).not.toBe("deleted-status-session");
        expect(replacement.profileKey).toBe(saved.profileKey);
        const refreshed = yield* checkMiniMaxProviderStatus(settings(binaryPath), env, cache, cwd);
        expect(refreshed.status).toBe("ready");
        const wire = NodeFS.readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(wire.filter((entry) => entry.method === "session/new")).toHaveLength(2);
        expect(
          wire
            .filter((entry) => entry.method === "session/load")
            .map((entry) => entry.params.sessionId),
        ).toEqual(["deleted-status-session", replacement.sessionId]);
      }),
    );
  });
  it.live("preserves the health cursor after authentication or other load failures", () => {
    return runTest((cwd, binaryPath, log) =>
      Effect.gen(function* () {
        const cache = NodePath.join(cwd, "probe.json");
        const env = { ...process.env, MINIMAX_TEST_LOG: log };
        yield* checkMiniMaxProviderStatus(settings(binaryPath), env, cache, cwd);
        const saved = NodeFS.readFileSync(cache, "utf8");
        const unauthenticated = yield* checkMiniMaxProviderStatus(
          settings(binaryPath),
          { ...env, MINIMAX_TEST_AUTH_REQUIRED: "1" },
          cache,
          cwd,
        );
        expect(unauthenticated.auth.status).toBe("unauthenticated");
        expect(NodeFS.readFileSync(cache, "utf8")).toBe(saved);
        const failed = yield* checkMiniMaxProviderStatus(
          settings(binaryPath),
          { ...env, MINIMAX_TEST_LOAD_MISSING: "1", MINIMAX_TEST_LOAD_ERROR_CODE: "-32603" },
          cache,
          cwd,
        );
        expect(failed.status).toBe("error");
        expect(failed.models).toEqual([]);
        expect(NodeFS.readFileSync(cache, "utf8")).toBe(saved);
        const methods = NodeFS.readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line).method);
        expect(methods.filter((method) => method === "session/new")).toHaveLength(1);
        expect(methods.filter((method) => method === "session/load")).toHaveLength(1);
      }),
    );
  });
  it.live(
    "keeps an unsupported gateway route unavailable without probing direct credentials",
    () => {
      return runTest((cwd, binaryPath, log) =>
        Effect.gen(function* () {
          const provider = yield* MiniMaxDriver.create({
            instanceId,
            displayName: undefined,
            environment: [{ name: "MINIMAX_TEST_LOG", value: log, sensitive: false }],
            enabled: true,
            routeViaGateway: true,
            config: settings(binaryPath),
          });
          const snapshot = yield* provider.snapshot.refresh;
          expect(snapshot.status).toBe("error");
          expect(snapshot.auth.status).toBe("unknown");
          expect(snapshot.models).toEqual([]);
          expect(snapshot.message).toContain("Disable the gateway option");
          const failure = yield* provider.adapter.startSession(input(cwd)).pipe(Effect.flip);
          expect(failure.message).toContain("gateway injection is not verified");
          expect(NodeFS.existsSync(log)).toBe(false);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              configLayerTest(cwd, NodePath.join(cwd, "server-state")),
              settingsLayerTest(),
              Layer.mock(BackgroundPolicy.BackgroundPolicy)({
                shouldRunScopeWork: () => Effect.succeed(false),
              }),
            ),
          ),
        ),
      );
    },
  );
  it.live("distinguishes missing login, unsupported release and unavailable model", () => {
    return runTest((cwd, binaryPath, log) =>
      Effect.gen(function* () {
        const env = { ...process.env, MINIMAX_TEST_LOG: log };
        const unauthenticated = yield* checkMiniMaxProviderStatus(
          settings(binaryPath),
          { ...env, MINIMAX_TEST_AUTH_REQUIRED: "1" },
          undefined,
          cwd,
        );
        expect(unauthenticated.auth.status).toBe("unauthenticated");
        expect(unauthenticated.models).toEqual([]);
        const stderrVersion = yield* checkMiniMaxProviderStatus(
          settings(binaryPath),
          { ...env, MINIMAX_TEST_VERSION_STDERR: "1" },
          undefined,
          cwd,
        );
        expect(stderrVersion.status).toBe("ready");
        expect(stderrVersion.version).toBe("0.6.2");
        const unsupported = yield* checkMiniMaxProviderStatus(
          settings(binaryPath),
          { ...env, MINIMAX_TEST_VERSION: "0.5.0" },
          undefined,
          cwd,
        );
        expect(unsupported.status).toBe("error");
        expect(unsupported.version).toBe("0.5.0");
        const incompatibleCache = NodePath.join(cwd, "incompatible-probe.json");
        const incompatible = yield* checkMiniMaxProviderStatus(
          settings(binaryPath),
          { ...env, MINIMAX_TEST_AGENT_VERSION: "0.5.0" },
          incompatibleCache,
          cwd,
        );
        expect(incompatible.status).toBe("error");
        expect(incompatible.models).toEqual([]);
        expect(NodeFS.existsSync(incompatibleCache)).toBe(false);
        const noModels = yield* checkMiniMaxProviderStatus(
          settings(binaryPath),
          { ...env, MINIMAX_TEST_NO_MODELS: "1" },
          undefined,
          cwd,
        );
        expect(noModels.auth.status).toBe("authenticated");
        expect(noModels.status).toBe("warning");
        expect(noModels.models).toEqual([]);
        expect(noModels.message).toContain("does not advertise");
      }),
    );
  });
});
