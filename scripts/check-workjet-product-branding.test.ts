// @effect-diagnostics nodeBuiltinImport:off -- This repository guard inspects tracked source files.
import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCAN_ROOTS = [
  "README.md",
  "docs/README.md",
  "docs/user",
  ".github/workflows/release.yml",
  "apps/marketing/src",
  "apps/web/src",
  "apps/desktop/src",
  "apps/desktop/scripts",
  "apps/server/src",
  "packages/client-runtime/src",
  "packages/contracts/src",
  "packages/shared/src",
  "packages/ssh/src",
] as const;

const TEXT_EXTENSIONS = new Set([
  ".astro",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".yml",
]);
const FORBIDDEN_VISIBLE_IDENTITIES = [
  /T3 Code/,
  /T3Code/,
  /T3-Code/,
  /T3 Connect/,
  /CTOX Desktop App/,
  /CTOX Mobile/,
  /CTOX Business OS App/,
] as const;

const LEGACY_STORAGE_IDENTITY_FILE = "apps/desktop/src/app/DesktopEnvironment.ts";
const ALLOWED_LEGACY_STORAGE_LINES = new Set([
  'const userDataDirName = isDevelopment ? "CTOX Desktop App (Dev)" : "CTOX Desktop App";',
  '? ["t3code-dev", "T3 Code (Dev)"]',
  ': ["t3code", "T3 Code (Alpha)"];',
]);

function isTestOrFixture(relativePath: string): boolean {
  return (
    /(?:^|\/)fixtures(?:\/|$)/.test(relativePath) || /\.(?:test|spec)\.[^.]+$/.test(relativePath)
  );
}

async function collectTextFiles(relativePath: string): Promise<string[]> {
  const absolutePath = path.join(REPO_ROOT, relativePath);
  const entries = await readdir(absolutePath, { withFileTypes: true }).catch(() => null);
  if (entries === null) {
    return TEXT_EXTENSIONS.has(path.extname(relativePath)) || relativePath.endsWith("README.md")
      ? [relativePath]
      : [];
  }

  const nested = await Promise.all(
    entries
      .filter((entry) => entry.name !== "dist" && entry.name !== "node_modules")
      .map((entry) => collectTextFiles(path.join(relativePath, entry.name))),
  );
  return nested.flat();
}

describe("Workjet product identity", () => {
  it("does not render a retired app identity from current product surfaces", async () => {
    const files = (await Promise.all(SCAN_ROOTS.map(collectTextFiles))).flat();
    const findings: string[] = [];

    for (const relativePath of files) {
      if (isTestOrFixture(relativePath)) continue;

      const contents = await readFile(path.join(REPO_ROOT, relativePath), "utf8");
      contents.split("\n").forEach((line, index) => {
        const normalizedLine = line.trim();
        if (
          relativePath === LEGACY_STORAGE_IDENTITY_FILE &&
          ALLOWED_LEGACY_STORAGE_LINES.has(normalizedLine)
        ) {
          return;
        }

        for (const identity of FORBIDDEN_VISIBLE_IDENTITIES) {
          if (identity.test(line)) {
            findings.push(`${relativePath}:${index + 1}: ${normalizedLine}`);
          }
        }
      });
    }

    expect(findings, findings.join("\n")).toEqual([]);
  });

  it("does not ship retired marketing screenshots", async () => {
    const retiredScreenshots = [
      "apps/marketing/public/screenshot.webp",
      "apps/marketing/public/updated-screenshot.webp",
    ];

    const existing: string[] = [];
    for (const relativePath of retiredScreenshots) {
      const exists = await access(path.join(REPO_ROOT, relativePath), constants.F_OK)
        .then(() => true)
        .catch(() => false);
      if (exists) existing.push(relativePath);
    }

    expect(existing).toEqual([]);
  });
});
