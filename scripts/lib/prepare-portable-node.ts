// @effect-diagnostics nodeBuiltinImport:off -- release preparation runs outside the application runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { managedNodeArchive } from "@workjet/ssh/remoteNode";

class PortableNodeDownloadError extends Data.TaggedError("PortableNodeDownloadError")<{
  readonly message: string;
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
    NodeChildProcess.execFileSync("tar", ["-xzf", input.archivePath, "-C", staging], {
      timeout: 60_000,
    });
    const root = NodePath.join(staging, input.pin.directoryName);
    const nodePath = NodePath.join(root, "bin", "node");
    const reported = JSON.parse(
      NodeChildProcess.execFileSync(
        nodePath,
        [
          "-p",
          "JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch,electron:process.versions.electron??null})",
        ],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
        },
      ),
    ) as { version?: unknown; platform?: unknown; arch?: unknown; electron?: unknown };
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
}) {
  const pin = managedNodeArchive(input.platform, input.arch);
  await NodeFSP.mkdir(NodePath.dirname(input.destination), { recursive: true });
  const download = await NodeFSP.mkdtemp(
    NodePath.join(NodePath.dirname(input.destination), ".node-download-"),
  );
  try {
    const archivePath = NodePath.join(download, "node.tar.gz");
    // Bound both the response body and on-disk temporary archive, including chunked responses.
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
          let size = 0;
          yield* Stream.runForEach(response.stream, (chunk) =>
            Effect.gen(function* () {
              size += chunk.byteLength;
              if (size > 100 * 1024 * 1024)
                return yield* new PortableNodeDownloadError({
                  message: "Portable Node archive exceeds its size limit.",
                });
              yield* Effect.tryPromise(() => file.writeFile(chunk));
            }),
          );
        }),
      ).pipe(
        Effect.timeout("180 seconds"),
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      ),
    );
    return await stageVerifiedNodeArchive({ archivePath, destination: input.destination, pin });
  } finally {
    await NodeFSP.rm(download, { recursive: true, force: true });
  }
}
