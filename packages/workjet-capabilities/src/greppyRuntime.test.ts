import {
  GreppyRuntimeAvailability as ContractGreppyRuntimeAvailability,
  GreppyRuntimeReason as ContractGreppyRuntimeReason,
  GreppyRuntimeSnapshot as ContractGreppyRuntimeSnapshot,
  GreppyRuntimeSource as ContractGreppyRuntimeSource,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  decodeGreppyIndexStatus,
  decodeGreppySemanticSearchV1,
  decodePinnedGreppyModelManifest,
  GREPPY_MODEL_ASSETS,
  GREPPY_RUNTIME_PIN,
  GreppyRuntimeAvailability,
  GreppyRuntimeReason,
  GreppyRuntimeSnapshot,
  GreppyRuntimeSource,
  isGreppyIndexReady,
  isGreppyIndexing,
} from "./greppyRuntime.ts";

describe("Greppy runtime contract", () => {
  it("re-exports the canonical contracts schemas", () => {
    assert.strictEqual(GreppyRuntimeAvailability, ContractGreppyRuntimeAvailability);
    assert.strictEqual(GreppyRuntimeReason, ContractGreppyRuntimeReason);
    assert.strictEqual(GreppyRuntimeSnapshot, ContractGreppyRuntimeSnapshot);
    assert.strictEqual(GreppyRuntimeSource, ContractGreppyRuntimeSource);
  });

  it("pins the exact immutable 0.3.1 source and CPU-safe locked build", () => {
    assert.deepEqual(GREPPY_RUNTIME_PIN, {
      version: "0.3.1",
      rustToolchain: "1.95.0",
      commit: "de078b47d1df5df7c086e4591162517328f979ec",
      sourceUrl:
        "https://github.com/metric-space-ai/greppy/archive/de078b47d1df5df7c086e4591162517328f979ec.tar.gz",
      sourceSha256: "20e54f1339f1ec138665e0bc0371d4557a96ce166ce4620ecc3f0ad4266f01cf",
      sourceLicense: "Apache-2.0",
      archivePrefix: "greppy-de078b47d1df5df7c086e4591162517328f979ec/",
      modelManifestPath: "crates/cli/assets/MODEL_ASSETS.json",
      binaryRelativePath: "target/release/greppy",
      cargoArgs: [
        "+1.95.0",
        "build",
        "--locked",
        "--release",
        "--bin",
        "greppy",
        "--no-default-features",
        "--features",
        "cpu-only",
      ],
    });
    assert.equal(GREPPY_MODEL_ASSETS.length, 4);
  });

  it.effect("decodes only the four exact source-declared model assets", () =>
    Effect.gen(function* () {
      const manifest = {
        hf_host: "https://huggingface.co",
        revision: "main",
        assets: GREPPY_MODEL_ASSETS.map((asset) => ({
          hf_repo: asset.repository,
          hf_file: asset.file,
          dest: asset.destination,
          sha256: asset.sha256,
          revision: asset.revision,
        })),
      };
      assert.deepEqual(yield* decodePinnedGreppyModelManifest(manifest), [...GREPPY_MODEL_ASSETS]);
      const changed: unknown = {
        ...manifest,
        assets: manifest.assets.map((asset, index) =>
          index === 0 ? { ...asset, sha256: "0".repeat(64) } : asset,
        ),
      };
      const changedExit = yield* decodePinnedGreppyModelManifest(changed).pipe(Effect.exit);
      assert.equal(changedExit._tag, "Failure");
      const missingExit = yield* decodePinnedGreppyModelManifest({
        ...manifest,
        assets: manifest.assets.slice(0, 3),
      }).pipe(Effect.exit);
      assert.equal(missingExit._tag, "Failure");
    }),
  );

  it.effect("decodes the actual index-status and semantic-search v1 surfaces", () =>
    Effect.gen(function* () {
      const health = yield* decodeGreppyIndexStatus({
        command: "index-status",
        status: "ok",
        healthy: true,
        store_exists: true,
        background_state: null,
        embedding_complete: true,
        fresh: true,
        schema_current: true,
        integrity_ok: true,
        project_present: true,
        store_path: "/not-part-of-the-portable-result",
      });
      assert.isTrue(isGreppyIndexReady(health));
      assert.isFalse(isGreppyIndexing(health));

      const indexing = yield* decodeGreppyIndexStatus({
        ...health,
        status: "unhealthy",
        healthy: false,
        background_state: "refreshing",
      });
      assert.isTrue(isGreppyIndexing(indexing));

      const search = yield* decodeGreppySemanticSearchV1({
        schema_version: "greppy.semantic-search.v1",
        command: "search",
        status: "ok",
        hits: [
          {
            file_path: "src/retry.ts",
            start_line: 17,
            end_line: 23,
            summary: ["Retries failed requests."],
          },
        ],
      });
      assert.equal(search.hits[0]?.file_path, "src/retry.ts");
      const legacySearch = yield* decodeGreppySemanticSearchV1({
        schema_version: "greppy.semantic-search.v1",
        command: "search",
        status: "ok",
        hits: [
          {
            file: "src/legacy.ts",
            line: 8,
            summary: ["Legacy 0.3.1 wire aliases."],
          },
        ],
      });
      assert.deepEqual(legacySearch.hits[0], {
        file_path: "src/legacy.ts",
        start_line: 8,
        summary: ["Legacy 0.3.1 wire aliases."],
      });
      const invalidExit = yield* decodeGreppySemanticSearchV1({
        ...search,
        schema_version: "invented",
      }).pipe(Effect.exit);
      assert.equal(invalidExit._tag, "Failure");
    }),
  );
});
