import { describe, expect, it } from "vite-plus/test";
// @effect-diagnostics nodeBuiltinImport:off -- Fake installer in a throwaway directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  classifyTransportFailure,
  parseSshG,
  resolveMachineCandidates,
  runMachineInstall,
  sshTargetArgs,
  type MachineEnrollCandidate,
  type MachineEnrollTransportStep,
  type RunCommand,
  type SshResolved,
} from "./MachineEnrollTransport.ts";

const sshG = (hostname: string, user: string, extra = "") =>
  `user ${user}\nhostname ${hostname}\nport 22\nidentityfile ~/.ssh/id_ed25519_ctox\nidentityfile ~/.ssh/id_rsa\n${extra}`;

const resolver =
  (table: Record<string, SshResolved>) =>
  async (host: string): Promise<SshResolved> =>
    table[host] ?? { hostname: host, user: "michaelwelsch", port: 22, identityFiles: [] };

const fakeInstaller = async (body: string) => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "wj-enroll-"));
  const path = NodePath.join(dir, "ctox-installer");
  await NodeFSP.writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { dir, path };
};

const local: MachineEnrollCandidate = {
  id: "local",
  transport: "local",
  name: "mac",
  user: null,
  host: null,
  port: null,
  sshAlias: null,
};

describe("ssh -G", () => {
  it("reads user, address, port and every identity file", () => {
    expect(parseSshG(sshG("100.87.204.48", "deck"))).toEqual({
      hostname: "100.87.204.48",
      user: "deck",
      port: 22,
      identityFiles: ["~/.ssh/id_ed25519_ctox", "~/.ssh/id_rsa"],
    });
  });
});

describe("Quellenliste", () => {
  it("takes users from ~/.ssh/config and maps tailnet devices onto matching Host entries", async () => {
    const candidates = await resolveMachineCandidates({
      localName: "MacBook-Pro",
      localUser: "michaelwelsch",
      sshAliases: ["ts-gpu1", "lan-gpu3", "*.internal", "!bad"],
      tailscalePeers: [
        { name: "gpu1-a6000", hostname: "100.87.204.48", online: true },
        { name: "nas-asustor", hostname: "100.64.0.28", online: true },
        { name: "offline", hostname: "100.1.1.1", online: false },
      ],
      resolve: resolver({
        "ts-gpu1": parseSshG(sshG("100.87.204.48", "deck")),
        "lan-gpu3": parseSshG(sshG("192.168.1.30", "metricspace")),
      }),
    });
    expect(candidates.map((entry) => [entry.id, entry.user, entry.sshAlias])).toEqual([
      ["local", null, null],
      ["ssh:lan-gpu3", "metricspace", "lan-gpu3"],
      // Gleiche HostName-Adresse wie ts-gpu1: Benutzer deck, über den Alias.
      ["tailscale:gpu1-a6000", "deck", "ts-gpu1"],
      // Kein Host-Eintrag; ssh -G liefert nur den lokalen Benutzer → null, nie michaelwelsch.
      ["tailscale:nas-asustor", null, null],
    ]);
  });
});

describe("Fehlercodes", () => {
  it("maps raw ssh output to contract error codes", () => {
    expect(classifyTransportFailure("transport_connected", "deck@x: Permission denied (publickey).")).toBe(
      "auth_rejected",
    );
    expect(classifyTransportFailure("transport_connected", "ssh: connect to host x port 22: Operation timed out")).toBe(
      "unreachable",
    );
    expect(classifyTransportFailure("package_copied", "cat: write error: No space left on device")).toBe(
      "disk_full",
    );
    expect(classifyTransportFailure("installed", "join: token expired")).toBe("token_expired");
    expect(classifyTransportFailure("installed", "boom")).toBe("install_failed");
  });

  it("never connects a tailnet device as an unknown user", () => {
    expect(() =>
      sshTargetArgs({ ...local, transport: "tailscale", host: "100.64.0.28", user: null }),
    ).toThrow("user_missing");
    expect(sshTargetArgs({ ...local, transport: "tailscale", sshAlias: "ts-gpu1", user: "deck" })).toContain(
      "ts-gpu1",
    );
  });
});

describe("lokaler Installationsweg gegen Fake-Installer", () => {
  it("copies the package, runs `machine join --token` and reports the three transport steps", async () => {
    const { dir, path } = await fakeInstaller(
      `[ "$1 $2 $3" = "machine join --token" ] || exit 9\necho "$4" > "$(dirname "$0")/token"\necho joined`,
    );
    const steps: MachineEnrollTransportStep[] = [];
    const ok = await runMachineInstall(
      { candidate: local, joinToken: "tok-123", installerPath: path, localDir: NodePath.join(dir, "work") },
      (step) => steps.push(step),
    );
    expect(ok).toBe(true);
    expect(steps.map((step) => `${step.key}:${step.state}`)).toEqual([
      "transport_connected:running",
      "transport_connected:done",
      "package_copied:running",
      "package_copied:done",
      "installed:running",
      "installed:done",
    ]);
    expect((await NodeFSP.readFile(NodePath.join(dir, "work", "token"), "utf8")).trim()).toBe("tok-123");
  });

  it("ends with exactly one failed step carrying a code and the raw text", async () => {
    const { dir, path } = await fakeInstaller(`echo "No space left on device" >&2\nexit 1`);
    const steps: MachineEnrollTransportStep[] = [];
    const ok = await runMachineInstall(
      { candidate: local, joinToken: "t", installerPath: path, localDir: NodePath.join(dir, "work") },
      (step) => steps.push(step),
    );
    expect(ok).toBe(false);
    const failed = steps.filter((step) => step.state === "failed");
    expect(failed).toEqual([
      expect.objectContaining({ key: "installed", error_code: "disk_full", detail: "No space left on device" }),
    ]);
  });
});

describe("SSH-Installationsweg", () => {
  it("stops at transport_connected with auth_rejected when the host refuses the key", async () => {
    const calls: string[][] = [];
    const run: RunCommand = async (command, args) => {
      calls.push([command, ...args]);
      return { code: 255, stdout: "", stderr: "deck@100.87.204.48: Permission denied (publickey)." };
    };
    const { path } = await fakeInstaller("exit 0");
    const steps: MachineEnrollTransportStep[] = [];
    const ok = await runMachineInstall(
      {
        candidate: { ...local, transport: "ssh", sshAlias: "ts-gpu1", user: "deck", host: "100.87.204.48" },
        joinToken: "t",
        installerPath: path,
        run,
      },
      (step) => steps.push(step),
    );
    expect(ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("BatchMode=yes");
    expect(steps.at(-1)).toMatchObject({ key: "transport_connected", state: "failed", error_code: "auth_rejected" });
  });

  it("streams the package over ssh and runs join with the quoted token", async () => {
    const calls: { args: ReadonlyArray<string>; stdin: boolean }[] = [];
    const run: RunCommand = async (_command, args, options) => {
      calls.push({ args, stdin: options?.stdin !== undefined });
      return { code: 0, stdout: "", stderr: "" };
    };
    const { path } = await fakeInstaller("exit 0");
    const ok = await runMachineInstall(
      {
        candidate: { ...local, transport: "ssh", sshAlias: "lan-gpu3", user: null, host: "192.168.1.30" },
        joinToken: "a'b",
        installerPath: path,
        run,
      },
      () => undefined,
    );
    expect(ok).toBe(true);
    expect(calls.map((call) => call.stdin)).toEqual([false, true, false]);
    expect(calls[2]!.args.at(-1)).toBe(`./.ctox-enroll/ctox-installer machine join --token 'a'\\''b'`);
  });
});
