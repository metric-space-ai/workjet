// @effect-diagnostics nodeBuiltinImport:off -- Actual Greppy adapter/factory and Linux namespace, with protocol fixtures and no real model.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeHttp from "node:http";
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import {
  DEFAULT_SERVER_SETTINGS, DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, type ProviderSessionStartInput,
} from "@workjet/contracts";
import { makeGreppyAdapter } from "../Layers/GreppyAdapter.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ResourceMonitorBinary } from "../../resourceTelemetry/ResourceMonitorBinary.ts";
import { IsolatedWorkerWorktreeStore, type IsolatedWorkerWorktreeReceipt } from "../../workjet/IsolatedWorkerWorktreeStore.ts";
import { installWorkerSourceRoute } from "../../workjet/WorkerSourceHarness.ts";

const helper = process.env.WORKJET_TEST_NAMESPACE_HELPER;
const agent = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../../scripts/acp-namespace-mock.py");
const fixture = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(await NodeFSP.realpath(process.env.TMPDIR ?? "/tmp"), "wj-greppy-ns-"));
  const threadId = ThreadId.make(NodePath.basename(root));
  const stage = NodePath.join(root, ".workjet-prepared-" + threadId + "-original");
  const workspace = NodePath.join(root, "worker");
  const runtime = NodePath.join(root, "runtime");
  const script = NodePath.join(runtime, "greppy");
  let route: Awaited<ReturnType<typeof installWorkerSourceRoute>> | undefined;
  const source = NodeHttp.createServer((_request, response) => response.writeHead(200, { "content-type": "application/json" }).end("{}"));
  try {
    await NodeFSP.mkdir(stage, { mode: 0o700 });
    await NodeFSP.mkdir(runtime, { mode: 0o700 });
    await NodeFSP.writeFile(script, (await NodeFSP.readFile(agent, "utf8")).replace("#!/usr/bin/env python3", "#!/usr/bin/python3"), { mode: 0o700 });
    NodeChildProcess.execFileSync("/usr/bin/git", ["init", stage], { timeout: 5000, stdio: "pipe" });
    const tree = await NodeFSP.stat(stage, { bigint: true });
    const git = await NodeFSP.stat(NodePath.join(stage, ".git"), { bigint: true });
    const receipt: IsolatedWorkerWorktreeReceipt = {
      intent: {
        workerId: threadId, projectId: "fixture-project", repositoryKey: "https://example.invalid/project",
        repositoryUrl: "https://example.invalid/project.git", sourceCwd: NodePath.join(root, "source"),
        revision: "a".repeat(40), branch: "workjet/worker/" + threadId, destination: workspace, authorityDigest: "d".repeat(64),
      },
      custody: { kind: "isolated", worktreePath: stage, worktreeDev: String(tree.dev), worktreeIno: String(tree.ino),
        adminPath: NodePath.join(stage, ".git"), adminDev: String(git.dev), adminIno: String(git.ino) },
    };
    await NodeFSP.rename(stage, workspace);
    await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
    const address = source.address();
    if (!address || typeof address === "string") throw new Error("fixture source unavailable");
    route = await installWorkerSourceRoute(threadId, {
      sourceEnvironmentId: "source", targetEnvironmentId: "target", requestId: threadId,
      requestDigest: receipt.intent.authorityDigest, capability: "fixture-source-capability", port: address.port,
    }, {
      targetEnvironmentId: "target", requestDigest: receipt.intent.authorityDigest, modelId: "gpt-6.1-sol", harness: "greppy",
      modelSocketRoot: NodePath.join(root, "model-ipc"), nativeProfile: { harness: "greppy", directory: NodePath.join(root, "profile") },
    });
    const input: ProviderSessionStartInput = {
      threadId, cwd: workspace, runtimeMode: "approval-required",
      modelSelection: { instanceId: ProviderInstanceId.make("greppy"), model: "gpt-6.1-sol" },
      workjetConfig: {
        ...DEFAULT_WORKJET_THREAD_CONFIG, role: "worker",
        parent: { environmentId: EnvironmentId.make("source"), threadId: ThreadId.make("parent") },
        executionPolicy: { mode: "autonomous-worktree", projectId: ProjectId.make("fixture-project"), revision: 1 },
      },
    };
    return { root, workspace, script, input, receipt, home: route.nativeProfile!.environment.HOME!,
      close: async () => {
        await route?.revoke();
        source.closeAllConnections();
        await new Promise<void>((resolve) => source.close(() => resolve()));
        await NodeFSP.rm(root, { recursive: true, force: true });
      },
    };
  } catch (cause) {
    await route?.revoke();
    source.closeAllConnections();
    if (source.listening) await new Promise<void>((resolve) => source.close(() => resolve()));
    await NodeFSP.rm(root, { recursive: true, force: true });
    throw cause;
  }
};
describe.runIf(helper !== undefined)("Greppy original runtime/custody production path", () => {
  for (const variant of ["two-turns", "missing-receipt", "changed-digest", "replaced-root"] as const) {
    it.effect(variant, () => Effect.acquireUseRelease(
      Effect.tryPromise(fixture),
      (owned) => Effect.gen(function* () {
        const originalSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const children: ChildProcessSpawner.ChildProcessHandle[] = [];
        const spawner = ChildProcessSpawner.make((command) => originalSpawner.spawn(command).pipe(
          Effect.tap((child) => Effect.sync(() => { children.push(child); })),
        ));
        if (variant === "replaced-root") {
          yield* Effect.tryPromise(async () => {
            await NodeFSP.rename(owned.workspace, owned.workspace + "-held");
            await NodeFSP.mkdir(owned.workspace, { mode: 0o700 });
            NodeChildProcess.execFileSync("/usr/bin/git", ["init", owned.workspace], { timeout: 5000, stdio: "pipe" });
          });
        }
        yield* Effect.gen(function* () {
          const adapter = yield* makeGreppyAdapter({
            ...DEFAULT_SERVER_SETTINGS.providers.greppy, enabled: true, binaryPath: owned.script,
            model: "gpt-6.1-sol", endpoint: "http://127.0.0.1:23197",
          }, {
            instanceId: ProviderInstanceId.make("greppy"),
            resolveSessionEnvironment: () => Effect.die("Source worker must not read target model/account environment"),
          });
          const started = yield* adapter.startSession(owned.input).pipe(Effect.result);
          if (variant !== "two-turns") {
            expect(started._tag).toBe("Failure");
            if (variant !== "replaced-root") expect(children).toHaveLength(0);
            return;
          }
          expect(started._tag).toBe("Success");
          for (const input of ["first", "follow-up"])
            yield* adapter.sendTurn({ threadId: owned.input.threadId, input });
          expect(yield* Effect.tryPromise(() => NodeFSP.readFile(NodePath.join(owned.home, "acp-turns"), "utf8"))).toBe("2");
          expect(NodeChildProcess.execFileSync("/usr/bin/git", ["-C", owned.workspace, "rev-list", "--count", "HEAD"], { timeout: 5000, encoding: "utf8" }).trim()).toBe("2");
          const stopped = yield* adapter.stopSession(owned.input.threadId);
          expect(stopped?.terminated).toBe(true);
        }).pipe(
          Effect.scoped,
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(ServerEnvironment, { getEnvironmentId: Effect.succeed(EnvironmentId.make("target")), getDescriptor: Effect.die("unused") }),
          Effect.provideService(ResourceMonitorBinary, { resolve: Effect.succeed(helper!) }),
          Effect.provideService(IsolatedWorkerWorktreeStore, {
            get: () => Effect.succeed(variant === "missing-receipt" ? Option.none() : Option.some(
              variant === "changed-digest" ? { ...owned.receipt, intent: { ...owned.receipt.intent, authorityDigest: "e".repeat(64) } } : owned.receipt,
            )),
            reserve: () => Effect.die("Provider must not create a new allocation"),
            capture: () => Effect.die("Provider must not recapture or adopt a replacement"),
          }),
        );
        for (const child of children) expect(yield* child.isRunning).toBe(false);
      }),
      (owned) => Effect.promise(owned.close),
    ).pipe(Effect.provide(NodeServices.layer)), { timeout: 45000 });
  }
});
