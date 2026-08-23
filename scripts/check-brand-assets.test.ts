// @effect-diagnostics nodeBuiltinImport:off -- Hashing raw icon bytes; node:crypto has no Effect equivalent here.
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
 * locally, with nothing anywhere to notice.
 *
 * Comparing CONTENT rather than "does the file exist" is the point: a stale
 * copy is exactly the failure mode here, and only a hash can catch it.
 */
import { createHash } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

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

const digestOf = Effect.fn("digestOf")(function* (relativePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const here = yield* path.fromFileUrl(new URL(import.meta.url));
  const repoRoot = path.resolve(path.dirname(here), "..");
  const bytes = yield* fs.readFile(path.join(repoRoot, relativePath));
  return createHash("sha256").update(bytes).digest("hex");
});

describe("shipped brand assets", () => {
  for (const [shipped, source] of BRAND_ASSET_PAIRS) {
    it.effect(`${shipped} is the CTOX asset`, () =>
      Effect.gen(function* () {
        const shippedDigest = yield* digestOf(shipped);
        const sourceDigest = yield* digestOf(source);
        assert.strictEqual(shippedDigest, sourceDigest, `${shipped} does not match ${source}`);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  }
});
