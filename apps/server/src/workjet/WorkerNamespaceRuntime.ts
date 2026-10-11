// @effect-diagnostics nodeBuiltinImport:off -- Capture the actual executable without executing it or reading host credentials.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@workjet/shared/hostProcess";
import * as Schema from "effect/Schema";
import type { AcpSpawnInput } from "../provider/acp/AcpSessionRuntime.ts";
import type { WorkerNamespaceFileCapture } from "./WorkerNamespaceSpawn.ts";

export class WorkerNamespaceRuntimeError extends Schema.TaggedErrorClass<WorkerNamespaceRuntimeError>()(
  "WorkerNamespaceRuntimeError",
  { issue: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return this.issue;
  }
}

/** Capture only the configured CLI and its interpreter. Self-contained Node
 * entry files are explicit runtime assets; adjacent package/HOME files are
 * never exposed. Multi-file packages require a separate verified producer. */
export const captureWorkerNamespaceRuntime = Effect.fn("captureWorkerNamespaceRuntime")(function* (
  spawn: AcpSpawnInput,
) {
  const platform = yield* HostProcessPlatform;
  return yield* Effect.tryPromise({
    try: async () => {
      if (platform !== "linux") throw new Error("Linux runtime capture is unavailable");
      const resolveExecutable = async (configured: string) => {
        const candidates = NodePath.isAbsolute(configured)
          ? [configured]
          : configured.includes("/") || configured.length === 0
            ? []
            : (spawn.env?.PATH ?? "/usr/bin:/bin")
                .split(NodePath.delimiter)
                .filter((directory) => NodePath.isAbsolute(directory))
                .map((directory) => NodePath.join(directory, configured));
        for (const candidate of candidates) {
          try {
            await NodeFSP.access(candidate, NodeFS.constants.X_OK);
            return await NodeFSP.realpath(candidate);
          } catch (error) {
            if (
              !["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")
            )
              throw error;
          }
        }
        throw new Error("Configured worker executable is unavailable");
      };
      const command = await resolveExecutable(spawn.command);
      const files: WorkerNamespaceFileCapture[] = [];
      const capture = async (path: string, executable = true) => {
        const descriptor = await NodeFSP.open(
          path,
          NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
        );
        try {
          const stat = await descriptor.stat({ bigint: true });
          if (
            !stat.isFile() ||
            (executable && (stat.mode & 0o111n) === 0n) ||
            (stat.mode & 0o6000n) !== 0n
          )
            throw new Error("Worker runtime is not a regular unprivileged file");
          const bytes = Buffer.alloc(512);
          const { bytesRead } = await descriptor.read(bytes, 0, bytes.length, 0);
          files.push({ path, identity: { device: String(stat.dev), inode: String(stat.ino) } });
          return bytes.subarray(0, bytesRead);
        } finally {
          await descriptor.close();
        }
      };
      const elf = (header: Buffer) =>
        header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
      const header = await capture(command);
      if (elf(header)) {
        if ([spawn.command, command].some((path) => ["node", "nodejs"].includes(NodePath.basename(path)))) {
          const entry = spawn.args[0];
          if (!entry || !NodePath.isAbsolute(entry) || !/\.(?:c?js|mjs)$/.test(entry))
            throw new Error("Node worker requires an explicit JavaScript entry file");
          const script = await NodeFSP.realpath(entry);
          await capture(script, false);
          return {
            spawn: { ...spawn, command, args: [script, ...spawn.args.slice(1)] },
            runtimeFiles: files,
          };
        }
      } else {
        const lineEnd = header.indexOf(10);
        const firstLine = header
          .subarray(0, lineEnd < 0 ? header.length : lineEnd)
          .toString("utf8");
        const envNode = /^#!\/usr\/bin\/env[ \t]+(node|nodejs)$/.exec(firstLine)?.[1];
        if (envNode) {
          const interpreter = await resolveExecutable(envNode);
          if (!elf(await capture(interpreter)))
            throw new Error("Worker Node interpreter is not an ELF executable");
          return {
            spawn: { ...spawn, command: interpreter, args: [command, ...spawn.args] },
            runtimeFiles: files,
          };
        }
        const interpreter = /^#!(\/usr\/bin\/[A-Za-z0-9._+-]+)$/.exec(firstLine)?.[1];
        if (!interpreter)
          throw new Error("Worker runtime requires an explicitly supported interpreter or bundle");
        const resolved = await NodeFSP.realpath(interpreter);
        if (!resolved.startsWith("/usr/"))
          throw new Error("Worker interpreter is outside the system runtime");
        if (!elf(await capture(resolved)))
          throw new Error("Worker interpreter is not a system ELF executable");
      }
      return { spawn: { ...spawn, command }, runtimeFiles: files };
    },
    catch: (cause) =>
      new WorkerNamespaceRuntimeError({
        issue:
          "Configured worker runtime could not be captured; unsupported runtimes do not use a host fallback.",
        cause,
      }),
  });
});
