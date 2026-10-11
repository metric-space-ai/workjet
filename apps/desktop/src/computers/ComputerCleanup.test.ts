// @effect-diagnostics nodeBuiltinImport:off -- Disposable fixture only.
import { describe, expect, it } from "vite-plus/test";
import * as Fsp from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import * as Child from "node:child_process";
import { promisify } from "node:util";
import { computerCleanupPaths, computerCleanupScript } from "./ComputerCleanup.ts";
const execFile = promisify(Child.execFile);
describe("allowlisted computer cleanup", () => {
  it("rejects user roots, traversal and home deletion", () => {
    for (const home of ["/", "/tmp/../other", "relative"])
      expect(() => computerCleanupPaths({ homeDirectory: home, workDirectory: home })).toThrow();
    expect(() =>
      computerCleanupPaths({ homeDirectory: "/home/test", workDirectory: "/home/test/project" }),
    ).toThrow();
  });
  it("removes only owned directories on a throwaway target and refuses symlinks", async () => {
    const home = await Fsp.mkdtemp(Path.join(Os.tmpdir(), "workjet-cleanup-fixture-"));
    try {
      const root = Path.join(home, ".workjet/computer-work");
      const outside = Path.join(home, "real-project");
      await Fsp.mkdir(outside, { recursive: true });
      await Fsp.writeFile(Path.join(outside, "keep"), "keep");
      await Fsp.mkdir(Path.join(root, "runtime"), { recursive: true });
      await Fsp.mkdir(Path.join(root, "worktrees"), { recursive: true });
      await Fsp.symlink(outside, Path.join(root, "caches"));
      const { stdout } = await execFile(
        "sh",
        ["-c", computerCleanupScript({ homeDirectory: home, workDirectory: root })],
        { timeout: 5000, env: { ...process.env, HOME: home } },
      );
      expect(stdout).toContain("removed\t" + Path.join(root, "runtime"));
      expect(stdout).toContain("refused\t" + Path.join(root, "caches"));
      expect(await Fsp.readFile(Path.join(outside, "keep"), "utf8")).toBe("keep");
      await Fsp.access(root);
    } finally {
      await Fsp.rm(home, { recursive: true, force: true });
    }
  });
});

it("refuses cleanup if the remote home changed or an ancestor is a symlink", async () => {
  const home = await Fsp.mkdtemp(Path.join(Os.tmpdir(), "workjet-cleanup-escape-"));
  try {
    const outside = Path.join(home, "outside");
    await Fsp.mkdir(outside);
    await Fsp.mkdir(Path.join(outside, "computer-work/runtime"), { recursive: true });
    const keep = Path.join(outside, "computer-work/runtime/keep");
    await Fsp.writeFile(keep, "keep");
    await Fsp.symlink(outside, Path.join(home, ".workjet"));
    const facts = { homeDirectory: home, workDirectory: Path.join(home, ".workjet/computer-work") };
    const run = (remoteHome: string) =>
      execFile("sh", ["-c", computerCleanupScript(facts)], {
        timeout: 5000,
        env: { ...process.env, HOME: remoteHome },
      });
    expect((await run(home)).stdout).not.toContain("removed");
    expect((await run(home + "-changed")).stdout).toContain("refused");
    expect(await Fsp.readFile(keep, "utf8")).toBe("keep");
  } finally {
    await Fsp.rm(home, { recursive: true, force: true });
  }
});
