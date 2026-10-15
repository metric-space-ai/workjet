import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import { afterEach, assert, describe, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const { afterPack, installLinuxLauncher } = require("./linux-launcher-after-pack.cjs");

const LAUNCHER_SOURCE_PATH = NodePath.join(import.meta.dirname, "linux-launcher.sh");
const SEAM_LINES = ["PROC_ROOT=/proc", "DEV_ROOT=/dev", "SANDBOX_ROOT_UID=0"];
const USER_ARGS = ["workjet://auth/callback?code=secret", "--enable-logging"];

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workjet-linux-launcher-"));
  temporaryRoots.push(root);
  return root;
}

function writeFile(path, content, mode) {
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, content);
  if (mode !== undefined) NodeFS.chmodSync(path, mode);
}

/**
 * Lays out an installed package (launcher, fake Electron binary that echoes its
 * arguments, chrome-sandbox) plus a fake /proc and /dev. The launcher is the
 * shipped script with only its three test-seam lines pointed at the fake root;
 * the current user stands in for root as the chrome-sandbox owner.
 */
function makeInstall({
  userNamespaces = true,
  unprivilegedUsernsClone,
  maxUserNamespaces,
  sandboxMode = 0o755,
  tracerPid = 0,
  renderNode = false,
} = {}) {
  const root = makeRoot();
  const proc = NodePath.join(root, "proc");
  const dev = NodePath.join(root, "dev");
  const appDir = NodePath.join(root, "opt", "Workjet");
  const launcher = NodePath.join(appDir, "workjet");

  let script = NodeFS.readFileSync(LAUNCHER_SOURCE_PATH, "utf8");
  const replacements = {
    "PROC_ROOT=/proc": `PROC_ROOT='${proc}'`,
    "DEV_ROOT=/dev": `DEV_ROOT='${dev}'`,
    "SANDBOX_ROOT_UID=0": `SANDBOX_ROOT_UID=${process.getuid()}`,
  };
  for (const [seam, replacement] of Object.entries(replacements)) {
    script = script.replace(new RegExp(`^${seam}$`, "m"), replacement);
  }
  writeFile(launcher, script, 0o755);
  writeFile(
    `${launcher}-bin`,
    '#!/bin/sh\nfor arg in "$@"; do printf \'%s\\n\' "$arg"; done\n',
    0o755,
  );
  writeFile(NodePath.join(appDir, "chrome-sandbox"), "", sandboxMode);

  writeFile(NodePath.join(proc, "self", "status"), `Name:\tsh\nTracerPid:\t${tracerPid}\n`);
  if (userNamespaces) {
    writeFile(NodePath.join(proc, "self", "ns", "user"), "");
    writeFile(NodePath.join(proc, "self", "uid_map"), "0 0 4294967295\n");
  }
  if (unprivilegedUsernsClone !== undefined) {
    writeFile(
      NodePath.join(proc, "sys", "kernel", "unprivileged_userns_clone"),
      `${unprivilegedUsernsClone}\n`,
    );
  }
  if (maxUserNamespaces !== undefined) {
    writeFile(NodePath.join(proc, "sys", "user", "max_user_namespaces"), `${maxUserNamespaces}\n`);
  }
  if (renderNode) {
    writeFile(NodePath.join(dev, "dri", "renderD128"), "", 0o666);
  }
  return launcher;
}

function launch(launcher, args = USER_ARGS) {
  const result = NodeChildProcess.spawnSync("sh", [launcher, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return {
    argv: result.stdout.split("\n").filter((line) => line.length > 0),
    stderr: result.stderr,
  };
}

describe("linux-launcher.sh", () => {
  it("keeps exactly one copy of every test seam in the shipped script", () => {
    const lines = NodeFS.readFileSync(LAUNCHER_SOURCE_PATH, "utf8").split("\n");
    for (const seam of SEAM_LINES) {
      assert.equal(lines.filter((line) => line === seam).length, 1, seam);
    }
  });

  it("passes arguments through unchanged when the kernel offers user namespaces", () => {
    const { argv, stderr } = launch(makeInstall());
    assert.deepStrictEqual(argv, USER_ARGS);
    assert.notInclude(argv, "--no-sandbox");
    assert.equal(stderr, "");
  });

  it("keeps the sandbox for a traced process when user namespaces exist", () => {
    const { argv } = launch(makeInstall({ tracerPid: 4242, sandboxMode: 0o4755 }));
    assert.deepStrictEqual(argv, USER_ARGS);
  });

  it("keeps the setuid sandbox when user namespaces are missing but the helper is setuid-root", () => {
    const { argv } = launch(makeInstall({ userNamespaces: false, sandboxMode: 0o4755 }));
    assert.deepStrictEqual(argv, USER_ARGS);
  });

  it("starts without sandbox, zygote and GPU under PRoot (no uid_map, traced, no DRM access)", () => {
    const { argv, stderr } = launch(
      makeInstall({ userNamespaces: false, sandboxMode: 0o4755, tracerPid: 4242 }),
    );
    assert.deepStrictEqual(argv, ["--no-sandbox", "--no-zygote", "--disable-gpu", ...USER_ARGS]);
    assert.include(stderr, "Chromium sandbox unavailable");
    assert.notInclude(stderr, "secret");
  });

  it("keeps the GPU when a render node is accessible", () => {
    const { argv } = launch(
      makeInstall({
        userNamespaces: false,
        sandboxMode: 0o4755,
        tracerPid: 4242,
        renderNode: true,
      }),
    );
    assert.deepStrictEqual(argv, ["--no-sandbox", "--no-zygote", ...USER_ARGS]);
  });

  it("falls back when user namespaces are switched off and the helper is not setuid", () => {
    for (const knobs of [{ unprivilegedUsernsClone: 0 }, { maxUserNamespaces: 0 }]) {
      const { argv } = launch(makeInstall({ ...knobs, renderNode: true }));
      assert.deepStrictEqual(argv, ["--no-sandbox", "--no-zygote", ...USER_ARGS]);
    }
  });

  it("keeps the sandbox when the user namespace knobs are enabled", () => {
    const { argv } = launch(makeInstall({ unprivilegedUsernsClone: 1, maxUserNamespaces: 63432 }));
    assert.deepStrictEqual(argv, USER_ARGS);
  });
});

describe("linux-launcher-after-pack.cjs", () => {
  it("moves Electron to <executable>-bin and installs the launcher in its place", () => {
    const appOutDir = makeRoot();
    writeFile(NodePath.join(appOutDir, "workjet"), "ELF", 0o755);

    installLinuxLauncher(appOutDir, "workjet");

    assert.equal(NodeFS.readFileSync(NodePath.join(appOutDir, "workjet-bin"), "utf8"), "ELF");
    assert.equal(
      NodeFS.readFileSync(NodePath.join(appOutDir, "workjet"), "utf8"),
      NodeFS.readFileSync(LAUNCHER_SOURCE_PATH, "utf8"),
    );
    assert.equal(NodeFS.statSync(NodePath.join(appOutDir, "workjet")).mode & 0o777, 0o755);
    assert.throws(() => installLinuxLauncher(appOutDir, "workjet"), /already installed/);
  });

  it("leaves non-Linux packages untouched", async () => {
    const appOutDir = makeRoot();
    writeFile(NodePath.join(appOutDir, "Workjet.exe"), "PE");

    await afterPack({
      electronPlatformName: "win32",
      appOutDir,
      packager: { executableName: "Workjet" },
    });

    assert.deepStrictEqual(NodeFS.readdirSync(appOutDir), ["Workjet.exe"]);
  });
});
