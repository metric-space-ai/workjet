// @effect-diagnostics nodeBuiltinImport:off -- isolated archive fixtures for release verification.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import { verifyBundledServerSource } from "./bundled-server-source.ts";

async function withFixture(run: (data: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const data = await fixture();
  try {
    await run(data);
  } finally {
    await NodeFSP.rm(data.root, { recursive: true, force: true });
  }
}

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-server-source-"));
  const serverDist = NodePath.join(root, "dist");
  const archiveDirectory = NodePath.join(root, "archives");
  const stage = NodePath.join(root, "stage");
  const packagedDist = NodePath.join(stage, "package/dist");
  for (const dir of [serverDist, archiveDirectory, packagedDist])
    await NodeFSP.mkdir(dir, { recursive: true });
  for (const entry of ["bin.mjs", "service-launcher.mjs"])
    await NodeFSP.writeFile(NodePath.join(serverDist, entry), `export const entry = '${entry}';\n`);
  async function archive(target = "darwin-arm64", staleEntry?: string, omitEntry?: string) {
    for (const entry of ["bin.mjs", "service-launcher.mjs"]) {
      const destination = NodePath.join(packagedDist, entry);
      await NodeFSP.copyFile(NodePath.join(serverDist, entry), destination);
      if (entry === staleEntry) await NodeFSP.appendFile(destination, "// obsolete source\n");
      if (entry === omitEntry) await NodeFSP.unlink(destination);
    }
    const filename = `workjet-server-${target}.tgz`;
    const path = NodePath.join(archiveDirectory, filename);
    NodeChildProcess.execFileSync("tar", ["-czf", path, "-C", stage, "package"], {
      timeout: 30_000,
    });
    const hash = NodeCrypto.createHash("sha256")
      .update(await NodeFSP.readFile(path))
      .digest("hex");
    await NodeFSP.writeFile(`${path}.sha256`, `${hash}  ${filename}\n`);
    return path;
  }
  return {
    root,
    archive,
    options: { serverDist, archiveDirectory, platform: "mac" as const, arch: "arm64" as const },
  };
}

it("accepts fresh native and remote server archives", () =>
  withFixture(async ({ archive, options }) => {
    await archive();
    await archive("linux-x64");
    NodeAssert.deepEqual(await verifyBundledServerSource(options), [
      "workjet-server-darwin-arm64.tgz",
      "workjet-server-linux-x64.tgz",
    ]);
  }));
for (const entry of ["bin.mjs", "service-launcher.mjs"]) {
  it(`refuses obsolete ${entry} even with a valid archive checksum`, () =>
    withFixture(async ({ archive, options }) => {
      await archive("darwin-arm64", entry);
      await archive("linux-x64");
      await NodeAssert.rejects(verifyBundledServerSource(options), /Stale bundled server/);
    }));
}
it("refuses stale remote archives included beside the native runtime", () =>
  withFixture(async ({ archive, options }) => {
    await archive();
    await archive("linux-x64", "bin.mjs");
    await NodeAssert.rejects(
      verifyBundledServerSource(options),
      /Stale bundled server workjet-server-linux-x64/,
    );
  }));
it("refuses changed archive bytes before reading server entries", () =>
  withFixture(async ({ archive, options }) => {
    const path = await archive();
    await archive("linux-x64");
    await NodeFSP.appendFile(path, "corruption");
    await NodeAssert.rejects(verifyBundledServerSource(options), /checksum mismatch/);
  }));
it("requires both native architectures for a universal Mac app", () =>
  withFixture(async ({ archive, options }) => {
    await archive();
    await NodeAssert.rejects(
      verifyBundledServerSource({ ...options, arch: "universal" }),
      /Missing bundled server workjet-server-darwin-x64/,
    );
    await archive("darwin-x64");
    await archive("linux-x64");
    NodeAssert.equal(
      (await verifyBundledServerSource({ ...options, arch: "universal" })).length,
      3,
    );
  }));
it("refuses an archive without the service launcher", () =>
  withFixture(async ({ archive, options }) => {
    await archive("darwin-arm64", undefined, "service-launcher.mjs");
    await archive("linux-x64");
    await NodeAssert.rejects(verifyBundledServerSource(options));
  }));
it("refuses a Mac bundle that contains only its local server", () =>
  withFixture(async ({ archive, options }) => {
    await archive();
    await NodeAssert.rejects(
      verifyBundledServerSource(options),
      /Missing bundled server workjet-server-linux-x64/,
    );
  }));
it("uses the staged WSL server on Windows without requiring a local TGZ", () =>
  withFixture(async ({ options }) => {
    await NodeFSP.rm(options.archiveDirectory, { recursive: true });
    NodeAssert.deepEqual(await verifyBundledServerSource({ ...options, platform: "win" }), []);
  }));
