// @effect-diagnostics nodeBuiltinImport:off -- Actual Greppy adapter/factory and Linux namespace, with protocol fixtures and no real model.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import {
  WorkerSourceCustodyStore,
  makeWorkerSourceCustodyPersistence,
  layer as WorkerSourceCustodyLayer,
  type WorkerSourceProfileCustody,
  type WorkerSourceRuntimeCustody,
} from "../../workjet/WorkerSourceCustodyStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import {
  DEFAULT_SERVER_SETTINGS,
  WorkjetThreadConfig,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ProviderSessionStartInput,
} from "@workjet/contracts";
import { makeGreppyAdapter } from "../Layers/GreppyAdapter.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ResourceMonitorBinary } from "../../resourceTelemetry/ResourceMonitorBinary.ts";
import {
  IsolatedWorkerWorktreeStore,
  type IsolatedWorkerWorktreeReceipt,
} from "../../workjet/IsolatedWorkerWorktreeStore.ts";
import { installWorkerSourceRoute } from "../../workjet/WorkerSourceHarness.ts";

const helper = process.env.WORKJET_TEST_NAMESPACE_HELPER;
const agent = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../scripts/acp-namespace-mock.py",
);
const fixture = async (
  variant: string,
  root: string,
  persistence: {
    readonly profile: {
      readonly original: WorkerSourceProfileCustody | null;
      readonly capture: (capture: WorkerSourceProfileCustody) => Promise<void>;
    };
    readonly captureRuntime: (capture: WorkerSourceRuntimeCustody) => Promise<void>;
  },
) => {
  const threadId = ThreadId.make(NodePath.basename(root));
  const stage = NodePath.join(root, ".workjet-prepared-" + threadId + "-original");
  const workspace = NodePath.join(root, "worker");
  const runtime = NodePath.join(root, "runtime");
  const script = NodePath.join(runtime, "greppy");
  let route: Awaited<ReturnType<typeof installWorkerSourceRoute>> | undefined;
  let sourceAvailable = true;
  let admissions = 0;
  const source = NodeHttp.createServer((_request, response) => {
    admissions++;
    response
      .writeHead(sourceAvailable ? 200 : 403, { "content-type": "application/json" })
      .end("{}");
  });
  try {
    await NodeFSP.mkdir(stage, { mode: 0o700 });
    await NodeFSP.mkdir(runtime, { mode: 0o700 });
    const fixtureCode = await NodeFSP.readFile(agent, "utf8");
    const nodeBundle =
      "#!/usr/bin/env node\n" +
      "const { spawn } = require('node:child_process');\n" +
      "const child = spawn('/usr/bin/python3', ['-c', " +
      JSON.stringify(fixtureCode) +
      ", ...process.argv.slice(2)], { stdio: 'inherit' });\n" +
      "child.on('error', () => { process.exitCode = 1; });\n" +
      "child.on('exit', (code) => { process.exitCode = code ?? 1; });\n";
    await NodeFSP.writeFile(
      script,
      variant?.startsWith("node-runtime-")
        ? nodeBundle
        : fixtureCode.replace("#!/usr/bin/env python3", "#!/usr/bin/python3"),
      { mode: 0o700 },
    );
    NodeChildProcess.execFileSync("/usr/bin/git", ["init", stage], {
      timeout: 5000,
      stdio: "pipe",
    });
    const tree = await NodeFSP.stat(stage, { bigint: true });
    const git = await NodeFSP.stat(NodePath.join(stage, ".git"), { bigint: true });
    const receipt: IsolatedWorkerWorktreeReceipt = {
      intent: {
        workerId: threadId,
        projectId: "fixture-project",
        repositoryKey: "https://example.invalid/project",
        repositoryUrl: "https://example.invalid/project.git",
        sourceCwd: NodePath.join(root, "source"),
        revision: "a".repeat(40),
        branch: "workjet/worker/" + threadId,
        destination: workspace,
        authorityDigest: "d".repeat(64),
      },
      custody: {
        kind: "isolated",
        worktreePath: stage,
        worktreeDev: String(tree.dev),
        worktreeIno: String(tree.ino),
        adminPath: NodePath.join(stage, ".git"),
        adminDev: String(git.dev),
        adminIno: String(git.ino),
      },
    };
    await NodeFSP.rename(stage, workspace);
    await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
    const address = source.address();
    if (!address || typeof address === "string") throw new Error("fixture source unavailable");

    route = await installWorkerSourceRoute(
      threadId,
      {
        sourceEnvironmentId: "source",
        targetEnvironmentId: "target",
        requestId: threadId,
        requestDigest: receipt.intent.authorityDigest,
        capability: "fixture-source-capability",
        port: address.port,
      },
      {
        targetEnvironmentId: "target",
        requestDigest: receipt.intent.authorityDigest,
        modelId: "gpt-6.1-sol",
        harness: "greppy",
        modelSocketRoot: NodePath.join(root, "model-ipc"),
        captureRuntime: async (capture) => {
          if (variant === "runtime-denied") throw new Error("Original runtime custody rejected");
          await persistence.captureRuntime(capture);
        },
        nativeProfile: {
          harness: "greppy",
          directory: NodePath.join(root, "profile"),
          persistence: persistence.profile,
        },
      },
    );
    const input: ProviderSessionStartInput = {
      threadId,
      cwd: workspace,
      runtimeMode: "approval-required",
      modelSelection: { instanceId: ProviderInstanceId.make("greppy"), model: "gpt-6.1-sol" },
      workjetConfig: Schema.decodeUnknownSync(WorkjetThreadConfig)({
        schemaVersion: 2,
        managedInstructions: "",
        enabledCapabilityIds: [],
        capabilityBindings: [],
        role: "worker",
        parent: { environmentId: EnvironmentId.make("source"), threadId: ThreadId.make("parent") },
        executionPolicy: {
          mode: "autonomous-worktree",
          projectId: ProjectId.make("fixture-project"),
          revision: 1,
        },
      }),
    };
    return {
      root,
      workspace,
      script,
      input,
      receipt,
      admissions: () => admissions,
      denySource: () => {
        sourceAvailable = false;
      },
      revokeSource: route.revoke,
      home: route.nativeProfile!.environment.HOME!,
      close: async () => {
        await route?.revoke();
        source.closeAllConnections();
        await new Promise<void>((resolve) => source.close(() => resolve()));
      },
    };
  } catch (cause) {
    await route?.revoke();
    source.closeAllConnections();
    if (source.listening) await new Promise<void>((resolve) => source.close(() => resolve()));
    throw cause;
  }
};
describe.runIf(helper !== undefined)("Greppy original runtime/custody production path", () => {
  for (const variant of [
    "two-turns",
    "node-runtime-two-turns",
    "node-runtime-replaced",
    "runtime-denied",
    "runtime-replaced",
    "missing-receipt",
    "changed-digest",
    "replaced-root",
    "expired-source-tools",
    "revoked-source-tools",
    "expired-source-cleanup",
    "expired-source-running",
  ] as const) {
    it.effect(
      variant,
      () =>
        Effect.gen(function* () {
          const store = yield* WorkerSourceCustodyStore;
          const fs = yield* FileSystem.FileSystem;
          const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "wj-greppy-ns-" });
          const root = yield* Effect.tryPromise(() => NodeFSP.realpath(temporary));
          const receipt = yield* store.reserve({
            workerId: ThreadId.make(NodePath.basename(root)),
            sourceEnvironmentId: "source",
            targetEnvironmentId: "target",
            requestDigest: "d".repeat(64),
            harness: "greppy",
            model: "gpt-6.1-sol",
            profileRoot: NodePath.join(root, "profile"),
          });
          const persistence = yield* makeWorkerSourceCustodyPersistence(store, receipt);
          return yield* Effect.acquireUseRelease(
            Effect.tryPromise(() => fixture(variant, root, persistence)),
            (owned) =>
              Effect.gen(function* () {
                const twoTurns = variant === "two-turns" || variant === "node-runtime-two-turns";
                const originalSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
                const children: ChildProcessSpawner.ChildProcessHandle[] = [];
                const spawner = ChildProcessSpawner.make((command) =>
                  originalSpawner.spawn(command).pipe(
                    Effect.tap((child) =>
                      Effect.sync(() => {
                        children.push(child);
                      }),
                    ),
                  ),
                );
                if (variant === "replaced-root") {
                  yield* Effect.tryPromise(async () => {
                    await NodeFSP.rename(owned.workspace, owned.workspace + "-held");
                    await NodeFSP.mkdir(owned.workspace, { mode: 0o700 });
                    NodeChildProcess.execFileSync("/usr/bin/git", ["init", owned.workspace], {
                      timeout: 5000,
                      stdio: "pipe",
                    });
                  });
                }
                yield* Effect.gen(function* () {
                  const adapter = yield* makeGreppyAdapter(
                    {
                      ...DEFAULT_SERVER_SETTINGS.providers.greppy,
                      enabled: true,
                      binaryPath: owned.script,
                      model: "gpt-6.1-sol",
                      endpoint: "http://127.0.0.1:23197",
                    },
                    {
                      instanceId: ProviderInstanceId.make("greppy"),
                      resolveSessionEnvironment: () =>
                        Effect.die("Source worker must not read target model/account environment"),
                    },
                  );
                  const started = yield* adapter.startSession(owned.input).pipe(Effect.result);
                  if (
                    variant === "missing-receipt" ||
                    variant === "changed-digest" ||
                    variant === "runtime-denied" ||
                    variant === "replaced-root"
                  ) {
                    expect(started._tag).toBe("Failure");
                    if (variant !== "replaced-root") expect(children).toHaveLength(0);
                    return;
                  }
                  expect(started._tag).toBe("Success");
                  const journal = Option.getOrThrow(yield* store.get(owned.input.threadId));
                  expect(journal.runtime).not.toBeNull();
                  expect(journal.runtime?.command).toBe(journal.runtime?.runtimeFiles[0]?.path);
                  expect(journal.runtime?.runtimeFiles.map(({ path }) => path)).toContain(
                    owned.script,
                  );
                  if (variant === "runtime-replaced" || variant === "node-runtime-replaced") {
                    const stopped = yield* adapter.stopSession(owned.input.threadId);
                    expect(stopped?.terminated).toBe(true);
                    const before = children.length;
                    yield* Effect.promise(async () => {
                      await NodeFSP.rename(owned.script, owned.script + "-original");
                      await NodeFSP.copyFile(owned.script + "-original", owned.script);
                      await NodeFSP.chmod(owned.script, 0o700);
                    });
                    expect(
                      (yield* adapter.startSession(owned.input).pipe(Effect.result))._tag,
                    ).toBe("Failure");
                    expect(children.length).toBe(before);
                    return;
                  }
                  yield* adapter.sendTurn({
                    threadId: owned.input.threadId,
                    input: twoTurns ? "first" : "hold-terminal",
                  });
                  if (twoTurns) {
                    yield* adapter.sendTurn({ threadId: owned.input.threadId, input: "follow-up" });
                    expect(
                      yield* Effect.tryPromise(() =>
                        NodeFSP.readFile(NodePath.join(owned.home, "acp-turns"), "utf8"),
                      ),
                    ).toBe("2");
                  } else {
                    const held = children.at(-1)!;
                    expect(yield* held.isRunning).toBe(true);
                    const before = owned.admissions();
                    if (variant === "revoked-source-tools")
                      yield* Effect.promise(owned.revokeSource);
                    else yield* Effect.sync(owned.denySource);
                    if (variant === "expired-source-running") {
                      yield* TestClock.adjust("10 seconds");
                      yield* held.exitCode.pipe(Effect.result);
                      yield* children[0]!.exitCode.pipe(Effect.result);
                      expect(yield* children[0]!.isRunning).toBe(false);
                    } else {
                      const result = yield* adapter
                        .sendTurn({
                          threadId: owned.input.threadId,
                          input:
                            variant === "expired-source-cleanup" ? "cleanup-only" : "source-denied",
                        })
                        .pipe(Effect.result);
                      expect(result._tag).toBe(
                        variant === "expired-source-cleanup" ? "Success" : "Failure",
                      );
                    }
                    expect(yield* held.isRunning).toBe(false);
                    expect(owned.admissions() - before).toBe(
                      variant === "revoked-source-tools" || variant === "expired-source-cleanup"
                        ? 0
                        : 1,
                    );
                    expect(
                      yield* Effect.tryPromise(() =>
                        NodeFSP.readFile(NodePath.join(owned.workspace, "main.c"), "utf8"),
                      ),
                    ).toBe("int main(void) { return 0; }\n");
                    expect(
                      (yield* Effect.tryPromise(() =>
                        NodeFSP.access(NodePath.join(owned.workspace, "denied-effect")),
                      ).pipe(Effect.result))._tag,
                    ).toBe("Failure");
                  }
                  expect(
                    NodeChildProcess.execFileSync(
                      "/usr/bin/git",
                      ["-C", owned.workspace, "rev-list", "--count", "HEAD"],
                      { timeout: 5000, encoding: "utf8" },
                    ).trim(),
                  ).toBe(twoTurns ? "2" : "1");
                  const stopped = yield* adapter.stopSession(owned.input.threadId);
                  expect(stopped?.terminated).toBe(true);
                }).pipe(
                  Effect.scoped,
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                  Effect.provideService(ServerEnvironment, {
                    getEnvironmentId: Effect.succeed(EnvironmentId.make("target")),
                    getDescriptor: Effect.die("unused"),
                  }),
                  Effect.provideService(ResourceMonitorBinary, {
                    resolve: Effect.succeed(helper!),
                  }),
                  Effect.provideService(IsolatedWorkerWorktreeStore, {
                    get: () =>
                      Effect.succeed(
                        variant === "missing-receipt"
                          ? Option.none()
                          : Option.some(
                              variant === "changed-digest"
                                ? {
                                    ...owned.receipt,
                                    intent: {
                                      ...owned.receipt.intent,
                                      authorityDigest: "e".repeat(64),
                                    },
                                  }
                                : owned.receipt,
                            ),
                      ),
                    reserve: () => Effect.die("Provider must not create a new allocation"),
                    capture: () => Effect.die("Provider must not recapture or adopt a replacement"),
                  }),
                );
                for (const child of children) expect(yield* child.isRunning).toBe(false);
              }),
            (owned) => Effect.promise(owned.close),
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(
              WorkerSourceCustodyLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
              NodeServices.layer,
            ),
          ),
        ),
      { timeout: 45000 },
    );
  }
});
