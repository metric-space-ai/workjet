import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

// Build-time archive selection; never execute a native module from another host.
export function selectWslPtyArchiveMember(listing, arch) {
  if (!["x64", "arm64"].includes(arch)) throw new Error("Unsupported WSL architecture");
  const files = listing.split(/\r?\n/).filter(Boolean);
  const candidates = files.filter(
    (name) =>
      !name.split("/").includes("..") &&
      !name.startsWith("/") &&
      /(?:^|\/)node-pty\/(?:build\/Release\/pty\.node|prebuilds\/linux-(?:x64|arm64)\/pty\.node)$/.test(
        name,
      ) &&
      (!name.includes("/prebuilds/") || name.endsWith(`/prebuilds/linux-${arch}/pty.node`)),
  );
  const built = candidates.filter((name) => name.endsWith("/build/Release/pty.node"));
  const selected = built.length ? built : candidates;
  if (selected.length !== 1)
    throw new Error(
      `Expected one matching Linux ${arch} node-pty binary, found ${selected.length}`,
    );
  return selected[0];
}

if (
  NodeProcess.argv[1] &&
  NodePath.resolve(NodeProcess.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const [archive, arch] = NodeProcess.argv.slice(2);
  if (!archive || !arch) throw new Error("Usage: wsl-pty-archive.mjs ARCHIVE ARCH");
  const listing = NodeChildProcess.execFileSync("tar", ["-tzf", archive], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
  NodeProcess.stdout.write(selectWslPtyArchiveMember(listing, arch) + "\n");
}
