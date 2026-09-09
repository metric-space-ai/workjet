// @effect-diagnostics nodeBuiltinImport:off -- executes the remote shell in an isolated fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, it, expect } from "vite-plus/test";
import { REMOTE_PROCESS_START_SCRIPT } from "./remoteProcess.ts";

function runFixture(options: Record<string, string> = {}) {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workjet-remote-process-"));
  const bin = NodePath.join(root, "tools");
  NodeFS.mkdirSync(bin);
  const writeProgram = (name: string, body: string) =>
    NodeFS.writeFileSync(NodePath.join(bin, name), `#!${process.execPath}\n${body}\n`, {
      mode: 0o755,
    });
  writeProgram(
    "systemctl",
    `const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("show-environment")) process.exit(process.env.TEST_NO_MANAGER === "1" ? 1 : 0);
if (args.includes("show")) console.log(process.env.TEST_MAIN_PID ?? "12345");
if (args.includes("stop")) fs.writeFileSync(process.env.TEST_ROOT + "/stopped.json", JSON.stringify(args));`,
  );
  writeProgram(
    "systemd-run",
    `const fs = require("node:fs");
const cp = require("node:child_process");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.TEST_ROOT + "/service.json", JSON.stringify(args));
if (process.env.TEST_START_FAIL === "1") process.exit(1);
const command = args.slice(args.indexOf("--") + 1);
const child = cp.spawnSync(command[0], command.slice(1), { stdio: "inherit" });
process.exit(child.status ?? 1);`,
  );
  writeProgram(
    "nohup",
    `const fs = require("node:fs");
const cp = require("node:child_process");
fs.writeFileSync(process.env.TEST_ROOT + "/nohup", "used");
const child = cp.spawnSync(process.argv[2], process.argv.slice(3), { stdio: "inherit" });
process.exit(child.status ?? 1);`,
  );
  writeProgram(
    "backend with spaces",
    `require("node:fs").writeFileSync(process.env.TEST_ROOT + "/backend.json", JSON.stringify({ args: process.argv.slice(2), noBrowser: process.env.WORKJET_NO_BROWSER, path: process.env.PATH }));
console.log("fixture backend output");`,
  );
  const read = (name: string) => {
    const file = NodePath.join(root, name);
    return NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : null;
  };
  try {
    const result = NodeChildProcess.spawnSync("/bin/sh", ["-s"], {
      input: `set -eu
${REMOTE_PROCESS_START_SCRIPT}
STATE_KEY=fixture
LOG_FILE="$TEST_ROOT/backend output.log"
start_remote_process env WORKJET_NO_BROWSER=1 "$TEST_ROOT/tools/backend with spaces" serve --base-dir "$TEST_ROOT/home with spaces"
printf 'pid=%s\\n' "$REMOTE_PID"
if [ "\${TEST_NO_MANAGER:-}" = "1" ]; then wait "$REMOTE_PID"; fi
`,
      env: { ...process.env, ...options, TEST_ROOT: root, PATH: `${bin}:/usr/bin:/bin` },
      encoding: "utf8",
      timeout: 10_000,
    });
    return {
      result,
      root,
      service: read("service.json"),
      backend: read("backend.json"),
      stopped: read("stopped.json"),
      nohup: read("nohup"),
      log: read("backend output.log"),
    };
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

describe("remote backend process ownership", () => {
  it("produces valid POSIX shell", () => {
    NodeChildProcess.execFileSync("/bin/sh", ["-n"], { input: REMOTE_PROCESS_START_SCRIPT });
  });

  it("launches through the user manager, retaining quoted arguments, logs, and the service PID", () => {
    const actual = runFixture();
    expect(actual.result.status).toBe(0);
    expect(actual.result.stdout).toBe("pid=12345\n");
    expect(actual.nohup).toBeNull();
    const args = JSON.parse(actual.service!);
    expect(args).toContain("--user");
    expect(args).toContain("--collect");
    expect(args[args.indexOf("--unit") + 1]).toMatch(/^workjet-ssh-fixture-\d+\.service$/);
    const backend = JSON.parse(actual.backend!);
    expect(backend.args).toEqual(["serve", "--base-dir", `${actual.root}/home with spaces`]);
    expect(backend.noBrowser).toBe("1");
    expect(backend.path).toBe(`${actual.root}/tools:/usr/bin:/bin`);
    expect(actual.log).toBe("fixture backend output\n");
  });

  it("retains the portable launch path when no user manager is available", () => {
    const actual = runFixture({ TEST_NO_MANAGER: "1" });
    expect(actual.result.status).toBe(0);
    expect(actual.service).toBeNull();
    expect(actual.nohup).toBe("used");
    expect(JSON.parse(actual.backend!).args[0]).toBe("serve");
    expect(actual.log).toBe("fixture backend output\n");
  });

  it("reports service startup failure without retrying under the dying SSH session", () => {
    const actual = runFixture({ TEST_START_FAIL: "1" });
    expect(actual.result.status).toBe(1);
    expect(actual.result.stderr).toContain("Could not start the Workjet backend as a user service");
    expect(actual.nohup).toBeNull();
    expect(actual.backend).toBeNull();
  });

  it.each(["0", "invalid", ""])(
    "rejects an untrackable service PID %j and stops its own unit",
    (pid) => {
      const actual = runFixture({ TEST_MAIN_PID: pid });
      expect(actual.result.status).toBe(1);
      expect(actual.result.stderr).toContain("exited before its process could be tracked");
      const start = JSON.parse(actual.service!);
      expect(JSON.parse(actual.stopped!)).toEqual([
        "--user",
        "stop",
        start[start.indexOf("--unit") + 1],
      ]);
      expect(actual.nohup).toBeNull();
      expect(actual.result.stdout).not.toContain("pid=");
    },
  );
});
