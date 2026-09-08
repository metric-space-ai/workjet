#!/usr/bin/env node
/** Package the server with native dependencies built for this CI host. */
import { readFile, writeFile, mkdir, cp, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { SSH_NODE_VERSION } from "../packages/ssh/src/remoteNode.ts";
if (process.versions.node !== SSH_NODE_VERSION)
  throw new Error(
    `Build the portable server with Node ${SSH_NODE_VERSION} to match its native dependencies.`,
  );

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? join(root, "apps/desktop/resources/ssh-servers"));
const platform = `${process.platform}-${process.arch}`;
if (!["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"].includes(platform))
  throw new Error(`Unsupported SSH server build: ${platform}`);
const manifest = JSON.parse(await readFile(join(root, "apps/server/package.json"), "utf8"));
const stage = await mkdtemp(join(tmpdir(), "workjet-ssh-package-"));
try {
  const destination = join(stage, "package");
  await mkdir(destination);
  await cp(join(root, "apps/server/dist"), join(destination, "dist"), {
    recursive: true,
    dereference: true,
  });
  await writeFile(
    join(destination, "package.json"),
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
  execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--omit=dev", "--no-audit", "--no-fund"],
    { cwd: destination, stdio: "inherit" },
  );
  execFileSync(process.execPath, [join(destination, "dist/bin.mjs"), "--help"], {
    cwd: destination,
    stdio: "inherit",
    timeout: 60_000,
  });
  // Loading the module alone is insufficient: prove the shipped PTY can spawn.
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import pty from 'node-pty'; const term=pty.spawn('/bin/sh',['-c','printf workjet-pty-ok']);let output='';term.onData(data=>output+=data);term.onExit(({exitCode})=>process.exit(exitCode===0&&output.includes('workjet-pty-ok')?0:1));setTimeout(()=>process.exit(2),5000).unref();`,
    ],
    { cwd: destination, stdio: "inherit", timeout: 10_000 },
  );
  await mkdir(output, { recursive: true });
  const filename = `workjet-server-${platform}.tgz`;
  execFileSync("tar", ["-czf", join(output, filename), "-C", stage, "package"], {
    stdio: "inherit",
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const digest = createHash("sha256")
    .update(await readFile(join(output, filename)))
    .digest("hex");
  await writeFile(join(output, `${filename}.sha256`), `${digest}  ${filename}\n`);
  console.log(`Packaged verified SSH server: ${filename}`);
} finally {
  await rm(stage, { recursive: true, force: true });
}
