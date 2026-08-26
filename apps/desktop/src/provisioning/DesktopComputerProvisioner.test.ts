import { describe, expect, it } from "vite-plus/test";

import { testing } from "./DesktopComputerProvisioner.ts";

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
          ...{
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
        },
        null,
      ),
    ).toBeNull();
  });
});
