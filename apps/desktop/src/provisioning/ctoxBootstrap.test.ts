// @effect-diagnostics nodeBuiltinImport:off -- executes the installer decision in an isolated shell fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { it, expect } from "vite-plus/test";
import { reuseHealthyCtox } from "./ctoxBootstrap.ts";

it.each([
  ['{"running":true}', false],
  ['{"running":false}', true],
  ["invalid status", true],
])("checks actual daemon status before reusing an installation: %s", (status, installs) => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workjet-ctox-reuse-"));
  try {
    const bin = NodePath.join(root, "bin");
    NodeFS.mkdirSync(bin);
    NodeFS.writeFileSync(
      NodePath.join(bin, "ctox"),
      `#!/bin/sh\ncase "$1" in status) printf '%s' '${status}' ;; *) exit 91 ;; esac\n`,
      { mode: 0o755 },
    );
    const script = `set -eu\ntmp='${root}'\n` + reuseHealthyCtox('touch "$tmp/install-called"');
    const result = NodeChildProcess.spawnSync("/bin/sh", ["-s"], {
      input: script,
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(root, "install-called"))).toBe(installs);
    if (!installs) expect(result.stdout).toContain("Existing CTOX service verified");
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
