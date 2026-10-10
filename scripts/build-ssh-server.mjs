#!/usr/bin/env node
/** Package the server with native dependencies built for this CI host. */
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";
import { parse as parseYaml } from "yaml";
import { SSH_NODE_VERSION } from "../packages/ssh/src/remoteNode.ts";
import { prepareProviderGatewayHost } from "./lib/prepare-provider-gateway-host.ts";
import { prepareDiagnosticProviderGatewayHost } from "./lib/provider-gateway-host-diagnostic.ts";
import { parseSshServerBuildArguments } from "./lib/ssh-server-build-arguments.ts";
import { preparePortableNode } from "./lib/prepare-portable-node.ts";
import { githubSshBuildIdentity } from "./lib/github-ssh-build-receipt.ts";
import * as Effect from "effect/Effect";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { HostProcessPlatform, HostProcessArchitecture } from "@workjet/shared/hostProcess";

const program = Effect.gen(function* () {
  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;
  yield* Effect.tryPromise(async () => {
    if (process.versions.node !== SSH_NODE_VERSION)
      throw new Error(
        `Build the portable server with Node ${SSH_NODE_VERSION} to match its native dependencies.`,
      );

    const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
    const ciBuild = githubSshBuildIdentity();
    const source = ciBuild
      ? NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim()
      : undefined;
    const options = parseSshServerBuildArguments(process.argv.slice(2));
    const output = NodePath.resolve(
      options.output ?? NodePath.join(root, "apps/desktop/resources/ssh-servers"),
    );
    const platform = `${hostPlatform}-${hostArchitecture}`;
    if (!["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].includes(platform))
      throw new Error(`Unsupported SSH server build: ${platform}`);
    const manifest = JSON.parse(
      await NodeFSP.readFile(NodePath.join(root, "apps/server/package.json"), "utf8"),
    );
    const lock = parseYaml(await NodeFSP.readFile(NodePath.join(root, "pnpm-lock.yaml"), "utf8"));
    const lockSha256 = NodeCrypto.createHash("sha256")
      .update(await NodeFSP.readFile(NodePath.join(root, "pnpm-lock.yaml")))
      .digest("hex");
    const nativeDependencies = Object.fromEntries(
      ["node-pty", "@ff-labs/fff-node"].map((name) => {
        const version = lock.importers["apps/server"].dependencies[name].version.split("(")[0];
        if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/u.test(version))
          throw new Error(`Missing locked native dependency: ${name}`);
        return [name, version];
      }),
    );
    const stage = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-ssh-package-"));
    try {
      const destination = NodePath.join(stage, "package");
      await NodeFSP.mkdir(destination);
      const portableNode = await preparePortableNode({
        destination: NodePath.join(destination, "runtime", "node"),
        platform: hostPlatform,
        arch: hostArchitecture,
      });
      await NodeFSP.cp(
        NodePath.join(root, "apps/server/dist"),
        NodePath.join(destination, "dist"),
        {
          recursive: true,
          dereference: true,
        },
      );
      const monitorTarget = NodePath.join(stage, "resource-monitor-target");
      await NodeFSP.mkdir(NodePath.join(destination, "legal/provider-gateway"), {
        recursive: true,
      });
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
        NodePath.join(monitorTarget, "release/workjet-resource-monitor"),
        NodePath.join(destination, "dist/resource-monitor/workjet-resource-monitor"),
      );
      let hostPath;
      if (options.diagnosticProviderGatewayHost !== undefined) {
        const host = await prepareDiagnosticProviderGatewayHost({
          repoRoot: root,
          platform: hostPlatform === "darwin" ? "mac" : "linux",
          arch: hostArchitecture,
          manifestPath: options.diagnosticProviderGatewayHost,
          dependencyRoot: NodePath.join(stage, "gateway-diagnostic"),
        });
        hostPath = NodePath.join(host.installPath, host.manifest.artifact.fileName);
      } else {
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
        hostPath = NodePath.join(host.installPath, artifact.fileName);
      }
      await NodeFSP.cp(hostPath, NodePath.join(destination, "dist/workjet-provider-gateway-host"));
      await NodeFSP.writeFile(
        NodePath.join(destination, "package.json"),
        JSON.stringify(
          {
            name: "@workjet/ssh-server",
            private: true,
            version: manifest.version,
            type: "module",
            engines: manifest.engines,
            dependencies: nativeDependencies,
          },
          null,
          2,
        ),
      );
      NodeChildProcess.execFileSync(
        portableNode,
        [
          NodePath.join(destination, "runtime/node/lib/node_modules/npm/bin/npm-cli.js"),
          "install",
          "--omit=dev",
          "--no-audit",
          "--no-fund",
        ],
        {
          cwd: destination,
          stdio: "inherit",
          env: {
            ...process.env,
            PATH: `${NodePath.dirname(portableNode)}${NodePath.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );
      // node-pty 1.1.0 publishes Darwin's spawn-helper with mode 0644.
      // Preserve a working terminal in the archive (microsoft/node-pty#850).
      if (hostPlatform === "darwin") {
        await NodeFSP.chmod(
          NodePath.join(destination, "node_modules/node-pty/prebuilds", platform, "spawn-helper"),
          0o755,
        );
      }
      await NodeFSP.access(NodePath.join(destination, "dist/service-launcher.mjs"));
      NodeChildProcess.execFileSync(
        portableNode,
        [NodePath.join(destination, "dist/bin.mjs"), "--help"],
        {
          cwd: destination,
          stdio: "inherit",
          timeout: 60_000,
        },
      );
      // Loading the module alone is insufficient: prove the shipped PTY can spawn.
      NodeChildProcess.execFileSync(
        portableNode,
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
      if (ciBuild) {
        const currentSource = NodeChildProcess.execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim();
        const currentLock = NodeCrypto.createHash("sha256")
          .update(await NodeFSP.readFile(NodePath.join(root, "pnpm-lock.yaml")))
          .digest("hex");
        if (currentSource !== source || currentLock !== lockSha256)
          throw new Error("SSH server source changed during its CI build.");
        await NodeFSP.writeFile(
          NodePath.join(output, `${filename}.build-receipt.json`),
          JSON.stringify(
            {
              exit: 0,
              host: "github-actions",
              owner: ciBuild.owner,
              task: `ssh-server-${platform}`,
              github: ciBuild.github,
              workjetSourceCommit: source,
              workjetLockSha256: lockSha256,
              workjetArchiveSha256: digest,
            },
            null,
            2,
          ) + "\n",
        );
      }
    } finally {
      await NodeFSP.rm(stage, { recursive: true, force: true });
    }
  });
});
NodeRuntime.runMain(program);
