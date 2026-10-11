// @effect-diagnostics nodeBuiltinImport:off -- Real Linux process integration fixture.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
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
  for (const variant of ["expired-idle", "expired-turn", "timeout-turn", "healthy"] as const) {
    it.effect(
      `supervises the actual confined CLI lifetime: ${variant}`,
      () =>
        Effect.acquireUseRelease(
          Effect.tryPromise(fixture),
          (owned) =>
            Effect.gen(function* () {
              let checks = 0;
              let sourceAvailable = true;
              let watchArmed = false;
              let checkObserved!: () => void;
              const checking = new Promise<void>((resolve) => {
                checkObserved = resolve;
              });
              let abortObserved!: () => void;
              const aborted = new Promise<void>((resolve) => {
                abortObserved = resolve;
              });
              const children: ChildProcessSpawner.ChildProcessHandle[] = [];
              const original = yield* ChildProcessSpawner.ChildProcessSpawner;
              yield* Effect.gen(function* () {
                const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
                const promptEntered = yield* Deferred.make<void>();
                yield* runtime.handleSessionUpdate(() =>
                  Deferred.succeed(promptEntered, undefined).pipe(Effect.asVoid),
                );
                yield* runtime.start();
                const main = children[0]!;
                expect(yield* main.isRunning).toBe(true);
                const pending = variant.endsWith("turn")
                  ? yield* runtime
                      .prompt({ prompt: [{ type: "text", text: "hold-turn" }] })
                      .pipe(Effect.forkIn(yield* Scope.Scope))
                  : undefined;
                if (pending) {
                  yield* Deferred.await(promptEntered);
                  expect(yield* children.at(-1)!.isRunning).toBe(true);
                } else {
                  yield* runtime.prompt({ prompt: [{ type: "text", text: "first" }] });
                }
                // The next check has no concurrent tool action; it belongs to the CLI guard.
                const before = checks;
                watchArmed = true;
                if (variant !== "healthy") sourceAvailable = false;
                yield* TestClock.adjust("10 seconds");
                yield* Effect.promise(() => checking);
                if (variant === "timeout-turn") {
                  yield* TestClock.adjust("10 seconds");
                  yield* Effect.promise(() => aborted);
                }
                if (variant === "healthy") {
                  expect(checks).toBe(before + 1);
                  expect(yield* main.isRunning).toBe(true);
                  yield* runtime.prompt({ prompt: [{ type: "text", text: "follow-up" }] });
                  expect(
                    NodeChildProcess.execFileSync(
                      "/usr/bin/git",
                      ["-C", owned.workspace, "rev-list", "--count", "HEAD"],
                      { timeout: 5000, encoding: "utf8" },
                    ).trim(),
                  ).toBe("2");
                } else {
                  yield* main.exitCode.pipe(Effect.result);
                  for (const child of children) expect(yield* child.isRunning).toBe(false);
                  if (pending)
                    expect((yield* Fiber.join(pending).pipe(Effect.result))._tag).toBe("Failure");
                  expect(
                    (yield* runtime
                      .prompt({ prompt: [{ type: "text", text: "after-expiry" }] })
                      .pipe(Effect.result))._tag,
                  ).toBe("Failure");
                  expect(checks).toBe(before + 1);
                }
              }).pipe(
                Effect.provide(
                  AcpSessionRuntime.layer({
                    spawn: {
                      command: "/usr/bin/python3",
                      args: [owned.script],
                      cwd: owned.workspace,
                      env: { ...owned.environment, PATH: "/usr/bin:/bin" },
                    },
                    namespaceCapture: owned.capture,
                    namespaceAdmission: async (signal) => {
                      await owned.verify();
                      checks++;
                      if (watchArmed) checkObserved();
                      if (sourceAvailable) return;
                      if (variant !== "timeout-turn") throw new Error("Source expired");
                      await new Promise<void>((_resolve, reject) => {
                        const abort = () => {
                          abortObserved();
                          reject(new Error("Source admission aborted"));
                        };
                        if (signal.aborted) abort();
                        else signal.addEventListener("abort", abort, { once: true });
                      });
                    },
                    cwd: owned.workspace,
                    clientInfo: { name: "workjet-test", version: "0" },
                    authMethodId: "test",
                  }),
                ),
                Effect.scoped,
                Effect.provideService(
                  ChildProcessSpawner.ChildProcessSpawner,
                  ChildProcessSpawner.make((command) =>
                    original.spawn(command).pipe(
                      Effect.tap((child) =>
                        Effect.sync(() => {
                          children.push(child);
                        }),
                      ),
                    ),
                  ),
                ),
              );
              for (const child of children) expect(yield* child.isRunning).toBe(false);
            }),
          (owned) => Effect.promise(owned.close),
        ).pipe(Effect.provide(NodeServices.layer)),
      { timeout: 45000 },
    );
  }

  it.effect(
    "rejects a namespace without its original admission callback before spawning",
    () =>
      Effect.acquireUseRelease(
        Effect.tryPromise(fixture),
        (owned) =>
          Effect.gen(function* () {
            let spawned = 0;
            const original = yield* ChildProcessSpawner.ChildProcessSpawner;
            const result = yield* AcpSessionRuntime.AcpSessionRuntime.pipe(
              Effect.flatMap((runtime) => runtime.start()),
              Effect.provide(
                AcpSessionRuntime.layer({
                  spawn: {
                    command: "/usr/bin/python3",
                    args: [owned.script],
                    cwd: owned.workspace,
                    env: owned.environment,
                  },
                  namespaceCapture: owned.capture,
                  cwd: owned.workspace,
                  clientInfo: { name: "workjet-test", version: "0" },
                  authMethodId: "test",
                }),
              ),
              Effect.scoped,
              Effect.provideService(
                ChildProcessSpawner.ChildProcessSpawner,
                ChildProcessSpawner.make((command) =>
                  Effect.sync(() => {
                    spawned++;
                  }).pipe(Effect.andThen(original.spawn(command))),
                ),
              ),
              Effect.result,
            );
            expect(result._tag).toBe("Failure");
            expect(spawned).toBe(0);
          }),
        (owned) => Effect.promise(owned.close),
      ).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 45000 },
  );
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
                    namespaceAdmission: owned.verify,
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
