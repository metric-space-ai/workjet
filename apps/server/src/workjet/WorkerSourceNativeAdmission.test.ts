// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Real source admission HTTP boundary.
import * as NodeHttp from "node:http";
import * as NodeFs from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOs from "node:os";
import * as Effect from "effect/Effect";
import {
  DEFAULT_WORKJET_THREAD_CONFIG, EnvironmentId, ProviderInstanceId, ThreadId,
  type ProviderSessionStartInput,
} from "@workjet/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { installWorkerSourceRoute } from "./WorkerSourceHarness.ts";
import { admitWorkerSourceNativeProfile } from "./WorkerSourceNativeAdmission.ts";
import { workerSourceDriver } from "./WorkerSourceNativeProfile.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});
function input(thread: string): ProviderSessionStartInput {
  return {
    threadId: ThreadId.make(thread), runtimeMode: "full-access",
    modelSelection: { instanceId: ProviderInstanceId.make("source"), model: "gpt-6.1-sol" },
    workjetConfig: {
      ...DEFAULT_WORKJET_THREAD_CONFIG, role: "worker",
      parent: { environmentId: EnvironmentId.make("source"), threadId: ThreadId.make("parent") },
    },
  };
}
const run = (value: ProviderSessionStartInput, driver: NonNullable<ReturnType<typeof workerSourceDriver>>) =>
  Effect.runPromise(admitWorkerSourceNativeProfile(value, driver).pipe(
    Effect.provideService(ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("target")),
      getDescriptor: Effect.die("unused descriptor"),
    }),
  ));
async function fixture(harness: "grok-cli" | "opencode" | "minimax-code" | "greppy-code" | "pi-code") {
  let allowed = true;
  let admitted = 0;
  const server = NodeHttp.createServer(async (req, res) => {
    expect(req.headers.authorization).toBe("Bearer admission-capability");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    expect(body.operation).toBe("admit");
    admitted++;
    res.writeHead(allowed ? 200 : 403, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listener");
  const directory = await NodeFs.mkdtemp(NodePath.join(
    process.env.TMPDIR ?? (process.platform === "darwin" ? "/Volumes/tmp" : NodeOs.tmpdir()),
    "native-admission-",
  ));
  cleanups.push(() => NodeFs.rm(directory, { recursive: true, force: true }));
  const thread = "admission-" + harness;
  const route = await installWorkerSourceRoute(thread, {
    sourceEnvironmentId: "source", targetEnvironmentId: "target", requestId: thread,
    requestDigest: "digest-" + harness, capability: "admission-capability", port: address.port,
  }, {
    targetEnvironmentId: "target", requestDigest: "digest-" + harness, modelId: "gpt-6.1-sol",
    harness, nativeProfile: { harness, directory },
  });
  cleanups.push(route.revoke);
  return { route, value: input(thread), admitted: () => admitted, deny: () => { allowed = false; } };
}
for (const harness of ["grok-cli", "opencode", "minimax-code", "greppy-code", "pi-code"] as const) {
  it(`admits ${harness} repeatedly without inheriting target accounts`, async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "target-anthropic-secret");
    vi.stubEnv("XAI_API_KEY", "target-xai-secret");
    vi.stubEnv("WORKJET_TARGET_SECRET", "target-secret");
    const f = await fixture(harness);
    const before = f.admitted();
    for (let index = 0; index < 20; index++) {
      const profile = await run(f.value, workerSourceDriver(harness)!);
      expect(profile?.environment.WORKJET_SOURCE_ISOLATED).toBe("true");
      expect(profile?.environment.WORKJET_WORKER_SOURCE_KEY).toBe(f.route.apiKey);
      expect(profile?.environment.HOME).toBe(f.route.nativeProfile!.environment.HOME);
      expect(JSON.stringify(profile)).not.toMatch(/target-(?:anthropic|xai)-secret|target-secret/);
      expect(profile?.environment.WORKJET_TARGET_SECRET).toBeUndefined();
    }
    expect(f.admitted() - before).toBe(20);
    const beforeWrong = f.admitted();
    await expect(run({ ...f.value, modelSelection: { ...f.value.modelSelection!, model: "grok-4.7" } },
      workerSourceDriver(harness)!)).rejects.toThrow("source model differs");
    await expect(run(f.value, "codex")).rejects.toThrow("harness profile");
    expect(f.admitted()).toBe(beforeWrong);
    f.deny();
    await expect(run(f.value, workerSourceDriver(harness)!)).rejects.toThrow("admission failed");
    await f.route.revoke();
    await expect(run(f.value, workerSourceDriver(harness)!)).rejects.toThrow("route is revoked");
  });
}
it("keeps local sessions unchanged and denies foreign restarts without a matching source", async () => {
  await expect(run({ threadId: ThreadId.make("local-native"), runtimeMode: "full-access" }, "grok"))
    .resolves.toBeUndefined();
  await expect(run(input("missing-native-source"), "grok")).rejects.toThrow("unavailable or mismatched");
});
