// @effect-diagnostics nodeBuiltinImport:off -- Real executable resolution on isolated fixture files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@workjet/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import { afterEach } from "vite-plus/test";
import type { AcpSpawnInput } from "../provider/acp/AcpSessionRuntime.ts";
import { captureWorkerNamespaceRuntime } from "./WorkerNamespaceRuntime.ts";

const helper = process.env.WORKJET_TEST_NAMESPACE_HELPER;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});
const fixture = async () => {
  const root = await NodeFSP.mkdtemp(
    NodePath.join(await NodeFSP.realpath(process.env.TMPDIR ?? "/tmp"), "wj-runtime-"),
  );
  roots.push(root);
  return root;
};
const expectRefusal = Effect.fn("expectRefusal")(function* (spawn: AcpSpawnInput) {
  const result = yield* captureWorkerNamespaceRuntime(spawn).pipe(Effect.result);
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { message: expect.stringContaining("host fallback"), cause: expect.any(Error) },
  });
});
describe.runIf(helper !== undefined)("Linux worker runtime capture", () => {
  it.effect(
    "captures the original executable behind a PATH symlink without adding its host directory",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.tryPromise(fixture);
        const binary = yield* Effect.tryPromise(() => NodeFSP.realpath("/usr/bin/true"));
        yield* Effect.tryPromise(() => NodeFSP.symlink(binary, NodePath.join(root, "provider")));
        const result = yield* captureWorkerNamespaceRuntime({
          command: "provider",
          args: [],
          env: { PATH: root },
        });
        const stat = yield* Effect.tryPromise(() => NodeFSP.stat(binary, { bigint: true }));
        expect(result.spawn.command).toBe(binary);
        expect(result.runtimeFiles).toEqual([
          { path: binary, identity: { device: String(stat.dev), inode: String(stat.ino) } },
        ]);
      }).pipe(Effect.provideService(HostProcessPlatform, "linux")),
  );
  it.effect("captures a single executable script and its direct system ELF interpreter", () =>
    Effect.gen(function* () {
      const root = yield* Effect.tryPromise(fixture);
      const script = NodePath.join(root, "provider");
      yield* Effect.tryPromise(() =>
        NodeFSP.writeFile(script, "#!/usr/bin/python3\nprint('fixture')\n", { mode: 0o700 }),
      );
      const result = yield* captureWorkerNamespaceRuntime({ command: script, args: [] });
      const interpreter = yield* Effect.tryPromise(() => NodeFSP.realpath("/usr/bin/python3"));
      expect(result.runtimeFiles.map(({ path }) => path)).toEqual([script, interpreter]);
    }).pipe(Effect.provideService(HostProcessPlatform, "linux")),
  );
  it.effect(
    "rejects env resolution and unsupported package launchers instead of spawning on the host",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.tryPromise(fixture);
        const script = NodePath.join(root, "provider");
        yield* Effect.tryPromise(() =>
          NodeFSP.writeFile(script, "#!/usr/bin/env python3\n", { mode: 0o700 }),
        );
        yield* expectRefusal({ command: script, args: [] });
        yield* expectRefusal({ command: "./provider", args: [], env: { PATH: "." } });
      }).pipe(Effect.provideService(HostProcessPlatform, "linux")),
  );
  it.effect("does not capture a non-executable file or a privileged executable", () =>
    Effect.gen(function* () {
      const root = yield* Effect.tryPromise(fixture);
      const binary = NodePath.join(root, "provider");
      yield* Effect.tryPromise(() => NodeFSP.copyFile("/usr/bin/true", binary));
      for (const mode of [0o600, 0o4700]) {
        yield* Effect.tryPromise(() => NodeFSP.chmod(binary, mode));
        yield* expectRefusal({ command: binary, args: [] });
      }
    }).pipe(Effect.provideService(HostProcessPlatform, "linux")),
  );
  it.effect(
    "rejects an executable FIFO without blocking on its contents",
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.tryPromise(fixture);
        const fifo = NodePath.join(root, "provider");
        yield* Effect.try(() =>
          NodeChildProcess.execFileSync("/usr/bin/mkfifo", ["-m", "700", fifo], { timeout: 5000 }),
        );
        yield* expectRefusal({ command: fifo, args: [] });
      }).pipe(Effect.provideService(HostProcessPlatform, "linux")),
    { timeout: 2000 },
  );
});
