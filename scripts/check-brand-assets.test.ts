// @effect-diagnostics nodeBuiltinImport:off -- Hashing raw icon bytes; node:crypto has no Effect equivalent here.
// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Every shipped Workjet icon must match the Workjet source of truth byte for byte.
 *
 * ── Why this guard exists ───────────────────────────────────────────────────
 * Workjet has several independently copied icon surfaces: Electron resources,
 * the browser splash/favicon set, and the public marketing app icon. A stale
 * copy previously brought back T3/CTOX artwork on only some of those surfaces.
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

/** [shipped copy, Workjet source of truth] */
const BRAND_ASSET_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["apps/desktop/resources/icon.png", "assets/workjet/workjet-app-icon.png"],
  ["apps/desktop/resources/icon.icns", "assets/workjet/workjet-app-icon.icns"],
  ["apps/desktop/resources/icon.ico", "assets/workjet/workjet-windows.ico"],
  ["apps/web/public/favicon.ico", "assets/workjet/workjet-web-favicon.ico"],
  ["apps/web/public/favicon-16x16.png", "assets/workjet/workjet-web-favicon-16x16.png"],
  ["apps/web/public/favicon-32x32.png", "assets/workjet/workjet-web-favicon-32x32.png"],
  ["apps/web/public/apple-touch-icon.png", "assets/workjet/workjet-web-apple-touch-180.png"],
  ["apps/marketing/public/icon.png", "assets/workjet/workjet-app-icon.png"],
  ["apps/marketing/public/favicon.ico", "assets/workjet/workjet-web-favicon.ico"],
  ["apps/marketing/public/apple-touch-icon.png", "assets/workjet/workjet-web-apple-touch-180.png"],
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
    it.effect(`${shipped} is the Workjet asset`, () =>
      Effect.gen(function* () {
        const shippedDigest = yield* digestOf(shipped);
        const sourceDigest = yield* digestOf(source);
        assert.strictEqual(shippedDigest, sourceDigest, `${shipped} does not match ${source}`);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  }
});
