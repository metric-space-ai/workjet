// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * The shipped icons must be the CTOX brand assets, byte for byte.
 *
 * ── Why this guard exists ───────────────────────────────────────────────────
 * `assets/ctox/` has held the real CTOX artwork since 2026-08-17, and the
 * packaged build already applies it (`resolveDesktopWebAssetBrand` returns
 * "ctox" unconditionally). But the copies that a DEVELOPMENT run actually
 * loads — `apps/desktop/resources/icon.*` and `apps/web/public/favicon*` —
 * were never updated and still carried the old T3 blueprint artwork. The app
 * therefore shipped one identity and showed another to everyone running it
 * locally, for months, with nothing anywhere to notice.
 *
 * Comparing hashes rather than "does a file exist" is the point: a stale copy
 * is exactly the failure mode here, and only content can catch it.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const digest = (relativePath: string): string =>
  createHash("sha256")
    .update(readFileSync(join(repoRoot, relativePath)))
    .digest("hex");

/** [shipped copy, CTOX source of truth] */
const BRAND_ASSET_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["apps/desktop/resources/icon.png", "assets/ctox/ctox-app-icon.png"],
  ["apps/desktop/resources/icon.icns", "assets/ctox/ctox-app-icon.icns"],
  ["apps/desktop/resources/icon.ico", "assets/ctox/ctox-windows.ico"],
  ["apps/web/public/favicon.ico", "assets/ctox/ctox-web-favicon.ico"],
  ["apps/web/public/favicon-16x16.png", "assets/ctox/ctox-web-favicon-16x16.png"],
  ["apps/web/public/favicon-32x32.png", "assets/ctox/ctox-web-favicon-32x32.png"],
  ["apps/web/public/apple-touch-icon.png", "assets/ctox/ctox-web-apple-touch-180.png"],
];

describe("shipped brand assets", () => {
  for (const [shipped, source] of BRAND_ASSET_PAIRS) {
    it(`${shipped} is the CTOX asset`, () => {
      expect(digest(shipped), `${shipped} does not match ${source}`).toBe(digest(source));
    });
  }
});
