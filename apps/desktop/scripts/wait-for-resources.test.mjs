import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { waitForResources } from "./wait-for-resources.mjs";

const cleanupCallbacks = [];

NodeTest.afterEach(async () => {
  await Promise.all(cleanupCallbacks.splice(0).map((cleanup) => cleanup()));
});

NodeTest.describe("waitForResources", () => {
  NodeTest.it("does not resolve during a clean build gap", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-restart-"));
    cleanupCallbacks.push(() => NodeFSP.rm(root, { recursive: true, force: true }));

    const server = NodeNet.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanupCallbacks.push(
      () =>
        new Promise((resolve) => {
          server.close(resolve);
        }),
    );

    const address = server.address();
    NodeAssert.equal(typeof address, "object");
    NodeAssert.notEqual(address, null);

    let resolved = false;
    const readiness = waitForResources({
      baseDir: root,
      files: ["dist-electron/main.cjs", "dist-electron/preload.cjs", "server/bin.mjs"],
      tcpHost: "127.0.0.1",
      tcpPort: address.port,
      intervalMs: 10,
      timeoutMs: 2_000,
    }).then(() => {
      resolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    NodeAssert.equal(resolved, false);

    await NodeFSP.mkdir(NodePath.join(root, "dist-electron"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(root, "server"), { recursive: true });
    await Promise.all([
      NodeFSP.writeFile(NodePath.join(root, "dist-electron/main.cjs"), ""),
      NodeFSP.writeFile(NodePath.join(root, "dist-electron/preload.cjs"), ""),
      NodeFSP.writeFile(NodePath.join(root, "server/bin.mjs"), ""),
    ]);

    await readiness;
    NodeAssert.equal(resolved, true);
  });

  NodeTest.it("rechecks desktop resources before a watched restart", async () => {
    const source = await NodeFSP.readFile(new URL("./dev-electron.mjs", import.meta.url), "utf8");
    const restartBlock = source.slice(
      source.indexOf("restartQueue = restartQueue"),
      source.indexOf("function startWatchers"),
    );

    NodeAssert.match(
      restartBlock,
      /await stopApp\(\);[\s\S]*await waitForDesktopDevResources\(\);[\s\S]*startApp\(\);/,
    );
  });
});
