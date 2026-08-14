import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const GREPPY_RUNTIME_PIN = {
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
} as const;

export const WORKJET_GREPPY_EXECUTABLE_ENV = "WORKJET_GREPPY_EXECUTABLE";
export const WORKJET_GREPPY_BUILD_TEMP_ROOT_ENV = "WORKJET_GREPPY_BUILD_TEMP_ROOT";
export const GREPPY_STORE_ENV = "GREPPY_STORE_DIR";

export const GREPPY_MODEL_ASSETS = [
  {
    repository: "metricspace/greppy-qwen35-mtp-q4km",
    file: "Qwen3.5-0.8B-MTP-Q4_K_M.gguf",
    destination: "crates/cli/assets/qwen35-0.8b-mtp-q4km/Qwen3.5-0.8B-MTP-Q4_K_M.gguf",
    sha256: "b36838d6969d415e08e7f91ab4aa069dcc260ec0801ea1d00bb5dab234181200",
    revision: "080231e8daee32cc185dd6070e2ca8095c6746bd",
  },
  {
    repository: "metricspace/greppy-qwen35-mtp-q4km",
    file: "tokenizer.json",
    destination: "crates/cli/assets/qwen35-0.8b-mtp-q4km/tokenizer.json",
    sha256: "5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42",
    revision: "e889ca56d5e2ad36b51df8bf96ad124fea09ac83",
  },
  {
    repository: "metricspace/embeddinggemma-300m-q4k",
    file: "embeddinggemma-300M-Q4_K.gguf",
    destination: "crates/cli/assets/embeddinggemma-300m-q4k/embeddinggemma-300M-Q4_K.gguf",
    sha256: "53f7d1c0d5c84a81e46f3bea8e0f17c94f459ffbaa8b06f7f52f1f09e58996f2",
    revision: "2c85ca142040bc24de9cbdebd7efae2e4ee656dd",
  },
  {
    repository: "metricspace/embeddinggemma-300m-q4k",
    file: "tokenizer.json",
    destination: "crates/cli/assets/embeddinggemma-300m-q4k/tokenizer.json",
    sha256: "6852f8d561078cc0cebe70ca03c5bfdd0d60a45f9d2e0e1e4cc05b68e9ec329e",
    revision: "2c85ca142040bc24de9cbdebd7efae2e4ee656dd",
  },
] as const;

const Sha256 = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const ModelAsset = Schema.Struct({
  hf_repo: Schema.String,
  hf_file: Schema.String,
  dest: Schema.String,
  sha256: Sha256,
  revision: Schema.String,
});
const ModelAssetsManifest = Schema.Struct({
  hf_host: Schema.Literal("https://huggingface.co"),
  revision: Schema.Literal("main"),
  assets: Schema.Array(ModelAsset),
});
const decodeModelAssetsManifestSchema = Schema.decodeUnknownEffect(ModelAssetsManifest);

export interface GreppyModelAsset {
  readonly repository: string;
  readonly file: string;
  readonly destination: string;
  readonly sha256: string;
  readonly revision: string;
}

export const decodePinnedGreppyModelManifest = (input: unknown) =>
  Effect.gen(function* () {
    const manifest = yield* decodeModelAssetsManifestSchema(input);
    const assets = manifest.assets.map(
      (asset): GreppyModelAsset => ({
        repository: asset.hf_repo,
        file: asset.hf_file,
        destination: asset.dest,
        sha256: asset.sha256,
        revision: asset.revision,
      }),
    );
    const expected = GREPPY_MODEL_ASSETS;
    if (
      assets.length !== expected.length ||
      assets.some((asset, index) => {
        const pinned = expected[index];
        return (
          pinned === undefined ||
          asset.repository !== pinned.repository ||
          asset.file !== pinned.file ||
          asset.destination !== pinned.destination ||
          asset.sha256 !== pinned.sha256 ||
          asset.revision !== pinned.revision
        );
      })
    ) {
      return yield* Effect.fail(new Error("Greppy model manifest does not match the source pin."));
    }
    return assets;
  });

export const GreppyIndexStatus = Schema.Struct({
  command: Schema.Literal("index-status"),
  status: Schema.Literals(["ok", "no_index", "unhealthy"]),
  healthy: Schema.Boolean,
  store_exists: Schema.Boolean,
  background_state: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  embedding_complete: Schema.Boolean,
  fresh: Schema.Boolean,
  schema_current: Schema.Boolean,
  integrity_ok: Schema.Boolean,
  project_present: Schema.Boolean,
});
export type GreppyIndexStatus = typeof GreppyIndexStatus.Type;
export const decodeGreppyIndexStatus = Schema.decodeUnknownEffect(GreppyIndexStatus);

export const GreppySemanticSearchHit = Schema.Struct({
  file_path: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2_000)),
  start_line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  end_line: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  summary: Schema.Array(Schema.String),
});
export type GreppySemanticSearchHit = typeof GreppySemanticSearchHit.Type;

export const GreppySemanticSearchV1 = Schema.Struct({
  schema_version: Schema.Literal("greppy.semantic-search.v1"),
  command: Schema.Literal("search"),
  status: Schema.String,
  hits: Schema.Array(GreppySemanticSearchHit),
});
export type GreppySemanticSearchV1 = typeof GreppySemanticSearchV1.Type;

const GreppySemanticSearchLegacyHit = Schema.Struct({
  file: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2_000)),
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  end_line: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  summary: Schema.Array(Schema.String),
});

const GreppySemanticSearchLegacyV1 = Schema.Struct({
  schema_version: Schema.Literal("greppy.semantic-search.v1"),
  command: Schema.Literal("search"),
  status: Schema.String,
  hits: Schema.Array(GreppySemanticSearchLegacyHit),
});

const decodeGreppySemanticSearchWire = Schema.decodeUnknownEffect(
  Schema.Union([GreppySemanticSearchV1, GreppySemanticSearchLegacyV1]),
);

export const decodeGreppySemanticSearchV1 = (
  input: unknown,
): Effect.Effect<GreppySemanticSearchV1, Schema.SchemaError> =>
  decodeGreppySemanticSearchWire(input).pipe(
    Effect.map((response) => ({
      schema_version: response.schema_version,
      command: response.command,
      status: response.status,
      hits: response.hits.map((hit) =>
        "file_path" in hit
          ? hit
          : {
              file_path: hit.file,
              start_line: hit.line,
              ...(hit.end_line === undefined ? {} : { end_line: hit.end_line }),
              summary: hit.summary,
            },
      ),
    })),
  );

export const GreppyRuntimeAvailability = Schema.Literals([
  "available",
  "unavailable",
  "unsupported",
]);
export type GreppyRuntimeAvailability = typeof GreppyRuntimeAvailability.Type;

export const GreppyRuntimeSource = Schema.Literals(["override", "managed", "path"]);
export type GreppyRuntimeSource = typeof GreppyRuntimeSource.Type;

export const GreppyRuntimeReason = Schema.Literals([
  "unsupported-host",
  "override-invalid",
  "managed-invalid",
  "path-unavailable",
  "binary-unavailable",
  "version-mismatch",
  "surface-mismatch",
  "timeout",
  "process-exit",
  "malformed-response",
  "oversized-response",
  "index-unavailable",
  "install-failed",
]);
export type GreppyRuntimeReason = typeof GreppyRuntimeReason.Type;

export interface GreppyRuntimeSnapshot {
  readonly availability: GreppyRuntimeAvailability;
  readonly source?: GreppyRuntimeSource;
  readonly reason?: GreppyRuntimeReason;
  readonly version: typeof GREPPY_RUNTIME_PIN.version;
  readonly installSupported: boolean;
}

export const isGreppyIndexReady = (status: GreppyIndexStatus): boolean =>
  status.status === "ok" &&
  status.healthy &&
  status.store_exists &&
  status.background_state !== "refreshing" &&
  status.embedding_complete &&
  status.fresh &&
  status.schema_current &&
  status.integrity_ok &&
  status.project_present;

export const isGreppyIndexing = (status: GreppyIndexStatus): boolean =>
  status.background_state === "refreshing";
