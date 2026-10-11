// @effect-diagnostics nodeBuiltinImport:off -- Real Linux process integration fixture.
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { execFileSync } from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { makeWorkerSourceModelSocket } from "../../workjet/WorkerSourceModelSocket.ts";
import type { WorkerNamespaceSpawnCapture } from "../../workjet/WorkerNamespaceSpawn.ts";

const helper = process.env.WORKJET_TEST_NAMESPACE_HELPER;
const agent = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../scripts/acp-namespace-mock.py",
);

const fixture = async () => {
  const root = await NodeFS.mkdtemp(
    NodePath.join(await NodeFS.realpath(process.env.TMPDIR ?? "/tmp"), "wj-acp-"),
  );
  const workspace = NodePath.join(root, "worker");
  const profile = NodePath.join(root, "profile");
  const runtime = NodePath.join(root, "runtime");
  let socket: Awaited<ReturnType<typeof makeWorkerSourceModelSocket>> | undefined;
  try {
    for (const path of [workspace, profile, runtime]) await NodeFS.mkdir(path, { mode: 0o700 });
    const home = NodePath.join(profile, "home");
    await NodeFS.mkdir(home, { mode: 0o700 });
    const script = NodePath.join(runtime, "agent.py");
    await NodeFS.copyFile(agent, script);
    execFileSync("/usr/bin/git", ["init", workspace], { timeout: 5000, stdio: "pipe" });
    const identity = async (path: string) => {
      const stat = await NodeFS.stat(path, { bigint: true });
      return { device: String(stat.dev), inode: String(stat.ino) };
    };
    socket = await makeWorkerSourceModelSocket(
      NodePath.join(root, "model-ipc"),
      (_request, response) => response.end(),
    );
    const tree = await identity(workspace);
    const git = await identity(NodePath.join(workspace, ".git"));
    const capture: WorkerNamespaceSpawnCapture = {
      helperPath: helper ?? "",
      worktree: {
        kind: "isolated",
        worktreePath: workspace,
        worktreeDev: tree.device,
        worktreeIno: tree.inode,
        adminPath: NodePath.join(workspace, ".git"),
        adminDev: git.device,
        adminIno: git.inode,
      },
      profile: { path: profile, identity: await identity(profile) },
      modelSocket: socket.description,
      runtimeFiles: [{ path: script, identity: await identity(script) }],
    };
    return {
      capture,
      workspace,
      home,
      script,
      close: async () => {
        await socket?.close();
        await NodeFS.rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await socket?.close();
    await NodeFS.rm(root, { recursive: true, force: true });
    throw error;
  }
};

describe("ACP Linux namespace execution", () => {
  // CI without the Linux helper does not assert the kernel boundary. The gpu3 qualification builds it.
  it.runIf(process.platform === "linux" && helper !== undefined).effect(
    "starts the captured process and rejects daemon file/terminal callbacks across two turns",
    () =>
      Effect.acquireUseRelease(
        Effect.tryPromise(fixture),
        (owned) =>
          Effect.gen(function* () {
            let callbacks = 0;
            return yield* Effect.gen(function* () {
              const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
              yield* runtime.handleReadTextFile(() =>
                Effect.sync(() => {
                  callbacks++;
                  return { content: "host-secret" };
                }),
              );
              yield* runtime.handleWriteTextFile(() =>
                Effect.sync(() => {
                  callbacks++;
                  return {};
                }),
              );
              yield* runtime.handleCreateTerminal(() =>
                Effect.sync(() => {
                  callbacks++;
                  return { terminalId: "host-terminal" };
                }),
              );
              expect((yield* runtime.start()).sessionId).toBe("namespace-session");
              for (const text of ["first", "follow-up"]) {
                expect(yield* runtime.prompt({ prompt: [{ type: "text", text }] })).toMatchObject({
                  stopReason: "end_turn",
                });
              }
              expect(callbacks).toBe(0);
              expect(
                yield* Effect.tryPromise(() =>
                  NodeFS.readFile(NodePath.join(owned.home, "acp-turns"), "utf8"),
                ),
              ).toBe("2");
            }).pipe(
              Effect.provide(
                AcpSessionRuntime.layer({
                  spawn: {
                    command: "/usr/bin/python3",
                    args: [owned.script],
                    cwd: owned.workspace,
                    env: {
                      WORKJET_SOURCE_ISOLATED: "true",
                      PATH: "/usr/bin:/bin",
                      HOME: owned.home,
                    },
                  },
                  namespaceCapture: owned.capture,
                  cwd: owned.workspace,
                  clientInfo: { name: "workjet-test", version: "0" },
                  authMethodId: "test",
                  clientCapabilities: {
                    fs: { readTextFile: true, writeTextFile: true },
                    terminal: true,
                  },
                }),
              ),
              Effect.scoped,
            );
          }),
        (owned) => Effect.promise(owned.close),
      ).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 15000 },
  );
});
