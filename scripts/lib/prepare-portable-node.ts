// @effect-diagnostics nodeBuiltinImport:off -- release preparation runs outside the application runtime.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { managedNodeArchive } from "../../packages/ssh/src/remoteNode.ts";

/** Extract only after checking a trusted release pin; destination must be a new build stage. */
export async function stageVerifiedNodeArchive(input: {
  readonly archivePath: string;
  readonly destination: string;
  readonly pin: ReturnType<typeof managedNodeArchive>;
}) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(input.archivePath)) hash.update(chunk);
  const actual = hash.digest("hex");
  if (actual !== input.pin.sha256) throw new Error("Portable Node checksum verification failed.");
  const staging = await fs.mkdtemp(path.join(path.dirname(input.destination), ".node-stage-"));
  let ownsDestination = false;
  try {
    execFileSync("tar", ["-xzf", input.archivePath, "-C", staging], { timeout: 60_000 });
    const root = path.join(staging, input.pin.directoryName);
    const nodePath = path.join(root, "bin", "node");
    const reported = JSON.parse(
      execFileSync(
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
    await fs.access(path.join(root, "LICENSE"));
    // Build stages are private. Never replace a previously staged executable.
    await fs.mkdir(input.destination);
    ownsDestination = true;
    for (const entry of await fs.readdir(root)) {
      await fs.rename(path.join(root, entry), path.join(input.destination, entry));
    }
    await fs.writeFile(
      path.join(input.destination, "workjet-runtime.json"),
      `${JSON.stringify(input.pin, null, 2)}\n`,
    );
    return path.join(input.destination, "bin", "node");
  } catch (cause) {
    if (ownsDestination) await fs.rm(input.destination, { recursive: true, force: true });
    throw cause;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

/** Bundle a checksum-pinned standalone executable instead of the build host's Node/Electron. */
export async function preparePortableNode(input: {
  readonly destination: string;
  readonly platform: string;
  readonly arch: string;
}) {
  const pin = managedNodeArchive(input.platform, input.arch);
  await fs.mkdir(path.dirname(input.destination), { recursive: true });
  const download = await fs.mkdtemp(path.join(path.dirname(input.destination), ".node-download-"));
  try {
    const response = await fetch(pin.url, {
      signal: AbortSignal.timeout(180_000),
      redirect: "error",
    });
    if (!response.ok || response.body === null)
      throw new Error(`Portable Node download failed (${response.status}).`);
    const archivePath = path.join(download, "node.tar.gz");
    // Bound both the response body and on-disk temporary archive, including chunked responses.
    const file = await fs.open(archivePath, "wx", 0o600);
    const reader = response.body.getReader();
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 100 * 1024 * 1024)
          throw new Error("Portable Node archive exceeds its size limit.");
        await file.writeFile(chunk.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      await file.close();
    }
    return await stageVerifiedNodeArchive({ archivePath, destination: input.destination, pin });
  } finally {
    await fs.rm(download, { recursive: true, force: true });
  }
}
