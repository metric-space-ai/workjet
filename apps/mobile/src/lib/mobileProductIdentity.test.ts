import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

function read(relativePath: string): string {
  return NodeFS.readFileSync(NodeURL.fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("Workjet Mobile product identity", () => {
  it("keeps one visible app name while preserving update identities", () => {
    const config = read("../../app.config.ts");
    expect(config.match(/appName: "Workjet"/gu)).toHaveLength(3);
    expect(config).toContain('iosBundleIdentifier: "com.t3tools.t3code"');
    expect(config).toContain('androidPackage: "com.t3tools.t3code"');
    expect(config).toContain('slug: "t3-code"');
    expect(config).toContain('orientation: "default"');
    expect(config).toContain("supportsTablet: true");
  });

  it("keeps the established local data identity during the soft migration", () => {
    const preferences = read("../persistence/mobile-preferences.ts");
    const database = read("../persistence/mobile-database.ts");
    expect(preferences).toContain('const PREFERENCES_KEY = "t3code.preferences"');
    expect(database).toContain('const DATABASE_NAME = "t3code-client.db"');
  });

  it("does not expose superseded app names in the primary mobile surfaces", () => {
    const surfaces = [
      read("../App.tsx"),
      read("../Stack.tsx"),
      read("../components/BrandMark.tsx"),
      read("../components/CompactBrandTitle.tsx"),
      read("../components/CtoxMark.tsx"),
      read("../features/cloud/ConnectOnboardingRouteScreen.tsx"),
      read("../features/settings/SettingsRouteScreen.tsx"),
      read("../features/mode/BusinessOsSetupScreen.tsx"),
    ].join("\n");

    expect(surfaces).not.toMatch(/CTOX Mobile|CTOX Business OS|Desktop App|T3 Code Mobile/u);
    expect(surfaces).not.toContain('label="T3 Account"');
    expect(surfaces).not.toContain("T3 Connect");
    expect(surfaces).not.toContain('accessibilityLabel="CTOX"');
    expect(surfaces).not.toContain('stage="Alpha"');
  });
});
