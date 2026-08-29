// @effect-diagnostics nodeBuiltinImport:off -- This repository guard inspects tracked source files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const REPO_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

const PRODUCTIVE_IDENTITY_FILES = [
  "apps/desktop/product-identity.json",
  "apps/desktop/scripts/electron-launcher.mjs",
  "apps/desktop/src/app/DesktopAppIdentity.ts",
  "apps/desktop/src/app/DesktopDeepLink.ts",
  "apps/desktop/src/app/DesktopDeepLinkRouter.ts",
  "apps/desktop/src/app/DesktopEnvironment.ts",
  "apps/desktop/src/app/DesktopLinuxUrlHandler.ts",
  "apps/desktop/src/app/DesktopUserDataMigration.ts",
  "apps/desktop/src/electron/ElectronProtocol.ts",
  "apps/desktop/src/electron/desktopSchemes.ts",
  "apps/desktop/src/provisioning/DesktopComputerProvisioner.ts",
  "apps/desktop/src/window/DesktopWindow.ts",
  "apps/server/src/http.ts",
  "scripts/build-desktop-artifact.ts",
  "scripts/workjet-ui-audit.ts",
  ".github/workflows/release.yml",
] as const;

const RETIRED_IDENTITY_PATTERNS = [
  /com\.t3tools\.t3code/u,
  /(?:^|["'`\s(])(?:t3code|t3code-dev|t3code-preview|ctox-desktop|ctox-desktop-dev):\/\//u,
  /["'`](?:t3code|t3code-dev|t3code-preview|ctox-desktop|ctox-desktop-dev)["'`]/u,
] as const;

describe("canonical Workjet desktop identity", () => {
  it("keeps retired bundle IDs and URL schemes out of productive desktop and release paths", async () => {
    const findings: string[] = [];
    for (const relativePath of PRODUCTIVE_IDENTITY_FILES) {
      const contents = await NodeFSP.readFile(NodePath.join(REPO_ROOT, relativePath), "utf8");
      contents.split("\n").forEach((line, index) => {
        for (const pattern of RETIRED_IDENTITY_PATTERNS) {
          if (pattern.test(line)) findings.push(`${relativePath}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(findings).toEqual([]);
  });

  it("binds packaged builds to one app ID and one production scheme", async () => {
    const identity = JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(REPO_ROOT, "apps/desktop/product-identity.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;

    expect(identity.productionAppId).toBe("dev.workjet.desktop");
    expect(identity.productionScheme).toBe("workjet");
    expect(identity.productionUserDataDirName).toBe("Workjet");
  });

  it("keeps replacement installation offline and updater metadata publishable", async () => {
    const provisioner = await NodeFSP.readFile(
      NodePath.join(REPO_ROOT, "apps/desktop/src/provisioning/DesktopComputerProvisioner.ts"),
      "utf8",
    );
    expect(provisioner).toContain("dev.workjet.menubar");
    expect(provisioner).toContain("mustBeStoppedBeforeInstall");
    expect(provisioner).toContain("sourceIsRuntimeFallback");
    expect(provisioner).toContain("Quit Workjet before replacing /Applications/Workjet.app.");
    expect(provisioner).toContain("codesign --verify --deep --strict");

    const workflow = await NodeFSP.readFile(
      NodePath.join(REPO_ROOT, ".github/workflows/release.yml"),
      "utf8",
    );
    expect(workflow).toContain("Generate Workjet install manifest");
    expect(workflow).toContain("Verify complete Workjet release surface");
    expect(workflow).toContain("release-assets/*.blockmap");
    expect(workflow).toContain("release-assets/*.yml");
  });
});
