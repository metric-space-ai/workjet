// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { DEFAULT_WORKJET_THREAD_CONFIG, EnvironmentId, ProviderInstanceId, ThreadId } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";
import { clearMcpProviderSession, setMcpProviderSession } from "../../mcp/McpProviderSession.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const instanceId = ProviderInstanceId.make("pi_gateway");
const threadId = ThreadId.make("pi-native-transport");
const modelSelection = { instanceId, model: "claude-opus-5-5" };
const executable = fileURLToPath(new URL("../testFixtures/piRpcCli.mjs", import.meta.url));

async function runTest<A, E>(
  test: (
    directory: string,
  ) => Effect.Effect<A, E, Effect.Services<ReturnType<typeof makePiAdapter>>>,
) {
  const directory = await fs.mkdtemp(
    path.join(process.env.TMPDIR || os.tmpdir(), "workjet-pi-rpc-"),
  );
  try {
    return await Effect.runPromise(
      test(directory).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  } finally {
    clearMcpProviderSession(threadId);
    await fs.rm(directory, { recursive: true, force: true });
  }
}
const adapterInput = (directory: string) => ({
  instanceId,
  binaryPath: executable,
  enabled: true,
  sessionDirectory: directory,
  resolveModel: (model: string) =>
    Effect.succeed({ provider: "workjet-claude", model, environment: process.env }),
});

describe("Pi native RPC adapter", () => {
  it("rejects a foreign restart before resolving any local account or spawning Pi", async () => {
    await runTest((directory) => Effect.gen(function* () {
      let resolved = false;
      const adapter = yield* makePiAdapter({
        ...adapterInput(directory),
        resolveModel: (model: string) => {
          resolved = true;
          return Effect.succeed({ provider: "workjet-claude", model, environment: process.env });
        },
      });
      const failure = yield* Effect.flip(adapter.startSession({
        threadId: ThreadId.make("foreign-pi-missing-route"), cwd: directory,
        runtimeMode: "full-access", modelSelection,
        workjetConfig: { ...DEFAULT_WORKJET_THREAD_CONFIG, role: "worker",
          parent: { environmentId: EnvironmentId.make("foreign-source"), threadId } },
      }));
      expect(failure.message).toContain("Foreign worker source route");
      expect(resolved).toBe(false);
    }));
  });
  it.each(["Supervisor", "Persistent Worker", "One-Shot Worker"])(
    "passes the compiled %s rules through the system channel on launch and resume",
    async (role) => {
      await runTest((directory) =>
        Effect.gen(function* () {
          const compiled = `Managed ${role} rules.\nKeep this role on every turn.`;
          const registerPrompt = (prompt: string) =>
            setMcpProviderSession({
              environmentId: EnvironmentId.make("pi-system-prompt-test"),
              threadId,
              providerSessionId: "pi-managed-session",
              providerInstanceId: instanceId,
              endpoint: "http://127.0.0.1/mcp",
              authorizationHeader: "Bearer test-token",
              activeWorkjetMcpCapabilityIds: [],
              compiledManagedPrompt: prompt,
            });
          registerPrompt(`  ${compiled}  `);
          const adapter = yield* makePiAdapter(adapterInput(directory));
          const config = {
            schemaVersion: 2 as const,
            role: "standard" as const,
            parent: null,
            managedInstructions: "Uncompiled fallback must not replace the compiled role.",
            enabledCapabilityIds: [],
            capabilityBindings: [],
            ctoxSession: null,
          };
          const first = yield* adapter.startSession({
            threadId,
            cwd: directory,
            runtimeMode: "full-access",
            modelSelection,
            workjetConfig: config,
          });
          const startupFile = path.join(directory, "fixture-startup.json");
          const startup = JSON.parse(yield* Effect.promise(() => fs.readFile(startupFile, "utf8")));
          expect(startup.appendSystemPrompt).toBe(
            `<workjet_managed_instructions>\n${compiled}\n</workjet_managed_instructions>`,
          );
          expect(startup.replacesSystemPrompt).toBe(false);
          const sendAndFinish = (message: string) =>
            Effect.gen(function* () {
              const completed = yield* adapter.streamEvents.pipe(
                Stream.filter((event) => event.type === "turn.completed"),
                Stream.take(1),
                Stream.runCollect,
                Effect.forkChild({ startImmediately: true }),
              );
              const receipt = yield* adapter.sendTurn({ threadId, input: message, modelSelection });
              expect(yield* Fiber.join(completed)).toHaveLength(1);
              return receipt;
            });
          yield* sendAndFinish("FIRST");
          const second = yield* sendAndFinish("SECOND");
          expect((yield* adapter.readThread(threadId)).turns.flatMap((turn) => turn.items)).toEqual([
            { role: "user", content: "FIRST" },
            { role: "user", content: "SECOND" },
          ]);
          expect((yield* adapter.stopSession(threadId))?.terminated).toBe(true);
          registerPrompt(`${compiled}\nUpdated instructions for the resumed session.`);
          yield* adapter.startSession({
            threadId,
            cwd: directory,
            runtimeMode: "full-access",
            modelSelection,
            workjetConfig: config,
            resumeCursor: second.resumeCursor ?? first.resumeCursor,
            resumePolicy: "require-existing",
          });
          const resumedStartup = JSON.parse(
            yield* Effect.promise(() => fs.readFile(startupFile, "utf8")),
          );
          expect(resumedStartup.appendSystemPrompt).toContain(
            "Updated instructions for the resumed session.",
          );
          expect(resumedStartup.replacesSystemPrompt).toBe(false);
          yield* sendAndFinish("THIRD");
          expect((yield* adapter.readThread(threadId)).turns.flatMap((turn) => turn.items)).toEqual([
            { role: "user", content: "FIRST" },
            { role: "user", content: "SECOND" },
            { role: "user", content: "THIRD" },
          ]);
        }),
      );
    },
  );

  it.each(["   ", "  Custom managed instructions  "])(
    "uses the direct config fallback and omits an empty native system append (%j)",
    async (managedInstructions) => {
      await runTest((directory) =>
        Effect.gen(function* () {
          const adapter = yield* makePiAdapter(adapterInput(directory));
          yield* adapter.startSession({
            threadId,
            cwd: directory,
            runtimeMode: "full-access",
            modelSelection,
            workjetConfig: {
              schemaVersion: 2,
              role: "standard",
              parent: null,
              managedInstructions,
              enabledCapabilityIds: [],
              capabilityBindings: [],
              ctoxSession: null,
            },
          });
          const startup = JSON.parse(
            yield* Effect.promise(() =>
              fs.readFile(path.join(directory, "fixture-startup.json"), "utf8"),
            ),
          );
          expect(startup.appendSystemPrompt).toBe(
            managedInstructions.trim()
              ? `<workjet_managed_instructions>\n${managedInstructions.trim()}\n</workjet_managed_instructions>`
              : null,
          );
          expect(startup.replacesSystemPrompt).toBe(false);
        }),
      );
    },
  );

  it("projects twenty consecutive tool results and resumes the same durable native conversation", async () => {
    await runTest((directory) =>
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(adapterInput(directory));
        const completed = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "item.completed"),
          Stream.take(20),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
        const first = yield* adapter.startSession({
          threadId,
          cwd: directory,
          runtimeMode: "full-access",
          modelSelection,
        });
        const turn = yield* adapter.sendTurn({ threadId, input: "FIRST", modelSelection });
        const results = yield* Fiber.join(completed);
        expect(results).toHaveLength(20);
        expect(
          results.every(
            (event) => event.type === "item.completed" && event.payload.status === "completed",
          ),
        ).toBe(true);
        const stopped = yield* adapter.stopSession(threadId);
        expect(stopped?.terminated).toBe(true);
        const resumed = yield* adapter.startSession({
          threadId,
          cwd: directory,
          runtimeMode: "full-access",
          modelSelection,
          resumeCursor: turn.resumeCursor ?? first.resumeCursor,
          resumePolicy: "require-existing",
        });
        expect(resumed.resumeCursor).toEqual(turn.resumeCursor);
        const history = yield* adapter.readThread(threadId);
        expect(history.turns.flatMap((turn) => turn.items)).toContainEqual({
          role: "user",
          content: "FIRST",
        });
      }),
    );
  });
  it("cancels an active native turn through RPC and waits for its completion event", async () => {
    await runTest((directory) =>
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(adapterInput(directory));
        const completed = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
        const started = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "item.started"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* adapter.startSession({
          threadId,
          cwd: directory,
          runtimeMode: "full-access",
          modelSelection,
        });
        const turn = yield* adapter
          .sendTurn({ threadId, input: "WAIT_FOR_ABORT", modelSelection })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.join(started);
        yield* adapter.interruptTurn(threadId, undefined);
        yield* Fiber.join(turn);
        expect(yield* Fiber.join(completed)).toHaveLength(1);
        expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
      }),
    );
  });
  it("returns a dispatch receipt while the native turn waits and rejects overlap", async () => {
    await runTest((directory) =>
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter(adapterInput(directory));
        const completed = yield* adapter.streamEvents.pipe(
          Stream.filter((event) => event.type === "turn.completed"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* adapter.startSession({
          threadId,
          cwd: directory,
          runtimeMode: "full-access",
          modelSelection,
        });
        const receipt = yield* adapter.sendTurn({
          threadId,
          input: "WAIT_FOR_ABORT",
          modelSelection,
        });
        expect(receipt.turnId).toBeDefined();
        expect((yield* adapter.listSessions())[0]?.status).toBe("running");
        const overlap = yield* adapter
          .sendTurn({
            threadId,
            input: "SECOND",
            modelSelection,
          })
          .pipe(Effect.flip);
        expect(overlap.message).toContain("active turn");
        yield* adapter.interruptTurn(threadId, receipt.turnId);
        expect(yield* Fiber.join(completed)).toHaveLength(1);
        expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
      }),
    );
  });
  it("refuses approval modes and foreign resume paths before spawning a native session", async () => {
    await runTest((directory) =>
      Effect.gen(function* () {
        const adapter = yield* makePiAdapter({
          ...adapterInput(directory),
          binaryPath: "missing-pi-fixture",
        });
        const approval = yield* adapter
          .startSession({
            threadId,
            cwd: directory,
            runtimeMode: "approval-required",
            modelSelection,
          })
          .pipe(Effect.flip);
        expect(approval.message).toContain("full-access");
        const foreign = yield* adapter
          .startSession({
            threadId,
            cwd: directory,
            runtimeMode: "full-access",
            modelSelection,
            resumeCursor: {
              protocol: "pi-rpc",
              sessionFile: path.join(directory, "..", "foreign.jsonl"),
            },
          })
          .pipe(Effect.flip);
        expect(foreign.message).toContain("private directory");
        expect(yield* adapter.listSessions()).toEqual([]);
      }),
    );
  });
});
