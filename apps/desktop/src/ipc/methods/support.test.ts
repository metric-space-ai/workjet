// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { DesktopSupportBundleResult } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopSupportBundle from "../../support/DesktopSupportBundle.ts";
import * as IpcChannels from "../channels.ts";
import { createSupportBundle } from "./support.ts";

const decode = Schema.decodeUnknownEffect(DesktopSupportBundleResult);

const RESULT = {
  filePath: "/state/support-bundles/ctox-support-bundle-20260820T100000000Z.json",
  byteLength: 4096,
  fieldCount: 60,
  redactedFieldCount: 3,
  omittedFieldCount: 2,
  generatedAtIso: "2026-08-20T10:00:00.000Z",
} as const;

const bundleLayer = Layer.succeed(DesktopSupportBundle.DesktopSupportBundle, {
  build: Effect.die("unexpected build"),
  create: Effect.succeed(RESULT),
} satisfies DesktopSupportBundle.DesktopSupportBundle["Service"]);

describe("support-bundle IPC contract", () => {
  it("uses a stable channel name", () => {
    assert.equal(createSupportBundle.channel, IpcChannels.CREATE_SUPPORT_BUNDLE_CHANNEL);
  });

  it.effect("returns the exact path and the redaction counters, and nothing else", () =>
    Effect.gen(function* () {
      const raw = yield* createSupportBundle.handler(undefined);
      const result = yield* decode(raw);

      assert.strictEqual(result.filePath, RESULT.filePath);
      assert.strictEqual(result.redactedFieldCount, 3);
      assert.strictEqual(result.omittedFieldCount, 2);
      // The document itself never crosses the bridge.
      assert.deepStrictEqual(Object.keys(raw as object).sort(), [
        "byteLength",
        "fieldCount",
        "filePath",
        "generatedAtIso",
        "omittedFieldCount",
        "redactedFieldCount",
      ]);
    }).pipe(Effect.provide(bundleLayer)),
  );
});
