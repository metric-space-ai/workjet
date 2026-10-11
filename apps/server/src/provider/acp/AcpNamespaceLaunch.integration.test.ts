// @effect-diagnostics nodeBuiltinImport:off -- Real Linux process integration fixture.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessPlatform } from "@workjet/shared/hostProcess";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { makeWorkerSourceModelSocket } from "../../workjet/WorkerSourceModelSocket.ts";
import type { WorkerNamespaceSpawnCapture } from "../../workjet/WorkerNamespaceSpawn.ts";
import { makeWorkerSourcePrivateProfile } from "../../workjet/WorkerSourcePrivateProfile.ts";
import { workerSourceNativeProfile } from "../../workjet/WorkerSourceNativeProfile.ts";
import { WORKER_MODEL_NAMESPACE_BASE_URL } from "../../workjet/WorkerModelNamespaceBridge.ts";

const helper = process.env.WORKJET_TEST_NAMESPACE_HELPER;

const agent = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../scripts/acp-namespace-mock.py",
);

const fixture = async () => {
  const root = await NodeFSP.mkdtemp(
    NodePath.join(await NodeFSP.realpath(process.env.TMPDIR ?? "/tmp"), "wj-acp-"),
  );
  const workspace = NodePath.join(root, "worker");
  const profile = NodePath.join(root, "profile");
  const runtime = NodePath.join(root, "runtime");
  let socket: Awaited<ReturnType<typeof makeWorkerSourceModelSocket>> | undefined;
  let prepared: Awaited<ReturnType<typeof makeWorkerSourcePrivateProfile>> | undefined;
  try {
    for (const path of [workspace, runtime]) await NodeFSP.mkdir(path, { mode: 0o700 });
    const script = NodePath.join(runtime, "agent.py");
    await NodeFSP.copyFile(agent, script);
    NodeChildProcess.execFileSync("/usr/bin/git", ["init", workspace], {
      timeout: 5000,
      stdio: "pipe",
    });
    const identity = async (path: string) => {
      const stat = await NodeFSP.stat(path, { bigint: true });
      return { device: String(stat.dev), inode: String(stat.ino) };
    };
    socket = await makeWorkerSourceModelSocket(
      NodePath.join(root, "model-ipc"),
      (_request, response) => response.end(),
    );
    prepared = await makeWorkerSourcePrivateProfile(profile, (directory) =>
      workerSourceNativeProfile({
        harness: "minimax-code",
        model: "gpt-6.1-sol",
        directory,
        baseUrl: WORKER_MODEL_NAMESPACE_BASE_URL,
        apiKey: "acp-profile-fixture",
      }),
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
      profile: prepared.capture,
      modelSocket: socket.description,
      runtimeFiles: [{ path: script, identity: await identity(script) }],
    };
    return {
      capture,
      workspace,
      home: prepared.profile.environment.HOME!,
      environment: prepared.profile.environment,
      verify: prepared.verify,
      script,
      close: async () => {
        await socket?.close();
        await prepared?.close();
        await NodeFSP.rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await socket?.close();
    await prepared?.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
    throw error;
  }
};

describe.runIf(helper !== undefined)("ACP Linux namespace execution", () => {
  // CI without the Linux helper does not assert the kernel boundary. The gpu3 qualification builds it.
  it.effect(
    "reads, edits, builds and commits through confined tools across two turns without daemon callbacks",
    () =>
      Effect.gen(function* () {
        expect(yield* HostProcessPlatform).toBe("linux");
        return yield* Effect.acquireUseRelease(
          Effect.tryPromise(fixture),
          (owned) =>
            Effect.gen(function* () {
              let callbacks = 0;
              const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
              const children: ChildProcessSpawner.ChildProcessHandle[] = [];
              yield* Effect.tryPromise(owned.verify);
              yield* Effect.gen(function* () {
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
                  expect(yield* runtime.prompt({ prompt: [{ type: "text", text }] })).toMatchObject(
                    {
                      stopReason: "end_turn",
                    },
                  );
                }
                expect(callbacks).toBe(0);
                const commits = yield* Effect.tryPromise(() =>
                  Promise.resolve(
                    NodeChildProcess.execFileSync(
                      "/usr/bin/git",
                      ["-C", owned.workspace, "rev-list", "--count", "HEAD"],
                      { timeout: 5000, encoding: "utf8" },
                    ).trim(),
                  ),
                );
                expect(commits).toBe("2");
                expect(
                  yield* Effect.tryPromise(() =>
                    NodeFSP.readFile(NodePath.join(owned.home, "acp-turns"), "utf8"),
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
                        ...owned.environment,
                        PATH: "/usr/bin:/bin",
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
                Effect.provideService(
                  ChildProcessSpawner.ChildProcessSpawner,
                  ChildProcessSpawner.make((command) =>
                    spawner.spawn(command).pipe(
                      Effect.tap((child) =>
                        Effect.sync(() => {
                          children.push(child);
                        }),
                      ),
                    ),
                  ),
                ),
                Effect.onError(() =>
                  Effect.tryPromise(() =>
                    NodeFSP.readFile(NodePath.join(owned.home, "acp-tool-replies"), "utf8"),
                  ).pipe(
                    Effect.tap((replies) => Effect.logError(replies)),
                    Effect.ignore,
                  ),
                ),
              );
              expect(children.length).toBeGreaterThan(1);
              for (const child of children) {
                expect(yield* child.isRunning).toBe(false);
              }
            }),
          (owned) => Effect.promise(owned.close),
        );
      }).pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provide(NodeServices.layer),
      ),
    { timeout: 45000 },
  );
});
