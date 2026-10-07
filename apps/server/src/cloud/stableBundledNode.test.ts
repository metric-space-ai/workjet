// @effect-diagnostics nodeBuiltinImport:off - Tests verify executable inode identity, which Effect FileSystem does not expose.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "@effect/vitest";
import { bundledRuntimeNodePath, ensureStableBundledRuntimeNode } from "./bundledRuntime.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await NodeFSP.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await NodeFSP.mkdtemp(
    NodePath.join(process.env.TMPDIR ?? "/tmp", "stable-node-test-"),
  );
  roots.push(root);
  const base = NodePath.join(root, "profile");
  await NodeFSP.mkdir(base);
  return {
    base,
    async release(version: string, nodeVersion = "24.13.1", contents = "original node") {
      const entry = NodePath.join(
        base,
        "runtime",
        "versions",
        version,
        "node_modules",
        "workjet",
        "dist",
        "bin.mjs",
      );
      const node = bundledRuntimeNodePath(entry);
      await NodeFSP.mkdir(NodePath.dirname(node), { recursive: true });
      await NodeFSP.writeFile(node, contents, { mode: 0o755 });
      await NodeFSP.writeFile(
        NodePath.resolve(NodePath.dirname(node), "../workjet-runtime.json"),
        JSON.stringify({ version: nodeVersion, platform: "darwin", arch: "arm64" }),
      );
      await NodeFSP.writeFile(
        NodePath.resolve(NodePath.dirname(node), "../LICENSE"),
        "Node license",
      );
      return entry;
    },
  };
}

it("keeps the executable path, bytes and inode through two Workjet updates", async () => {
  const f = await fixture();
  const first = await ensureStableBundledRuntimeNode(f.base, await f.release("0.0.52"));
  const before = await NodeFSP.stat(first);
  for (const version of ["0.0.53", "0.0.54"]) {
    const node = await ensureStableBundledRuntimeNode(
      f.base,
      await f.release(version, "24.14.0", "new packaged node"),
    );
    expect(node).toBe(first);
    expect(await NodeFSP.readFile(node, "utf8")).toBe("original node");
    expect((await NodeFSP.stat(node)).ino).toBe(before.ino);
    expect((await NodeFSP.stat(node)).mtimeMs).toBe(before.mtimeMs);
  }
  expect(first).toBe(NodePath.join(f.base, "runtime", "node", "24", "bin", "node"));
});
it("publishes a separate major without replacing the previously running runtime", async () => {
  const f = await fixture();
  const old = await ensureStableBundledRuntimeNode(f.base, await f.release("0.0.52"));
  const next = await ensureStableBundledRuntimeNode(
    f.base,
    await f.release("0.0.55", "25.1.0", "next node"),
  );
  expect(next).toBe(NodePath.join(f.base, "runtime", "node", "25", "bin", "node"));
  expect(await NodeFSP.readFile(old, "utf8")).toBe("original node");
  expect(await NodeFSP.readFile(next, "utf8")).toBe("next node");
});
it("refuses an incomplete existing runtime and preserves it", async () => {
  const f = await fixture();
  const destination = NodePath.join(f.base, "runtime", "node", "24");
  await NodeFSP.mkdir(destination, { recursive: true });
  await NodeFSP.writeFile(NodePath.join(destination, "keep"), "owned");
  await expect(ensureStableBundledRuntimeNode(f.base, await f.release("0.0.53"))).rejects.toThrow(
    "incomplete",
  );
  expect(await NodeFSP.readFile(NodePath.join(destination, "keep"), "utf8")).toBe("owned");
});
it("rejects modified executable bytes without repairing or replacing them", async () => {
  const f = await fixture();
  const node = await ensureStableBundledRuntimeNode(f.base, await f.release("0.0.52"));
  await NodeFSP.writeFile(node, "changed");
  await expect(ensureStableBundledRuntimeNode(f.base, await f.release("0.0.53"))).rejects.toThrow(
    "checksum",
  );
  expect(await NodeFSP.readFile(node, "utf8")).toBe("changed");
});
it("rejects a symlinked destination and leaves its target untouched", async () => {
  const f = await fixture();
  const target = NodePath.join(f.base, "foreign");
  await NodeFSP.mkdir(target);
  const parent = NodePath.join(f.base, "runtime", "node");
  await NodeFSP.mkdir(parent, { recursive: true });
  await NodeFSP.symlink(target, NodePath.join(parent, "24"));
  await expect(ensureStableBundledRuntimeNode(f.base, await f.release("0.0.53"))).rejects.toThrow(
    "link",
  );
  expect(await NodeFSP.readdir(target)).toEqual([]);
});
it("rejects a malformed version before creating any persistent runtime", async () => {
  const f = await fixture();
  await expect(
    ensureStableBundledRuntimeNode(f.base, await f.release("0.0.53", "../escape")),
  ).rejects.toThrow();
  await expect(NodeFSP.stat(NodePath.join(f.base, "runtime", "node"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});
