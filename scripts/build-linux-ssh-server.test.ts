import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";
import { archiveServerDist } from "./lib/build-linux-ssh-server.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

it.skipIf(process.platform === "win32")(
  "ships linked client assets with the server archive",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-archive-test-"));
    try {
      const dist = NodePath.join(root, "server-dist");
      const web = NodePath.join(root, "web-dist");
      const unpacked = NodePath.join(root, "unpacked");
      await Promise.all([dist, web, unpacked].map((path) => NodeFSP.mkdir(path)));
      await NodeFSP.writeFile(NodePath.join(dist, "bin.js"), "server entry");
      await NodeFSP.writeFile(NodePath.join(web, "index.html"), "Workjet client");
      await NodeFSP.symlink(web, NodePath.join(dist, "client"), "dir");
      const archive = NodePath.join(root, "server.tgz");
      await archiveServerDist(archive, dist);
      // Remove the original target so a dangling host-local link cannot pass.
      await NodeFSP.rm(web, { recursive: true });
      await execFile("tar", ["-xzf", archive, "-C", unpacked]);
      expect((await NodeFSP.lstat(NodePath.join(unpacked, "client"))).isDirectory()).toBe(true);
      expect(await NodeFSP.readFile(NodePath.join(unpacked, "client", "index.html"), "utf8")).toBe(
        "Workjet client",
      );
      expect(await NodeFSP.readFile(NodePath.join(unpacked, "bin.js"), "utf8")).toBe(
        "server entry",
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);
