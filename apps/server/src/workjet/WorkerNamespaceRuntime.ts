// @effect-diagnostics nodeBuiltinImport:off -- Capture the actual executable without executing it or reading host credentials.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { AcpSpawnInput } from "../provider/acp/AcpSessionRuntime.ts";
import type { WorkerNamespaceFileCapture } from "./WorkerNamespaceSpawn.ts";

export class WorkerNamespaceRuntimeError extends Schema.TaggedErrorClass<WorkerNamespaceRuntimeError>()(
  "WorkerNamespaceRuntimeError",
  { issue: Schema.String, cause: Schema.Defect() },
) {}

/** Resolve only the server-configured command. Never mount its host HOME or
 * implicitly expose a package directory. Bundle-based CLIs need their own
 * verified bundle producer; unsupported interpreter forms fail explicitly. */
export const captureWorkerNamespaceRuntime = Effect.fn("captureWorkerNamespaceRuntime")(
  function* (spawn: AcpSpawnInput) {
    return yield* Effect.tryPromise({
      try: async () => {
        if (process.platform !== "linux") throw new Error("Linux runtime capture is unavailable");
        const candidates = NodePath.isAbsolute(spawn.command)
          ? [spawn.command]
          : spawn.command.includes("/") || spawn.command.length === 0
            ? []
            : (spawn.env?.PATH ?? "/usr/bin:/bin")
                .split(NodePath.delimiter)
                .filter((directory) => NodePath.isAbsolute(directory))
                .map((directory) => NodePath.join(directory, spawn.command));
        let command: string | undefined;
        for (const candidate of candidates) {
          try {
            await NodeFSP.access(candidate, NodeFS.constants.X_OK);
            command = await NodeFSP.realpath(candidate);
            break;
          } catch (error) {
            if (!["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
              throw error;
          }
        }
        if (!command) throw new Error("Configured worker executable is unavailable");
        const files: WorkerNamespaceFileCapture[] = [];
        const capture = async (path: string) => {
          const descriptor = await NodeFSP.open(path, NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW);
          try {
            const stat = await descriptor.stat({ bigint: true });
            if (!stat.isFile() || (stat.mode & 0o111n) === 0n || (stat.mode & 0o6000n) !== 0n)
              throw new Error("Worker runtime is not a regular unprivileged executable");
            const bytes = Buffer.alloc(512);
            const { bytesRead } = await descriptor.read(bytes, 0, bytes.length, 0);
            files.push({ path, identity: { device: String(stat.dev), inode: String(stat.ino) } });
            return bytes.subarray(0, bytesRead);
          } finally {
            await descriptor.close();
          }
        };
        const header = await capture(command);
        if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
          const lineEnd = header.indexOf(10);
          const firstLine = header.subarray(0, lineEnd < 0 ? header.length : lineEnd).toString("utf8");
          const interpreter = /^#!(\/usr\/bin\/[A-Za-z0-9._+-]+)$/.exec(firstLine)?.[1];
          if (!interpreter) throw new Error("Worker runtime requires an explicitly supported interpreter or bundle");
          const resolved = await NodeFSP.realpath(interpreter);
          if (!resolved.startsWith("/usr/")) throw new Error("Worker interpreter is outside the system runtime");
          const interpreterHeader = await capture(resolved);
          if (!interpreterHeader.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
            throw new Error("Worker interpreter is not a system ELF executable");
        }
        return { spawn: { ...spawn, command }, runtimeFiles: files };
      },
      catch: (cause) => new WorkerNamespaceRuntimeError({
        issue: "Configured worker runtime could not be captured; unsupported runtimes do not use a host fallback.",
        cause,
      }),
    });
  },
);
