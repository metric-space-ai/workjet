// SPDX-License-Identifier: MIT OR AGPL-3.0-only
// @effect-diagnostics preferSchemaOverJson:off -- redaction assertions inspect the complete bounded error value.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import { WorkjetContentDigest } from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import {
  WORKJET_SNAPSHOT_MAX_BYTES,
  WORKJET_SNAPSHOT_ROOT_SEGMENTS,
  WorkjetSnapshotStore,
  WorkjetSnapshotStoreLive,
  isWorkjetSnapshotCorruptError,
  isWorkjetSnapshotNotFoundError,
  isWorkjetSnapshotTooLargeError,
  snapshotDigestForRef,
  snapshotRefForDigest,
  snapshotRelativeSegments,
} from "./WorkjetSnapshotStore.ts";

const makeStoreLayer = (prefix: string) =>
  WorkjetSnapshotStoreLive.pipe(
    Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix }))),
  );

const sha256Hex = (input: string): string =>
  NodeCrypto.createHash("sha256").update(Buffer.from(input, "utf8")).digest("hex");

const storedPath = Effect.fn("test.storedPath")(function* (digest: WorkjetContentDigest) {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(
    config.stateDir,
    ...WORKJET_SNAPSHOT_ROOT_SEGMENTS,
    ...snapshotRelativeSegments(digest),
  );
});

it("maps a digest to a bounded base64url reference that round-trips", () => {
  const digest = WorkjetContentDigest.make(sha256Hex("round-trip"));
  const reference = snapshotRefForDigest(digest);

  // 32 raw digest bytes encode to exactly 43 unpadded base64url characters,
  // inside the contract's 16..512 window.
  expect(reference).toHaveLength(43);
  expect(reference).toMatch(/^[A-Za-z0-9_-]{16,512}$/);
  expect(snapshotDigestForRef(reference)).toStrictEqual(Option.some(digest));

  // Distinct content yields a distinct reference.
  const other = snapshotRefForDigest(WorkjetContentDigest.make(sha256Hex("different")));
  expect(other).not.toBe(reference);

  // Anything that is not exactly 32 encoded bytes is refused rather than
  // silently mapped onto some path.
  expect(Option.isNone(snapshotDigestForRef("too-short"))).toBe(true);
  expect(Option.isNone(snapshotDigestForRef(Buffer.alloc(31).toString("base64url")))).toBe(true);
  expect(Option.isNone(snapshotDigestForRef(Buffer.alloc(33).toString("base64url")))).toBe(true);
});

it("shards the stored path two levels deep on the digest prefix", () => {
  const digest = WorkjetContentDigest.make(sha256Hex("sharding"));
  const segments = snapshotRelativeSegments(digest);

  expect(segments).toStrictEqual([digest.slice(0, 2), digest.slice(2, 4), `${digest}.bin`]);
  // The full digest stays in the filename, so a path is self-identifying.
  expect(segments[2]).toBe(`${digest}.bin`);
});

it.layer(NodeServices.layer)("workjet snapshot store", (it) => {
  it.effect("round-trips a snapshot and treats a repeat put as a no-op", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetSnapshotStore;
      const fs = yield* FileSystem.FileSystem;
      const text = "Implement the snapshot store.\nBounded, immutable, verified.";

      const first = yield* store.put(text);
      assert.strictEqual(first.digest, sha256Hex(text));
      assert.strictEqual(first.byteLength, Buffer.byteLength(text, "utf8"));
      assert.strictEqual(first.snapshotRef, snapshotRefForDigest(first.digest));

      const filePath = yield* storedPath(first.digest);
      assert.isTrue(yield* fs.exists(filePath));
      const firstInfo = yield* fs.stat(filePath);

      // Idempotent: the same content resolves to the same object and the
      // existing file is not rewritten.
      const second = yield* store.put(text);
      assert.deepStrictEqual(second, first);
      const secondInfo = yield* fs.stat(filePath);
      assert.deepStrictEqual(secondInfo.mtime, firstInfo.mtime);

      assert.strictEqual(yield* store.get(first.digest), text);
      assert.strictEqual(store.refFor(first.digest), first.snapshotRef);

      const stat = yield* store.stat(first.digest);
      assert.deepStrictEqual(stat, Option.some({ byteLength: first.byteLength }));
    }).pipe(Effect.provide(makeStoreLayer("t3code-workjet-snapshot-roundtrip-"))),
  );

  it.effect("preserves multi-byte UTF-8 and counts bytes, not characters", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetSnapshotStore;
      const text = "Prüfung — 日本語 🚀";

      const stored = yield* store.put(text);
      assert.strictEqual(stored.byteLength, Buffer.byteLength(text, "utf8"));
      assert.isAbove(stored.byteLength, text.length);
      assert.strictEqual(yield* store.get(stored.digest), text);
    }).pipe(Effect.provide(makeStoreLayer("t3code-workjet-snapshot-utf8-"))),
  );

  it.effect("rejects content past the 8 MiB ceiling without writing anything", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetSnapshotStore;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const oversized = "x".repeat(WORKJET_SNAPSHOT_MAX_BYTES + 1);

      const error = yield* Effect.flip(store.put(oversized));
      assert.isTrue(isWorkjetSnapshotTooLargeError(error));
      assert.deepInclude(error, {
        byteLength: WORKJET_SNAPSHOT_MAX_BYTES + 1,
        maximumBytes: WORKJET_SNAPSHOT_MAX_BYTES,
      });

      // Nothing was written: the rejection happens before the filesystem is touched.
      const root = path.join(config.stateDir, ...WORKJET_SNAPSHOT_ROOT_SEGMENTS);
      assert.isFalse(yield* fs.exists(root));

      // The largest legal payload is still accepted.
      const atCeiling = "y".repeat(WORKJET_SNAPSHOT_MAX_BYTES);
      const stored = yield* store.put(atCeiling);
      assert.strictEqual(stored.byteLength, WORKJET_SNAPSHOT_MAX_BYTES);
    }).pipe(Effect.provide(makeStoreLayer("t3code-workjet-snapshot-ceiling-"))),
  );

  it.effect("reports a missing snapshot as not-found rather than a defect", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetSnapshotStore;
      const digest = WorkjetContentDigest.make(sha256Hex("never stored"));

      const error = yield* Effect.flip(store.get(digest));
      assert.isTrue(isWorkjetSnapshotNotFoundError(error));
      assert.deepStrictEqual(yield* store.stat(digest), Option.none());
    }).pipe(Effect.provide(makeStoreLayer("t3code-workjet-snapshot-missing-"))),
  );

  it.effect("catches a tampered stored file through digest re-verification", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetSnapshotStore;
      const fs = yield* FileSystem.FileSystem;
      const text = "The prompt the orchestrator actually sent.";

      const stored = yield* store.put(text);
      const filePath = yield* storedPath(stored.digest);

      // Overwrite the content-addressed object behind the store's back. A
      // store that trusted its own layout would hand this straight back.
      yield* fs.writeFileString(filePath, "Substituted instructions.");

      const error = yield* Effect.flip(store.get(stored.digest));
      assert.isTrue(isWorkjetSnapshotCorruptError(error));
      assert.deepInclude(error, { digest: stored.digest, issue: "digest-mismatch" });
      // The failure never carries the offending content.
      assert.notInclude(JSON.stringify(error), "Substituted instructions.");
    }).pipe(Effect.provide(makeStoreLayer("t3code-workjet-snapshot-tampered-"))),
  );

  it.effect("rejects stored bytes that are no longer valid UTF-8", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetSnapshotStore;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;

      // File the invalid bytes under their OWN digest, so the digest check
      // passes and only the UTF-8 decode can reject them.
      const invalid = new Uint8Array([0xff, 0xfe, 0xfd]);
      const digest = WorkjetContentDigest.make(
        NodeCrypto.createHash("sha256").update(invalid).digest("hex"),
      );
      const filePath = path.join(
        config.stateDir,
        ...WORKJET_SNAPSHOT_ROOT_SEGMENTS,
        ...snapshotRelativeSegments(digest),
      );
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFile(filePath, invalid);

      const error = yield* Effect.flip(store.get(digest));
      assert.isTrue(isWorkjetSnapshotCorruptError(error));
      assert.deepInclude(error, { digest, issue: "invalid-utf8" });
    }).pipe(Effect.provide(makeStoreLayer("t3code-workjet-snapshot-utf8-invalid-"))),
  );

  it.effect("deduplicates identical content and separates distinct content", () =>
    Effect.gen(function* () {
      const store = yield* WorkjetSnapshotStore;
      const alpha = yield* store.put("alpha prompt");
      const alphaAgain = yield* store.put("alpha prompt");
      const beta = yield* store.put("beta prompt");

      assert.strictEqual(alphaAgain.digest, alpha.digest);
      assert.notStrictEqual(beta.digest, alpha.digest);
      assert.strictEqual(yield* store.get(alpha.digest), "alpha prompt");
      assert.strictEqual(yield* store.get(beta.digest), "beta prompt");
    }).pipe(Effect.provide(makeStoreLayer("t3code-workjet-snapshot-dedup-"))),
  );
});
