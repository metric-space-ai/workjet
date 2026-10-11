// @effect-diagnostics nodeBuiltinImport:off -- Real executable resolution on isolated fixture files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { captureWorkerNamespaceRuntime } from "./WorkerNamespaceRuntime.ts";

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
describe.runIf(process.platform === "linux")("Linux worker runtime capture", () => {
  it("captures the original executable behind a PATH symlink without adding its host directory", async () => {
    const root = await fixture();
    const binary = await NodeFSP.realpath("/usr/bin/true");
    await NodeFSP.symlink(binary, NodePath.join(root, "provider"));
    const result = await Effect.runPromise(
      captureWorkerNamespaceRuntime({
        command: "provider",
        args: [],
        env: { PATH: root },
      }),
    );
    const stat = await NodeFSP.stat(binary, { bigint: true });
    expect(result.spawn.command).toBe(binary);
    expect(result.runtimeFiles).toEqual([
      { path: binary, identity: { device: String(stat.dev), inode: String(stat.ino) } },
    ]);
  });
  it("captures a single executable script and its direct system ELF interpreter", async () => {
    const root = await fixture();
    const script = NodePath.join(root, "provider");
    await NodeFSP.writeFile(script, "#!/usr/bin/python3\nprint('fixture')\n", { mode: 0o700 });
    const result = await Effect.runPromise(
      captureWorkerNamespaceRuntime({ command: script, args: [] }),
    );
    expect(result.runtimeFiles.map(({ path }) => path)).toEqual([
      script,
      await NodeFSP.realpath("/usr/bin/python3"),
    ]);
  });
  it("rejects env resolution and unsupported package launchers instead of spawning on the host", async () => {
    const root = await fixture();
    const script = NodePath.join(root, "provider");
    await NodeFSP.writeFile(script, "#!/usr/bin/env python3\n", { mode: 0o700 });
    await expect(
      Effect.runPromise(captureWorkerNamespaceRuntime({ command: script, args: [] })),
    ).rejects.toThrow("host fallback");
    await expect(
      Effect.runPromise(
        captureWorkerNamespaceRuntime({ command: "./provider", args: [], env: { PATH: "." } }),
      ),
    ).rejects.toThrow("host fallback");
  });
  it("does not capture a non-executable file or a privileged executable", async () => {
    const root = await fixture();
    const binary = NodePath.join(root, "provider");
    await NodeFSP.copyFile("/usr/bin/true", binary);
    for (const mode of [0o600, 0o4700]) {
      await NodeFSP.chmod(binary, mode);
      await expect(
        Effect.runPromise(captureWorkerNamespaceRuntime({ command: binary, args: [] })),
      ).rejects.toThrow("host fallback");
    }
  });
  it("rejects an executable FIFO without blocking on its contents", async () => {
    const root = await fixture();
    const fifo = NodePath.join(root, "provider");
    NodeChildProcess.execFileSync("/usr/bin/mkfifo", ["-m", "700", fifo], { timeout: 5000 });
    await expect(
      Effect.runPromise(captureWorkerNamespaceRuntime({ command: fifo, args: [] })),
    ).rejects.toThrow("host fallback");
  }, 2000);
});
