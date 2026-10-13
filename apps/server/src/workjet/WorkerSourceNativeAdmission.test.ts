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
import { WORKER_MODEL_NAMESPACE_BASE_URL } from "./WorkerModelNamespaceBridge.ts";

const cleanups: Array<() => Promise<void>> = [];
const catalog = (baseUrl: string, apiKey: string) =>
  fetch(baseUrl + "/models", { headers: { authorization: `Bearer ${apiKey}` } });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
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
  privateModelSocket = false,
  variant = "",
) {
  let allowed = true;
  let admitted = 0;
  let onAdmission: (() => Promise<void>) | undefined;
  const server = NodeHttp.createServer(async (req, res) => {
    expect(req.headers.authorization).toBe("Bearer admission-capability");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    expect(body.operation).toBe("admit");
    admitted++;
    await onAdmission?.();
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
  const thread = "admission-" + harness + (privateModelSocket ? "-private" : "-loopback") + variant;
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
      ...(privateModelSocket ? { modelSocketRoot: NodePath.join(directory, "model-ipc") } : {}),
      nativeProfile: { harness, directory },
    },
  );
  cleanups.push(route.revoke);
  return {
    route,
    value: input(thread),
    admitted: () => admitted,
    onAdmission: (action: () => Promise<void>) => {
      onAdmission = action;
    },
    deny: () => {
      allowed = false;
    },
  };
}
for (const harness of ["grok-cli", "opencode", "minimax-code", "greppy", "pi-code"] as const) {
  it.effect(`keeps ${harness} on its private model endpoint during start and recovery`, () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      const environment = yield* HostProcessEnvironment;
      if (platform !== "linux") {
        yield* Effect.promise(() =>
          expect(fixture(harness, platform, environment.TMPDIR, true)).rejects.toThrow(
            "unavailable",
          ),
        );
        return;
      }
      const f = yield* Effect.promise(() => fixture(harness, platform, environment.TMPDIR, true));
      const before = f.admitted();
      for (let index = 0; index < 2; index++) {
        const profile = yield* run(f.value, workerSourceDriver(harness)!);
        expect(profile?.environment.WORKJET_WORKER_SOURCE_URL).toBe(
          WORKER_MODEL_NAMESPACE_BASE_URL,
        );
        expect(profile?.environment).toMatchObject(f.route.nativeProfile!.environment);
        expect(profile?.files).toEqual(f.route.nativeProfile!.files);
        expect(profile?.model).toBe(f.route.nativeProfile!.model);
        expect(profile?.namespaceProfile).toEqual(f.route.nativeProfileCapture);
        expect(profile?.namespaceProfile?.path).toBe(profile?.directory);
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(profile);
        expect(encoded).not.toContain(f.route.baseUrl);
        expect(encoded).not.toContain(f.route.baseUrl.slice(0, -3));
      }
      expect(f.admitted() - before).toBe(2);
      f.deny();
      yield* rejects(run(f.value, workerSourceDriver(harness)!), "admission failed");
      yield* Effect.promise(() => f.route.revoke());
      yield* rejects(run(f.value, workerSourceDriver(harness)!), "route is revoked");
    }),
  );
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
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(profile);
        expect(encoded).not.toMatch(/target-(?:anthropic|xai)-secret|target-secret/);
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

it.effect("denies provider start and recovery after the original private profile is replaced", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const environment = yield* HostProcessEnvironment;
    if (platform !== "linux") return;
    const f = yield* Effect.promise(() =>
      fixture("minimax-code", platform, environment.TMPDIR, true, "-substitution"),
    );
    const profile = yield* run(f.value, "minimax");
    expect(profile?.namespaceProfile?.path).toBe(f.route.nativeProfile!.directory);
    const before = f.admitted();
    yield* Effect.promise(async () => {
      const directory = f.route.nativeProfile!.directory;
      await NodeFSP.rename(directory, directory + "-held");
      await NodeFSP.mkdir(directory, { mode: 0o700 });
      await NodeFSP.writeFile(NodePath.join(directory, "config.yaml"), "replacement sentinel");
    });
    yield* rejects(run(f.value, "minimax"), "admission failed");
    yield* rejects(run(f.value, "minimax"), "admission failed");
    expect(f.admitted()).toBe(before);
    yield* Effect.promise(async () => {
      await expect(f.route.admit()).rejects.toThrow("custody");
      const response = await catalog(f.route.baseUrl, f.route.apiKey);
      expect(response.status).toBe(502);
      expect(
        await NodeFSP.readFile(
          NodePath.join(f.route.nativeProfile!.directory, "config.yaml"),
          "utf8",
        ),
      ).toBe("replacement sentinel");
      await f.route.revoke();
    });
    expect(f.admitted()).toBe(before);
  }),
);

it.effect("rejects a profile substitution while awaiting fresh source admission", () =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const environment = yield* HostProcessEnvironment;
    if (platform !== "linux") return;
    const f = yield* Effect.promise(() =>
      fixture("minimax-code", platform, environment.TMPDIR, true, "-in-flight-substitution"),
    );
    const before = f.admitted();
    f.onAdmission(async () => {
      const directory = f.route.nativeProfile!.directory;
      await NodeFSP.rename(directory, directory + "-held");
      await NodeFSP.mkdir(directory, { mode: 0o700 });
    });
    yield* rejects(run(f.value, "minimax"), "admission failed");
    expect(f.admitted()).toBe(before + 1);
    yield* rejects(run(f.value, "minimax"), "admission failed");
    expect(f.admitted()).toBe(before + 1);
  }),
);
