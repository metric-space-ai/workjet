// @effect-diagnostics nodeBuiltinImport:off -- exercises the generated shell against an isolated filesystem.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it, expect } from "vite-plus/test";
import { buildManagedRemoteNodeScript, SSH_NODE_VERSION } from "./remoteNode.ts";

function fixture(run: (root: string, bin: string) => void) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workjet-node-bootstrap-"));
  const bin = NodePath.join(root, "tools");
  NodeFS.mkdirSync(bin);
  NodeFS.writeFileSync(
    NodePath.join(bin, "uname"),
    '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n',
    { mode: 0o755 },
  );
  try {
    run(root, bin);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

function execute(root: string, bin: string, action = "install_workjet_node") {
  return NodeChildProcess.spawnSync("/bin/sh", ["-s"], {
    input: `${buildManagedRemoteNodeScript()}\n${action}\n`,
    env: { ...process.env, HOME: root, PATH: `${bin}:/usr/bin:/bin` },
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("private SSH Node bootstrap", () => {
  it("produces valid POSIX shell", () => {
    NodeChildProcess.execFileSync("/bin/sh", ["-n"], { input: buildManagedRemoteNodeScript() });
  });

  it("reuses a compatible private runtime without downloading or changing the system runtime", () => {
    fixture((root, bin) => {
      const managed = NodePath.join(
        root,
        ".workjet/runtime/node",
        `node-v${SSH_NODE_VERSION}-linux-x64`,
        "bin",
      );
      NodeFS.mkdirSync(managed, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(managed, "node"),
        `#!/bin/sh\necho v${SSH_NODE_VERSION}\n`,
        {
          mode: 0o755,
        },
      );
      NodeFS.writeFileSync(NodePath.join(bin, "curl"), "#!/bin/sh\nexit 91\n", { mode: 0o755 });
      const result = execute(root, bin);
      expect(result.status).toBe(0);
      expect(NodeFS.existsSync(NodePath.join(root, "bin/node"))).toBe(false);
      expect(NodeFS.readdirSync(NodePath.join(root, ".workjet/runtime/node"))).toEqual([
        `node-v${SSH_NODE_VERSION}-linux-x64`,
      ]);
    });
  });

  it("rejects a corrupted download before extraction and removes its staging directory", () => {
    fixture((root, bin) => {
      NodeFS.writeFileSync(
        NodePath.join(bin, "curl"),
        '#!/bin/sh\nfor argument do output="$argument"; done\nprintf corrupt > "$output"\n',
        { mode: 0o755 },
      );
      NodeFS.writeFileSync(
        NodePath.join(bin, "tar"),
        '#!/bin/sh\ntouch "$HOME/extracted"\nexit 92\n',
        {
          mode: 0o755,
        },
      );
      const result = execute(root, bin);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("checksum verification failed");
      expect(NodeFS.existsSync(NodePath.join(root, "extracted"))).toBe(false);
      expect(NodeFS.readdirSync(NodePath.join(root, ".workjet/runtime/node"))).toEqual([]);
    });
  });

  it("fails before downloading on an unsupported host", () => {
    fixture((root, bin) => {
      NodeFS.writeFileSync(NodePath.join(bin, "uname"), "#!/bin/sh\necho unsupported\n", {
        mode: 0o755,
      });
      const result = execute(root, bin);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unavailable for this SSH platform");
      expect(NodeFS.existsSync(NodePath.join(root, ".workjet"))).toBe(false);
    });
  });
});
