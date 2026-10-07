// @effect-diagnostics nodeBuiltinImport:off -- release verification runs outside the application runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const SERVER_ENTRIES = ["bin.mjs", "service-launcher.mjs"] as const;

async function fileDigest(path: string) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** Refuse a release that would install older server code than its fresh build. */
export async function verifyBundledServerSource(input: {
  readonly serverDist: string;
  readonly archiveDirectory: string;
  readonly platform: "mac" | "linux" | "win";
  readonly arch: "arm64" | "x64" | "universal";
}) {
  const entries = await NodeFSP.readdir(input.archiveDirectory).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  });
  const archives = entries.filter((entry) =>
    /^workjet-server-(darwin|linux)-(arm64|x64)\.tgz$/u.test(entry),
  );
  // Windows starts its WSL server from the staged app, rather than a local TGZ.
  const platform = input.platform === "mac" ? "darwin" : input.platform;
  if (platform !== "win") {
    const architectures = input.arch === "universal" ? ["arm64", "x64"] : [input.arch];
    for (const arch of architectures) {
      const filename = `workjet-server-${platform}-${arch}.tgz`;
      if (!archives.includes(filename))
        throw new Error(
          `Missing bundled server ${filename}. Run scripts/build-ssh-server.mjs on the matching host.`,
        );
    }
  }
  if (input.platform === "mac" && !archives.includes("workjet-server-linux-x64.tgz")) {
    throw new Error(
      "Missing bundled server workjet-server-linux-x64.tgz. Mac packaging must build the Linux SSH server on gpu3.",
    );
  }
  const expected = new Map<string, string>();
  for (const entry of SERVER_ENTRIES)
    expected.set(entry, await fileDigest(NodePath.join(input.serverDist, entry)));
  for (const filename of archives.sort()) {
    const archivePath = NodePath.join(input.archiveDirectory, filename);
    const checksum = await NodeFSP.readFile(`${archivePath}.sha256`, "utf8");
    const match = /^([0-9a-f]{64}) {2}(\S+)\n?$/u.exec(checksum);
    if (!match || match[2] !== filename || (await fileDigest(archivePath)) !== match[1]) {
      throw new Error(
        `Bundled server checksum mismatch: ${filename}. Regenerate the archive and its checksum together.`,
      );
    }
    for (const entry of SERVER_ENTRIES) {
      const { stdout } = await execFile("tar", ["-xOf", archivePath, `package/dist/${entry}`], {
        encoding: "buffer",
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      const actual = NodeCrypto.createHash("sha256").update(stdout).digest("hex");
      if (actual !== expected.get(entry)) {
        throw new Error(
          `Stale bundled server ${filename}: dist/${entry} differs from the current server build. Run scripts/build-ssh-server.mjs on the matching host after building the server.`,
        );
      }
    }
  }
  return archives;
}
