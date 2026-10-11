// @effect-diagnostics nodeBuiltinImport:off -- Disposable command fixtures exercise the preflight process boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { SshCommandError } from "@workjet/ssh/errors";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { testing } from "./DesktopComputerProvisioner.ts";
import { runLocalCommand } from "./LocalProvisioningCommand.ts";

describe("DesktopComputerProvisioner helpers", () => {
  it("normalizes only the supported release platforms and architectures", () => {
    expect(testing.normalizePlatform("Darwin")).toBe("macos");
    expect(testing.normalizePlatform("linux")).toBe("linux");
    expect(testing.normalizePlatform("windows")).toBe("windows");
    expect(testing.normalizePlatform("freebsd")).toBeNull();
    expect(testing.normalizeArchitecture("aarch64")).toBe("arm64");
    expect(testing.normalizeArchitecture("AMD64")).toBe("x64");
    expect(testing.normalizeArchitecture("i686")).toBeNull();
  });

  it("parses bounded preflight key/value output without treating later equals as separators", () => {
    const values = testing.parseKeyValueOutput(
      "platform=Linux\narch=x86_64\nworkjet_version=1.2.3=stable\ninvalid\n",
    );
    expect(Object.fromEntries(values)).toEqual({
      platform: "Linux",
      arch: "x86_64",
      workjet_version: "1.2.3=stable",
    });
  });

  it("requires the tools used by the POSIX installer before provisioning", () => {
    expect(testing.posixPreflightScript).toContain("for tool in curl python3 bash mktemp");
    expect(testing.posixPreflightScript).toContain(
      'if [ "$platform" = Linux ] && ! command -v install',
    );
    expect(testing.posixPreflightScript).toContain("missing_tools=");
  });

  it("accepts local Windows administrators through UAC but requires elevated remote SSH", () => {
    const filteredAdministrator = new Map([
      ["admin", "false"],
      ["admin_member", "true"],
    ]);
    expect(testing.administratorCapability(filteredAdministrator, "windows", true)).toEqual({
      capable: true,
      elevationRequired: true,
    });
    expect(testing.administratorCapability(filteredAdministrator, "windows", false)).toEqual({
      capable: false,
      elevationRequired: false,
    });
    expect(testing.windowsPreflightScript).toContain("S-1-5-32-544");
    expect(testing.windowsPreflightScript).not.toContain("Read-Host");
    expect(testing.windowsPreflightScript).not.toContain("ConvertTo-SecureString");
  });

  it("installs a visible Workjet Linux desktop entry with canonical deep-link handlers", () => {
    expect(testing.linuxDesktopEntry).toContain("Name=Workjet");
    expect(testing.linuxDesktopEntry).toContain("Exec=/opt/workjet/Workjet.AppImage %U");
    expect(testing.linuxDesktopEntry).toContain("x-scheme-handler/workjet;");
    expect(testing.linuxDesktopEntry).not.toContain("CTOX Desktop");
    expect(testing.linuxDesktopRegistrationScript).toContain(
      "/usr/local/share/applications/workjet.desktop",
    );
    expect(testing.linuxDesktopRegistrationScript).toContain("install -m 0644");
  });

  it("turns an approved remote preflight into a credential-free managed Fleet target", () => {
    const result = testing.sshManagedInputFromPreflight(
      {
        preflightId: "preflight-1",
        expiresAt: "2026-08-26T12:00:00Z",
        target: {
          _tag: "ssh",
          ssh: {
            alias: "gpu3",
            hostname: "10.0.0.3",
            username: "operator",
            port: 2222,
          },
        },
        platform: "linux",
        architecture: "x64",
        internetAvailable: true,
        administratorCapable: true,
        administratorPasswordRequired: false,
        administratorElevationRequired: false,
        graphicalSession: true,
        ctoxInstalledVersion: null,
        workjetInstalledVersion: null,
        warnings: [],
      },
      "gpu3 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest",
    );
    expect(result).toEqual({
      host: "gpu3",
      displayName: "gpu3",
      username: "operator",
      port: 2222,
      platform: "linux",
      architecture: "x64",
      knownHostsLine: "gpu3 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest",
    });
    expect(JSON.stringify(result)).not.toContain("password");
    expect(
      testing.sshManagedInputFromPreflight(
        {
          preflightId: "local",
          expiresAt: "2026-08-26T12:00:00Z",
          target: { _tag: "local" as const },
          platform: "macos" as const,
          architecture: "arm64" as const,
          internetAvailable: true,
          administratorCapable: true,
          administratorPasswordRequired: false,
          administratorElevationRequired: false,
          graphicalSession: true,
          ctoxInstalledVersion: null,
          workjetInstalledVersion: null,
          warnings: [],
        },
        null,
      ),
    ).toBeNull();
  });
});

describe("preflight command boundaries", () => {
  let fixtureDirectory: string | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (fixtureDirectory !== undefined) {
      // This PID was written by the fixture we created, never found by a scan.
      const pid = Number(await NodeFSP.readFile(NodePath.join(fixtureDirectory, "probe.pid"), "utf8").catch(() => ""));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { NodeProcess.kill(pid, "SIGKILL"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await NodeFSP.rm(fixtureDirectory, { recursive: true, force: true });
      fixtureDirectory = undefined;
    }
  });

  async function probe(stalledCommand?: "ctox" | "workjet") {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-preflight-test-"));
    fixtureDirectory = directory;
    const commands = {
      curl: "exit 0",
      id: "printf '0\\n'",
      pgrep: "exit 1",
      ctox: `printf '%s\\n' '{"version":"1.2.3"}'`,
      workjet: "printf '0.0.1\\n'",
    };
    for (const [command, body] of Object.entries(commands)) {
      const script = command === stalledCommand
        ? `echo $$ > '${NodePath.join(directory, "probe.pid")}'; exec /bin/sleep 60`
        : body;
      await NodeFSP.writeFile(NodePath.join(directory, command), `#!/bin/sh\n${script}\n`, { mode: 0o700 });
    }
    vi.stubEnv("PATH", `${directory}:${NodeProcess.env.PATH ?? "/usr/bin:/bin"}`);
    return runLocalCommand("sh", ["-s"], testing.posixPreflightScript, 8_000);
  }

  it.skipIf(NodeProcess.platform !== "linux")("reads installed versions without changing the target", async () => {
    const output = await probe();
    const values = testing.parseKeyValueOutput(output.stdout);
    expect(values.get("ctox_version")).toBe("1.2.3");
    expect(values.get("workjet_version")).toBe("0.0.1");
    expect(values.get("internet")).toBe("true");
  });

  it.skipIf(NodeProcess.platform !== "linux").each(["ctox", "workjet"] as const)(
    "fails a stalled %s version check at its step deadline",
    async (command) => {
      await expect(probe(command)).rejects.toThrow(`Preflight command timed out after 3 seconds: ${command}`);
      const pid = Number(await NodeFSP.readFile(NodePath.join(fixtureDirectory!, "probe.pid"), "utf8"));
      expect(() => NodeProcess.kill(pid, 0)).toThrow();
    },
    10_000,
  );

  it.each([
    [1, "'sh' is not recognized as an internal or external command.", true],
    [127, "bash: line 1: sh: command not found", true],
    [127, "sh: 1: python3: not found", false],
    [255, "Permission denied (publickey,password)", false],
    [null, "SSH command timed out", false],
    [255, "Host key verification failed.", false],
    [1, "Preflight command timed out after 3 seconds: ctox", false],
  ] as const)("limits Windows fallback to a missing POSIX shell (%s, %s)", (exitCode, stderr, expected) => {
    const error = new SshCommandError({ command: ["ssh", "host", "sh", "-s"], exitCode, stderr, message: stderr });
    expect(testing.isPosixShellUnavailable(error)).toBe(expected);
  });

  it("does not treat generic failures as a Windows target", () => {
    expect(testing.isPosixShellUnavailable(new Error("sh: not found"))).toBe(false);
  });
});
