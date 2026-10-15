import { describe, expect, it } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off -- Runs the remote script locally against a throwaway HOME.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { AUTHORIZED_KEY_SCRIPT, findDesktopPublicKey } from "./MachineKeyInstall.ts";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyForWorkjetTestsOnly workjet";

function runScript(home: string, stdin: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn("sh", ["-c", AUTHORIZED_KEY_SCRIPT], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("close", resolve);
    child.stdin.end(stdin);
  });
}

describe("Schlüssel ins authorized_keys", () => {
  it("adds the key once, with 700/600 rights, and stays idempotent", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "wj-key-"));
    expect(await runScript(home, `${KEY}\n`)).toBe(0);
    expect(await runScript(home, `${KEY}\n`)).toBe(0);
    const file = NodePath.join(home, ".ssh", "authorized_keys");
    const lines = (await NodeFSP.readFile(file, "utf8")).split("\n").filter(Boolean);
    expect(lines).toEqual([KEY]);
    expect((await NodeFSP.stat(file)).mode & 0o777).toBe(0o600);
    expect((await NodeFSP.stat(NodePath.join(home, ".ssh"))).mode & 0o777).toBe(0o700);
  });

  it("keeps existing keys and refuses an empty key", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "wj-key-"));
    await NodeFSP.mkdir(NodePath.join(home, ".ssh"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(home, ".ssh", "authorized_keys"), "ssh-rsa OTHER x\n");
    expect(await runScript(home, `${KEY}\n`)).toBe(0);
    expect(await runScript(home, "")).toBe(64);
    const lines = (await NodeFSP.readFile(NodePath.join(home, ".ssh", "authorized_keys"), "utf8"))
      .split("\n")
      .filter(Boolean);
    expect(lines).toEqual(["ssh-rsa OTHER x", KEY]);
  });

  it("carries neither key nor password in the command line", () => {
    // Der Schlüssel kommt über stdin, das Passwort über SSH_ASKPASS.
    expect(AUTHORIZED_KEY_SCRIPT).not.toContain("ssh-ed25519");
    expect(AUTHORIZED_KEY_SCRIPT).toContain('key="$(cat)"');
  });

  it("prefers the default keys ssh uses on its own", async () => {
    const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "wj-key-"));
    expect(await findDesktopPublicKey(home)).toBeNull();
    await NodeFSP.mkdir(NodePath.join(home, ".ssh"));
    await NodeFSP.writeFile(NodePath.join(home, ".ssh", "id_rsa.pub"), "ssh-rsa AAAArsa me\n");
    await NodeFSP.writeFile(NodePath.join(home, ".ssh", "id_ed25519.pub"), `${KEY}\n`);
    expect(await findDesktopPublicKey(home)).toBe(KEY);
  });
});
