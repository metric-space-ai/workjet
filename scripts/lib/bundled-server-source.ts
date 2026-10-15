// @effect-diagnostics nodeBuiltinImport:off -- release verification runs outside the application runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { PROVIDER_GATEWAY_DIAGNOSTIC_EXECUTABLE_MAX_BYTES } from "@workjet/shared/providerGatewayHostDiagnostic";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const SERVER_ENTRIES = ["bin.mjs", "service-launcher.mjs"] as const;

async function fileDigest(path: string) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function describeFirstByteDifference(current: Buffer, archived: Buffer, binary: boolean) {
  let offset = 0;
  const sharedLength = Math.min(current.length, archived.length);
  while (offset < sharedLength && current[offset] === archived[offset]) offset += 1;
  const context = (bytes: Buffer) =>
    binary
      ? bytes.subarray(Math.max(0, offset - 40), offset + 40).toString("hex")
      : bytes
          .subarray(Math.max(0, offset - 320), offset)
          .toString("utf8")
          .slice(-80) +
        bytes
          .subarray(offset, offset + 320)
          .toString("utf8")
          .slice(0, 80);
  return (
    `First differing byte offset ${offset} (zero-based); ` +
    `current length ${current.length}, archive length ${archived.length}; ` +
    `current context ${JSON.stringify(context(current))}; ` +
    `archive context ${JSON.stringify(context(archived))}.`
  );
}

/** Refuse a release that would install older server code than its fresh build. */
export async function verifyBundledServerSource(input: {
  readonly serverDist: string;
  readonly archiveDirectory: string;
  readonly platform: "mac" | "linux" | "win";
  readonly arch: "arm64" | "x64" | "universal";
  readonly providerGatewayHost?: {
    readonly archiveFileName: string;
    readonly executablePath: string;
  };
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
  if (input.providerGatewayHost && !archives.includes(input.providerGatewayHost.archiveFileName))
    throw new Error("Missing local server archive for the selected diagnostic provider host.");
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
    const expectedEntries = new Map(expected);
    if (input.providerGatewayHost?.archiveFileName === filename)
      expectedEntries.set(
        "workjet-provider-gateway-host",
        await fileDigest(input.providerGatewayHost.executablePath),
      );
    for (const [entry, expectedDigest] of expectedEntries) {
      // A relative archive name keeps GNU tar on Windows from reading "C:" as a remote host.
      const { stdout } = await execFile("tar", ["-xOf", filename, `package/dist/${entry}`], {
        cwd: input.archiveDirectory,
        encoding: "buffer",
        timeout: 30_000,
        maxBuffer:
          entry === "workjet-provider-gateway-host"
            ? PROVIDER_GATEWAY_DIAGNOSTIC_EXECUTABLE_MAX_BYTES
            : 16 * 1024 * 1024,
      });
      const actual = NodeCrypto.createHash("sha256").update(stdout).digest("hex");
      if (actual !== expectedDigest) {
        const sourcePath =
          entry === "workjet-provider-gateway-host" && input.providerGatewayHost
            ? input.providerGatewayHost.executablePath
            : NodePath.join(input.serverDist, entry);
        const current = await NodeFSP.readFile(sourcePath);
        const difference = describeFirstByteDifference(
          current,
          stdout,
          entry === "workjet-provider-gateway-host",
        );
        throw new Error(
          `Stale bundled server ${filename}: dist/${entry} differs from the current server build. ${difference} Run scripts/build-ssh-server.mjs on the matching host after building the server.`,
        );
      }
    }
  }
  return archives;
}
