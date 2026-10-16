// @effect-diagnostics nodeBuiltinImport:off - reads app sources as text to guard removed symbols statically.
// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Static guard (V4-G2, decision E49): the guest-shell Toolhub path is not part
 * of V4. Neither the V2 nor the v4 shell has `workjetToolhubControl`, and CTOX
 * has no `ctox.toolhub.*` command, so every entry point was removed. A V4
 * Toolhub comes back as a new design (docs/backlog/toolhub-v4.md), never by
 * reviving these symbols.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../../..",
);
const self = NodeURL.fileURLToPath(import.meta.url);

// Where the guest path lived (desktop main/preload, renderer, bridge contracts).
const SCANNED_ROOTS = [
  "apps/desktop/src",
  "apps/web/src",
  "packages/contracts/src",
  "packages/client-runtime/src",
  "packages/shared/src",
];
const SOURCE = /\.(?:[cm]?[jt]sx?)$/u;

const FORBIDDEN = [
  ["workjet", "ToolhubControl"],
  ["buildGuest", "ToolhubExpression"],
  ["TOOLHUB_", "REQUEST_CHANNEL"],
  ["TOOLHUB_", "AUTHORIZE_CHANNEL"],
  ["toolhub", "Request?:"],
  ["toolhub", "Authorize?:"],
].map((parts) => parts.join(""));

function sourceFiles(dir: string, out: string[]): string[] {
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (SOURCE.test(entry.name) && full !== self) out.push(full);
  }
  return out;
}

describe("Toolhub guest path stays removed (E49)", () => {
  it("scans the app and package sources", () => {
    const files = SCANNED_ROOTS.flatMap((root) => sourceFiles(NodePath.join(repoRoot, root), []));
    expect(files.length).toBeGreaterThan(1000);
    const hits = files.flatMap((file) => {
      const text = NodeFS.readFileSync(file, "utf8");
      return FORBIDDEN.filter((symbol) => text.includes(symbol)).map(
        (symbol) => `${NodePath.relative(repoRoot, file)}: ${symbol}`,
      );
    });
    expect(hits).toEqual([]);
  }, 60_000);
});
