#!/usr/bin/env node
/** Package the server with native dependencies built for this CI host. */
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";
import { SSH_NODE_VERSION } from "../packages/ssh/src/remoteNode.ts";
import { prepareProviderGatewayHost } from "./lib/prepare-provider-gateway-host.ts";
import * as Effect from "effect/Effect";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";

const program = Effect.gen(function* () {
  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;
  yield* Effect.tryPromise(async () => {
    if (process.versions.node !== SSH_NODE_VERSION)
      throw new Error(
        `Build the portable server with Node ${SSH_NODE_VERSION} to match its native dependencies.`,
      );

    const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
    const output = NodePath.resolve(
      process.argv[2] ?? NodePath.join(root, "apps/desktop/resources/ssh-servers"),
    );
    const platform = `${hostPlatform}-${hostArchitecture}`;
    if (!["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].includes(platform))
      throw new Error(`Unsupported SSH server build: ${platform}`);
    const manifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(root, "apps/server/package.json"), "utf8"),
    );
    const stage = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-ssh-package-"));
    try {
      const destination = NodePath.join(stage, "package");
      await NodeFSP.mkdir(destination);
      await NodeFSP.cp(
        NodePath.join(root, "apps/server/dist"),
        NodePath.join(destination, "dist"),
        {
          recursive: true,
          dereference: true,
        },
      );
      const monitorTarget = NodePath.join(stage, "resource-monitor-target");
      await NodeFSP.mkdir(NodePath.join(destination, "legal/provider-gateway"), { recursive: true });
      for (const name of ["LICENSE", "NOTICE.md", "LICENSE_POLICY.md"]) {
        await NodeFSP.cp(NodePath.join(root, name), NodePath.join(destination, "legal", name));
      }
      for (const name of ["LICENSE.MIT", "LICENSE.AGPL-3.0-only", "LICENSE.upstream"]) {
        await NodeFSP.cp(
          NodePath.join(root, "native/provider-gateway", name),
          NodePath.join(destination, "legal/provider-gateway", name),
        );
      }
      NodeChildProcess.execFileSync(
        "cargo",
        [
          "build",
          "--release",
          "--locked",
          "--manifest-path",
          NodePath.join(root, "native/resource-monitor/Cargo.toml"),
        ],
        {
          stdio: "inherit",
          env: { ...process.env, CARGO_TARGET_DIR: monitorTarget },
        },
      );
      await NodeFSP.mkdir(NodePath.join(destination, "dist/resource-monitor"), { recursive: true });
      await NodeFSP.cp(
        NodePath.join(monitorTarget, "release/t3-resource-monitor"),
        NodePath.join(destination, "dist/resource-monitor/t3-resource-monitor"),
      );
      const pin = JSON.parse(
        await NodeFSP.readFile(
          NodePath.join(root, "apps/desktop/resources/provider-gateway/host-release.pin.json"),
          "utf8",
        ),
      );
      const host = await prepareProviderGatewayHost({
        repoRoot: root,
        platform: hostPlatform === "darwin" ? "mac" : "linux",
        arch: hostArchitecture,
        dependencyRoot: NodePath.join(stage, "gateway-download"),
        pin,
      });
      const artifact = pin.release.artifacts.find(
        (item) => item.os === hostPlatform && item.arch === hostArchitecture,
      );
      if (!artifact) throw new Error(`Missing provider gateway for ${platform}`);
      await NodeFSP.cp(
        NodePath.join(host.installPath, artifact.fileName),
        NodePath.join(destination, "dist/workjet-provider-gateway-host"),
      );
      await NodeFSP.writeFile(
        NodePath.join(destination, "package.json"),
        JSON.stringify(
          {
            name: "@workjet/ssh-server",
            private: true,
            version: manifest.version,
            type: "module",
            engines: manifest.engines,
            dependencies: {
              "node-pty": manifest.dependencies["node-pty"],
              "@ff-labs/fff-node": manifest.dependencies["@ff-labs/fff-node"],
            },
          },
          null,
          2,
        ),
      );
      NodeChildProcess.execFileSync(
        hostPlatform === "win32" ? "npm.cmd" : "npm",
        ["install", "--omit=dev", "--no-audit", "--no-fund"],
        { cwd: destination, stdio: "inherit" },
      );
      NodeChildProcess.execFileSync(
        process.execPath,
        [NodePath.join(destination, "dist/bin.mjs"), "--help"],
        {
          cwd: destination,
          stdio: "inherit",
          timeout: 60_000,
        },
      );
      // Loading the module alone is insufficient: prove the shipped PTY can spawn.
      NodeChildProcess.execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import pty from 'node-pty'; const term=pty.spawn('/bin/sh',['-c','printf workjet-pty-ok']);let output='';term.onData(data=>output+=data);term.onExit(({exitCode})=>process.exit(exitCode===0&&output.includes('workjet-pty-ok')?0:1));setTimeout(()=>process.exit(2),5000).unref();`,
        ],
        { cwd: destination, stdio: "inherit", timeout: 10_000 },
      );
      await NodeFSP.mkdir(output, { recursive: true });
      const filename = `workjet-server-${platform}.tgz`;
      NodeChildProcess.execFileSync(
        "tar",
        ["-czf", NodePath.join(output, filename), "-C", stage, "package"],
        {
          stdio: "inherit",
          env: { ...process.env, COPYFILE_DISABLE: "1" },
        },
      );
      const digest = NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(NodePath.join(output, filename)))
        .digest("hex");
      await NodeFSP.writeFile(
        NodePath.join(output, `${filename}.sha256`),
        `${digest}  ${filename}\n`,
      );
      console.log(`Packaged verified SSH server: ${filename}`);
    } finally {
      await NodeFSP.rm(stage, { recursive: true, force: true });
    }
  });
});
NodeRuntime.runMain(program);
