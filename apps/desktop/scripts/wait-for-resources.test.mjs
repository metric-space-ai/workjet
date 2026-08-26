import assert from "node:assert/strict";
import * as NodeFS from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, it } from "node:test";

import { waitForResources } from "./wait-for-resources.mjs";

const cleanupCallbacks = [];

afterEach(async () => {
  await Promise.all(cleanupCallbacks.splice(0).map((cleanup) => cleanup()));
});

describe("waitForResources", () => {
  it("does not resolve during a clean build gap", async () => {
    const root = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-restart-"));
    cleanupCallbacks.push(() => NodeFS.rm(root, { recursive: true, force: true }));

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
    assert.equal(typeof address, "object");
    assert.notEqual(address, null);

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
    assert.equal(resolved, false);

    await NodeFS.mkdir(NodePath.join(root, "dist-electron"), { recursive: true });
    await NodeFS.mkdir(NodePath.join(root, "server"), { recursive: true });
    await Promise.all([
      NodeFS.writeFile(NodePath.join(root, "dist-electron/main.cjs"), ""),
      NodeFS.writeFile(NodePath.join(root, "dist-electron/preload.cjs"), ""),
      NodeFS.writeFile(NodePath.join(root, "server/bin.mjs"), ""),
    ]);

    await readiness;
    assert.equal(resolved, true);
  });

  it("rechecks desktop resources before a watched restart", async () => {
    const source = await NodeFS.readFile(new URL("./dev-electron.mjs", import.meta.url), "utf8");
    const restartBlock = source.slice(
      source.indexOf("restartQueue = restartQueue"),
      source.indexOf("function startWatchers"),
    );

    assert.match(
      restartBlock,
      /await stopApp\(\);[\s\S]*await waitForDesktopDevResources\(\);[\s\S]*startApp\(\);/,
    );
  });
});
