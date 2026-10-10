// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Real source admission HTTP boundary.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@workjet/shared/hostProcess";
import {
  DEFAULT_WORKJET_THREAD_CONFIG,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderSessionStartInput,
} from "@workjet/contracts";
import { afterEach, expect, vi } from "vite-plus/test";
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
    threadId: ThreadId.make(thread),
    runtimeMode: "full-access",
    modelSelection: { instanceId: ProviderInstanceId.make("source"), model: "gpt-6.1-sol" },
    workjetConfig: {
      ...DEFAULT_WORKJET_THREAD_CONFIG,
      role: "worker",
      parent: { environmentId: EnvironmentId.make("source"), threadId: ThreadId.make("parent") },
    },
  };
}
const run = (
  value: ProviderSessionStartInput,
  driver: NonNullable<ReturnType<typeof workerSourceDriver>>,
) =>
  admitWorkerSourceNativeProfile(value, ProviderDriverKind.make(driver)).pipe(
    Effect.provideService(ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("target")),
      getDescriptor: Effect.die("unused descriptor"),
    }),
  );
const rejects = (effect: ReturnType<typeof run>, issue: string) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { issue: expect.stringContaining(issue) },
      });
    }),
  );
async function fixture(
  harness: "grok-cli" | "opencode" | "minimax-code" | "greppy" | "pi-code",
  platform: NodeJS.Platform,
  tmpdir: string | undefined,
) {
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
  const directory = await NodeFSP.mkdtemp(
    NodePath.join(
      tmpdir ?? (platform === "darwin" ? "/Volumes/tmp" : NodeOS.tmpdir()),
      "native-admission-",
    ),
  );
  cleanups.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const thread = "admission-" + harness;
  const route = await installWorkerSourceRoute(
    thread,
    {
      sourceEnvironmentId: "source",
      targetEnvironmentId: "target",
      requestId: thread,
      requestDigest: "digest-" + harness,
      capability: "admission-capability",
      port: address.port,
    },
    {
      targetEnvironmentId: "target",
      requestDigest: "digest-" + harness,
      modelId: "gpt-6.1-sol",
      harness,
      nativeProfile: { harness, directory },
    },
  );
  cleanups.push(route.revoke);
  return {
    route,
    value: input(thread),
    admitted: () => admitted,
    deny: () => {
      allowed = false;
    },
  };
}
for (const harness of ["grok-cli", "opencode", "minimax-code", "greppy", "pi-code"] as const) {
  it.effect(`admits ${harness} repeatedly without inheriting target accounts`, () =>
    Effect.gen(function* () {
      vi.stubEnv("ANTHROPIC_API_KEY", "target-anthropic-secret");
      vi.stubEnv("XAI_API_KEY", "target-xai-secret");
      vi.stubEnv("WORKJET_TARGET_SECRET", "target-secret");
      const platform = yield* HostProcessPlatform;
      const environment = yield* HostProcessEnvironment;
      const f = yield* Effect.promise(() => fixture(harness, platform, environment.TMPDIR));
      const before = f.admitted();
      for (let index = 0; index < 20; index++) {
        const profile = yield* run(f.value, workerSourceDriver(harness)!);
        expect(profile?.environment.WORKJET_SOURCE_ISOLATED).toBe("true");
        expect(profile?.environment.WORKJET_WORKER_SOURCE_KEY).toBe(f.route.apiKey);
        expect(profile?.environment.HOME).toBe(f.route.nativeProfile!.environment.HOME);
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          profile,
        );
        expect(encoded).not.toMatch(
          /target-(?:anthropic|xai)-secret|target-secret/,
        );
        expect(profile?.environment.WORKJET_TARGET_SECRET).toBeUndefined();
      }
      expect(f.admitted() - before).toBe(20);
      const beforeWrong = f.admitted();
      yield* rejects(
        run(
          { ...f.value, modelSelection: { ...f.value.modelSelection!, model: "grok-4.7" } },
          workerSourceDriver(harness)!,
        ),
        "source model differs",
      );
      yield* rejects(run(f.value, "codex"), "harness profile");
      expect(f.admitted()).toBe(beforeWrong);
      f.deny();
      yield* rejects(run(f.value, workerSourceDriver(harness)!), "admission failed");
      yield* Effect.promise(() => f.route.revoke());
      yield* rejects(run(f.value, workerSourceDriver(harness)!), "route is revoked");
    }),
  );
}
it.effect(
  "keeps local sessions unchanged and denies foreign restarts without a matching source",
  () =>
    Effect.gen(function* () {
      expect(
        yield* run({ threadId: ThreadId.make("local-native"), runtimeMode: "full-access" }, "grok"),
      ).toBeUndefined();
      yield* rejects(run(input("missing-native-source"), "grok"), "unavailable or mismatched");
    }),
);
