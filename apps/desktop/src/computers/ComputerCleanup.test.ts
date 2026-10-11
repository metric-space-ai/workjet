// @effect-diagnostics nodeBuiltinImport:off -- Disposable fixture only.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { computerCleanupPaths, computerCleanupScript } from "./ComputerCleanup.ts";
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
describe("allowlisted computer cleanup", () => {
  it("rejects user roots, traversal and home deletion", () => {
    for (const home of ["/", "/tmp/../other", "relative"])
      expect(() => computerCleanupPaths({ homeDirectory: home, workDirectory: home })).toThrow();
    expect(() =>
      computerCleanupPaths({ homeDirectory: "/home/test", workDirectory: "/home/test/project" }),
    ).toThrow();
  });
  it("removes only owned directories on a throwaway target and refuses symlinks", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-cleanup-fixture-"));
    try {
      const root = NodePath.join(home, ".workjet/computer-work");
      const outside = NodePath.join(home, "real-project");
      await NodeFSP.mkdir(outside, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(outside, "keep"), "keep");
      await NodeFSP.mkdir(NodePath.join(root, "runtime"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(root, "worktrees"), { recursive: true });
      await NodeFSP.symlink(outside, NodePath.join(root, "caches"));
      const { stdout } = await execFile(
        "sh",
        ["-c", computerCleanupScript({ homeDirectory: home, workDirectory: root })],
        { timeout: 5000, env: { ...process.env, HOME: home } },
      );
      expect(stdout).toContain("removed\t" + NodePath.join(root, "runtime"));
      expect(stdout).toContain("refused\t" + NodePath.join(root, "caches"));
      expect(await NodeFSP.readFile(NodePath.join(outside, "keep"), "utf8")).toBe("keep");
      await NodeFSP.access(root);
    } finally {
      await NodeFSP.rm(home, { recursive: true, force: true });
    }
  });
});

it("refuses cleanup if the remote home changed or an ancestor is a symlink", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-cleanup-escape-"));
  try {
    const outside = NodePath.join(home, "outside");
    await NodeFSP.mkdir(outside);
    await NodeFSP.mkdir(NodePath.join(outside, "computer-work/runtime"), { recursive: true });
    const keep = NodePath.join(outside, "computer-work/runtime/keep");
    await NodeFSP.writeFile(keep, "keep");
    await NodeFSP.symlink(outside, NodePath.join(home, ".workjet"));
    const facts = {
      homeDirectory: home,
      workDirectory: NodePath.join(home, ".workjet/computer-work"),
    };
    const run = (remoteHome: string) =>
      execFile("sh", ["-c", computerCleanupScript(facts)], {
        timeout: 5000,
        env: { ...process.env, HOME: remoteHome },
      });
    expect((await run(home)).stdout).not.toContain("removed");
    expect((await run(home + "-changed")).stdout).toContain("refused");
    expect(await NodeFSP.readFile(keep, "utf8")).toBe("keep");
  } finally {
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});
