// @effect-diagnostics nodeBuiltinImport:off -- executes the installer decision in an isolated shell fixture.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it, expect } from "vite-plus/test";
import { reuseHealthyCtox } from "./ctoxBootstrap.ts";

it.each([
  ['{"running":true}', false],
  ['{"running":false}', true],
  ["invalid status", true],
])("checks actual daemon status before reusing an installation: %s", (status, installs) => {
  const root = mkdtempSync(join(tmpdir(), "workjet-ctox-reuse-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "ctox"),
      `#!/bin/sh\ncase "$1" in status) printf '%s' '${status}' ;; *) exit 91 ;; esac\n`,
      { mode: 0o755 },
    );
    const script = `set -eu\ntmp='${root}'\n` + reuseHealthyCtox('touch "$tmp/install-called"');
    const result = spawnSync("/bin/sh", ["-s"], {
      input: script,
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(root, "install-called"))).toBe(installs);
    if (!installs) expect(result.stdout).toContain("Existing CTOX service verified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
