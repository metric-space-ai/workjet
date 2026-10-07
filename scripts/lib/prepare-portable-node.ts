// @effect-diagnostics nodeBuiltinImport:off -- release preparation runs outside the application runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { managedNodeArchive } from "@workjet/ssh/remoteNode";

class PortableNodeDownloadError extends Data.TaggedError("PortableNodeDownloadError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Extract only after checking a trusted release pin; destination must be a new build stage. */
export async function stageVerifiedNodeArchive(input: {
  readonly archivePath: string;
  readonly destination: string;
  readonly pin: ReturnType<typeof managedNodeArchive>;
}) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(input.archivePath)) hash.update(chunk);
  const actual = hash.digest("hex");
  if (actual !== input.pin.sha256) throw new Error("Portable Node checksum verification failed.");
  const staging = await NodeFSP.mkdtemp(
    NodePath.join(NodePath.dirname(input.destination), ".node-stage-"),
  );
  let ownsDestination = false;
  try {
    // Headers and manpages are not part of the installed runtime. Exclude them
    // before extraction, avoiding thousands of disposable staging writes.
    NodeChildProcess.execFileSync(
      "tar",
      [
        "-xzf",
        input.archivePath,
        "-C",
        staging,
        `--exclude=${input.pin.directoryName}/include`,
        `--exclude=${input.pin.directoryName}/share`,
      ],
      { timeout: 60_000 },
    );
    const root = NodePath.join(staging, input.pin.directoryName);
    const nodePath = NodePath.join(root, "bin", "node");
    // The first execution of a verified binary can include macOS security
    // assessment and cold disk reads. Bound that work without skipping identity.
    const identityStartedAt = Date.now();
    const identity = await new Promise<string>((resolve, reject) => {
      NodeChildProcess.execFile(
        nodePath,
        [
          "-p",
          "JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch,electron:process.versions.electron??null})",
        ],
        {
          encoding: "utf8",
          timeout: 180_000,
          killSignal: "SIGKILL",
          env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
        },
        (error, stdout) => {
          if (error) {
            // Never copy child output or its command into release diagnostics.
            const code = typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
              ? error.code
              : typeof error.code === "number" ? String(error.code) : "unknown";
            const signal = error.signal === null || error.signal === undefined
              ? "none" : error.signal;
            reject(new Error(
              `Portable Node identity verification failed (180000ms deadline; elapsed ${Date.now() - identityStartedAt}ms; code ${code}; signal ${signal}).`,
            ));
          } else resolve(stdout);
        },
      );
    });
    const reported = JSON.parse(identity) as {
      version?: unknown; platform?: unknown; arch?: unknown; electron?: unknown;
    };
    if (
      reported.version !== input.pin.version ||
      reported.platform !== input.pin.platform ||
      reported.arch !== input.pin.arch ||
      reported.electron !== null
    ) {
      throw new Error("Portable Node runtime identity does not match its release pin.");
    }
    await NodeFSP.access(NodePath.join(root, "LICENSE"));
    // Build stages are private. Never replace a previously staged executable.
    await NodeFSP.mkdir(input.destination);
    ownsDestination = true;
    // The installed service needs Node and npm, not the native-addon SDK or
    // documentation. Preserve npm while avoiding unnecessary header/manpage
    // writes on every fresh service install.
    for (const entry of await NodeFSP.readdir(root)) {
      if (entry === "include" || entry === "share") continue;
      await NodeFSP.rename(NodePath.join(root, entry), NodePath.join(input.destination, entry));
    }
    await NodeFSP.writeFile(
      NodePath.join(input.destination, "workjet-runtime.json"),
      `${JSON.stringify(input.pin, null, 2)}\n`,
    );
    return NodePath.join(input.destination, "bin", "node");
  } catch (cause) {
    if (ownsDestination) await NodeFSP.rm(input.destination, { recursive: true, force: true });
    throw cause;
  } finally {
    await NodeFSP.rm(staging, { recursive: true, force: true });
  }
}

/** Bundle a checksum-pinned standalone executable instead of the build host's Node/Electron. */
export async function preparePortableNode(input: {
  readonly destination: string;
  readonly platform: string;
  readonly arch: string;
  readonly archiveCacheDirectory?: string;
}) {
  const pin = managedNodeArchive(input.platform, input.arch);
  await NodeFSP.mkdir(NodePath.dirname(input.destination), { recursive: true });
  const cache =
    input.archiveCacheDirectory ?? NodePath.join(NodeOS.tmpdir(), "workjet-node-archives");
  await NodeFSP.mkdir(cache, { recursive: true, mode: 0o700 });
  const cachedArchive = NodePath.join(cache, `${pin.directoryName}-${pin.sha256}.tar.gz`);
  const cached = await NodeFSP.stat(cachedArchive).then(
    () => true,
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return false;
      throw cause;
    },
  );
  if (cached) {
    return await stageVerifiedNodeArchive({
      archivePath: cachedArchive,
      destination: input.destination,
      pin,
    });
  }
  const download = await NodeFSP.mkdtemp(NodePath.join(cache, ".node-download-"));
  try {
    const archivePath = NodePath.join(download, "node.tar.gz");
    // Preserve progress before the failed download's private stage is removed.
    let size = 0;
    try {
      // Bound both the response body and temporary archive, including chunked responses.
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const response = yield* HttpClient.get(pin.url);
            if (response.status < 200 || response.status >= 300)
              return yield* new PortableNodeDownloadError({
                message: `Portable Node download failed (${response.status}).`,
              });
            const file = yield* Effect.acquireRelease(
              Effect.tryPromise(() => NodeFSP.open(archivePath, "wx", 0o600)),
              (handle) => Effect.promise(() => handle.close()),
            );
            // Network chunks can be only a few KiB. Awaiting a filesystem operation
            // for each one throttles the response; keep one bounded write buffer.
            const buffer = new Uint8Array(1024 * 1024);
            let buffered = 0;
            yield* Stream.runForEach(response.stream, (chunk) =>
              Effect.gen(function* () {
                size += chunk.byteLength;
                if (size > 100 * 1024 * 1024)
                  return yield* new PortableNodeDownloadError({
                    message: "Portable Node archive exceeds its size limit.",
                  });
                let offset = 0;
                while (offset < chunk.byteLength) {
                  const count = Math.min(buffer.byteLength - buffered, chunk.byteLength - offset);
                  buffer.set(chunk.subarray(offset, offset + count), buffered);
                  buffered += count;
                  offset += count;
                  if (buffered === buffer.byteLength) {
                    yield* Effect.tryPromise(() => file.writeFile(buffer));
                    buffered = 0;
                  }
                }
              }),
            );
            if (buffered > 0)
              yield* Effect.tryPromise(() => file.writeFile(buffer.subarray(0, buffered)));
          }),
        ).pipe(
          Effect.timeout("180 seconds"),
          Effect.provide(FetchHttpClient.layer),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        ),
      );
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message || cause.name : String(cause);
      throw new PortableNodeDownloadError({
        message: `Could not download pinned portable Node ${pin.directoryName} from ${pin.url} (${size} bytes received): ${detail}`,
        cause,
      });
    }
    const executable = await stageVerifiedNodeArchive({
      archivePath,
      destination: input.destination,
      pin,
    });
    // Publish only after checksum and executable identity verification. Both
    // packaging stages share the build TMPDIR; no second network fetch is needed.
    try {
      await NodeFSP.rename(archivePath, cachedArchive);
    } catch (cause) {
      await NodeFSP.rm(input.destination, { recursive: true, force: true });
      throw cause;
    }
    return executable;
  } finally {
    await NodeFSP.rm(download, { recursive: true, force: true });
  }
}
