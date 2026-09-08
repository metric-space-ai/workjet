// @effect-diagnostics nodeBuiltinImport:off -- exercises the generated shell against an isolated filesystem.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vite-plus/test";
import { buildManagedRemoteNodeScript, SSH_NODE_VERSION } from "./remoteNode.ts";

function fixture(run: (root: string, bin: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "workjet-node-bootstrap-"));
  const bin = join(root, "tools");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "uname"),
    '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n',
    { mode: 0o755 },
  );
  try {
    run(root, bin);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function execute(root: string, bin: string, action = "install_workjet_node") {
  return spawnSync("/bin/sh", ["-s"], {
    input: `${buildManagedRemoteNodeScript()}\n${action}\n`,
    env: { ...process.env, HOME: root, PATH: `${bin}:/usr/bin:/bin` },
    encoding: "utf8",
    timeout: 5_000,
  });
}

describe("private SSH Node bootstrap", () => {
  it("produces valid POSIX shell", () => {
    execFileSync("/bin/sh", ["-n"], { input: buildManagedRemoteNodeScript() });
  });

  it("reuses a compatible private runtime without downloading or changing the system runtime", () => {
    fixture((root, bin) => {
      const managed = join(
        root,
        ".workjet/runtime/node",
        `node-v${SSH_NODE_VERSION}-linux-x64`,
        "bin",
      );
      mkdirSync(managed, { recursive: true });
      writeFileSync(join(managed, "node"), `#!/bin/sh\necho v${SSH_NODE_VERSION}\n`, {
        mode: 0o755,
      });
      writeFileSync(join(bin, "curl"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
      const result = execute(root, bin);
      expect(result.status).toBe(0);
      expect(existsSync(join(root, "bin/node"))).toBe(false);
      expect(readdirSync(join(root, ".workjet/runtime/node"))).toEqual([
        `node-v${SSH_NODE_VERSION}-linux-x64`,
      ]);
    });
  });

  it("rejects a corrupted download before extraction and removes its staging directory", () => {
    fixture((root, bin) => {
      writeFileSync(
        join(bin, "curl"),
        '#!/bin/sh\nfor argument do output="$argument"; done\nprintf corrupt > "$output"\n',
        { mode: 0o755 },
      );
      writeFileSync(join(bin, "tar"), '#!/bin/sh\ntouch "$HOME/extracted"\nexit 92\n', {
        mode: 0o755,
      });
      const result = execute(root, bin);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("checksum verification failed");
      expect(existsSync(join(root, "extracted"))).toBe(false);
      expect(readdirSync(join(root, ".workjet/runtime/node"))).toEqual([]);
    });
  });

  it("fails before downloading on an unsupported host", () => {
    fixture((root, bin) => {
      writeFileSync(join(bin, "uname"), "#!/bin/sh\necho unsupported\n", { mode: 0o755 });
      const result = execute(root, bin);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unavailable for this SSH platform");
      expect(existsSync(join(root, ".workjet"))).toBe(false);
    });
  });
});
