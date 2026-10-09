// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeServices } from "@effect/platform-node";
import { ProviderInstanceId, ThreadId } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";
import { makePiAdapter } from "./PiAdapter.ts";

const instanceId = ProviderInstanceId.make("pi_gateway");
const threadId = ThreadId.make("pi-native-transport");
const modelSelection = { instanceId, model: "claude-opus-5-5" };
const executable = fileURLToPath(new URL("../testFixtures/piRpcCli.mjs", import.meta.url));

async function runTest<A>(test: (directory: string) => Effect.Effect<A, unknown, Effect.Services<ReturnType<typeof makePiAdapter>>>) {
  const directory = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), "workjet-pi-rpc-"));
  try { return await Effect.runPromise(test(directory).pipe(Effect.scoped, Effect.provide(NodeServices.layer))); }
  finally { await fs.rm(directory, {recursive:true,force:true}); }
}
const adapterInput = (directory: string) => ({ instanceId, binaryPath: executable, enabled: true, sessionDirectory: directory,
  resolveModel: (model: string) => Effect.succeed({provider:"workjet-claude",model,environment:process.env}),
});

describe("Pi native RPC adapter", () => {
  it("projects twenty consecutive tool results and resumes the same durable native conversation", async () => {
    await runTest(directory => Effect.gen(function* () {
      const adapter = yield* makePiAdapter(adapterInput(directory));
      const completed = yield* adapter.streamEvents.pipe(Stream.filter(event => event.type === "item.completed"), Stream.take(20), Stream.runCollect, Effect.forkChild({startImmediately:true}));
      const first = yield* adapter.startSession({threadId, cwd:directory, runtimeMode:"full-access", modelSelection});
      const turn = yield* adapter.sendTurn({threadId, input:"FIRST", modelSelection});
      const results = yield* Fiber.join(completed);
      expect(results).toHaveLength(20);
      expect(results.every(event => event.type === "item.completed" && event.payload.status === "completed")).toBe(true);
      const stopped = yield* adapter.stopSession(threadId);
      expect(stopped?.terminated).toBe(true);
      const resumed = yield* adapter.startSession({threadId,cwd:directory,runtimeMode:"full-access",modelSelection,resumeCursor:turn.resumeCursor ?? first.resumeCursor,resumePolicy:"require-existing"});
      expect(resumed.resumeCursor).toEqual(turn.resumeCursor);
      const history = yield* adapter.readThread(threadId);
      expect(history.turns.flatMap(turn => turn.items)).toContainEqual({role:"user",content:"FIRST"});
    }));
  });
  it("cancels an active native turn through RPC and waits for its completion event", async () => {
    await runTest(directory => Effect.gen(function* () {
      const adapter = yield* makePiAdapter(adapterInput(directory));
      const started = yield* adapter.streamEvents.pipe(Stream.filter(event => event.type === "item.started"), Stream.take(1), Stream.runCollect, Effect.forkChild({startImmediately:true}));
      yield* adapter.startSession({threadId,cwd:directory,runtimeMode:"full-access",modelSelection});
      const turn = yield* adapter.sendTurn({threadId,input:"WAIT_FOR_ABORT",modelSelection}).pipe(Effect.forkChild({startImmediately:true}));
      yield* Fiber.join(started);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(turn);
      expect((yield* adapter.listSessions())[0]?.status).toBe("ready");
    }));
  });
  it("refuses approval modes and foreign resume paths before spawning a native session", async () => {
    await runTest(directory => Effect.gen(function* () {
      const adapter = yield* makePiAdapter({...adapterInput(directory),binaryPath:"missing-pi-fixture"});
      const approval = yield* adapter.startSession({threadId,cwd:directory,runtimeMode:"approval-required",modelSelection}).pipe(Effect.flip);
      expect(approval.message).toContain("full-access");
      const foreign = yield* adapter.startSession({threadId,cwd:directory,runtimeMode:"full-access",modelSelection,resumeCursor:{protocol:"pi-rpc",sessionFile:path.join(directory,"..","foreign.jsonl")}}).pipe(Effect.flip);
      expect(foreign.message).toContain("private directory");
      expect(yield* adapter.listSessions()).toEqual([]);
    }));
  });
});
