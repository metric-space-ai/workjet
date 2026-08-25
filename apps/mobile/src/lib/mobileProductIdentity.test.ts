import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

function read(relativePath: string): string {
  return NodeFS.readFileSync(NodeURL.fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

function readProductionTree(relativePath: string): string {
  const root = NodeURL.fileURLToPath(new URL(relativePath, import.meta.url));
  const visit = (path: string): string[] =>
    NodeFS.readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
      const next = `${path}/${entry.name}`;
      if (entry.isDirectory()) return visit(next);
      if (!/\.(?:ts|tsx)$/u.test(entry.name) || /\.test\.(?:ts|tsx)$/u.test(entry.name)) return [];
      return [NodeFS.readFileSync(next, "utf8")];
    });
  return visit(root).join("\n");
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
      readProductionTree("../features/business-os/"),
    ].join("\n");

    expect(surfaces).not.toMatch(
      /CTOX Desktop App|CTOX Mobile|CTOX Business OS App|T3 Code|T3Code|\bAlpha\b/u,
    );
    expect(surfaces).not.toContain('label="T3 Account"');
    expect(surfaces).not.toContain("T3 Connect");
    expect(surfaces).not.toContain('accessibilityLabel="CTOX"');
    expect(surfaces).not.toContain('stage="Alpha"');
  });

  it("pins generated native display names to Workjet without renaming technical identities", () => {
    const config = read("../../app.config.ts");
    const mark = read("../components/CtoxMark.tsx");
    const widget = read("../widgets/AgentActivity.tsx");
    const widgetPlugin = read("../../plugins/withWidgetLogoAsset.cjs");

    expect(config.match(/appName: "Workjet"/gu)).toHaveLength(3);
    expect(config).not.toMatch(/appName: "(?:CTOX|T3 Code|T3Code|Alpha)"/u);
    expect(config).toContain("Allow Workjet to connect to CTOX backends");
    expect(mark).toContain('accessibilityLabel="Workjet"');
    expect(mark).not.toContain('accessibilityLabel="CTOX"');
    expect(`${widget}\n${widgetPlugin}`).not.toContain("T3Mark");
    expect(`${widget}\n${widgetPlugin}`).toContain("WorkjetMark");
  });
});
