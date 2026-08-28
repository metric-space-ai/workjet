#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off -- The lock digests raw artifact bytes before entering an Effect runtime.

import * as NodeCrypto from "node:crypto";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  canonicalCapabilityJson,
  WEB_STACK_TOOL_CONTRACT,
} from "@metric-space-ai/workjet-capabilities";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

import {
  CAPABILITY_VERSION_LOCK_FILENAME,
  CODE_SURFACE_EXPECTATIONS,
  CTOX_SHELL_MANIFEST_PATH,
  describeCapabilityLockDivergence,
  findCapabilityLockDivergences,
  GENERATED_CONTRACT_PATH,
  parseSurfaceVersionConstants,
  renderCapabilityVersionLock,
  resolveCapabilityVersionLock,
  WEB_STACK_BIN_PATH,
  WEB_STACK_CONTRACT_PATH,
  WEB_STACK_FIXTURE_PATH,
  type CapabilityVersionLockInputs,
  type CtoxHostArtifactManifest,
  type SurfaceConstantName,
  type WebStackAdapterFixture,
  type WebStackContractDocument,
} from "./lib/capability-version-lock.ts";

/**
 * Release-assembly gate for the canonical capability version lock.
 *
 * `--check` (what release assembly and CI run) fails when the two hosts resolve
 * different manifests, JSON schemas, implementation revisions, or artifact
 * hashes, and when the committed lock file no longer matches what the sources
 * resolve to. Without `--check` it rewrites the lock file.
 */

export class CapabilityLockDivergedError extends Schema.TaggedErrorClass<CapabilityLockDivergedError>()(
  "CapabilityLockDivergedError",
  {
    divergences: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return [
      "Code and CTOX do not resolve one canonical capability version.",
      ...this.divergences.map((line) => `  - ${line}`),
      "Release assembly is blocked until both hosts resolve the same capability definition.",
    ].join("\n");
  }
}

export class CapabilityLockOutOfDateError extends Schema.TaggedErrorClass<CapabilityLockOutOfDateError>()(
  "CapabilityLockOutOfDateError",
  {
    lockPath: Schema.String,
    reason: Schema.Literals(["missing", "stale"]),
  },
) {
  override get message(): string {
    return this.reason === "missing"
      ? `${this.lockPath} does not exist. Run 'pnpm run capabilities:lock:generate'.`
      : `${this.lockPath} is out of date. Run 'pnpm run capabilities:lock:generate' and commit the result.`;
  }
}

const sha256 = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");

const WebStackContractSchema = Schema.Struct({
  schemaVersion: Schema.Number,
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      capabilityId: Schema.String,
      contractVersion: Schema.String,
      inputSchema: Schema.Unknown,
      outputSchema: Schema.Unknown,
    }),
  ),
});

const WebStackFixtureSchema = Schema.Struct({
  schemaVersion: Schema.Number,
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      capabilityId: Schema.String,
      contractVersion: Schema.String,
    }),
  ),
});

const CtoxHostArtifactSchema = Schema.Struct({
  schema: Schema.String,
  version: Schema.String,
  sourceCommit: Schema.String,
  archiveSha256: Schema.String,
  embeddedManifestSha256: Schema.String,
  manifestSha256: Schema.String,
});

const decodeJsonDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeContract = Schema.decodeUnknownEffect(Schema.fromJsonString(WebStackContractSchema));
const decodeFixture = Schema.decodeUnknownEffect(Schema.fromJsonString(WebStackFixtureSchema));
const decodeHostArtifact = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CtoxHostArtifactSchema),
);

const CTOX_SURFACE_CONSTANTS = [
  "SEARCH_SURFACE_VERSION",
  "RESEARCH_SURFACE_VERSION",
  "BROWSER_SURFACE_VERSION",
] as const satisfies ReadonlyArray<SurfaceConstantName>;

export const readCapabilityVersionLockInputs = Effect.fn("readCapabilityVersionLockInputs")(
  function* (repoRoot: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const read = (relative: string) => fs.readFileString(path.join(repoRoot, relative));

    const contractJson = yield* read(WEB_STACK_CONTRACT_PATH);
    const fixtureJson = yield* read(WEB_STACK_FIXTURE_PATH);
    const ctoxBinSource = yield* read(WEB_STACK_BIN_PATH);
    const generatedContract = yield* read(GENERATED_CONTRACT_PATH);
    const shellManifestJson = yield* read(CTOX_SHELL_MANIFEST_PATH);

    const ctoxContract = (yield* decodeContract(contractJson)) satisfies WebStackContractDocument;
    const ctoxFixture = (yield* decodeFixture(fixtureJson)) satisfies WebStackAdapterFixture;
    const shellManifest = (yield* decodeHostArtifact(
      shellManifestJson,
    )) satisfies CtoxHostArtifactManifest;

    // Both hosts carry the same capability contract in different FORMATS, so
    // comparing their raw byte digests would be theatre. Canonical content
    // equality is the honest equivalence test, and it fails on a hand-edit to
    // either artifact.
    const codeContractArtifactIsByteCurrent =
      canonicalCapabilityJson(WEB_STACK_TOOL_CONTRACT) ===
      canonicalCapabilityJson(yield* decodeJsonDocument(contractJson));

    const codeSurfaceSources: Record<string, string> = {};
    for (const [name, expectation] of Object.entries(CODE_SURFACE_EXPECTATIONS)) {
      const source = yield* read(expectation.file);
      codeSurfaceSources[name] = Object.entries(
        parseSurfaceVersionConstants(source, [expectation.constant]),
      )
        .map(([, value]) => value)
        .join("");
    }

    return {
      ctoxContract,
      ctoxFixture,
      ctoxSurfaceVersions: parseSurfaceVersionConstants(ctoxBinSource, CTOX_SURFACE_CONSTANTS),
      codeSurfaceVersions: codeSurfaceSources,
      codeContractArtifactSha256: sha256(generatedContract),
      ctoxContractArtifactSha256: sha256(contractJson),
      codeContractArtifactIsByteCurrent,
      ctoxHostArtifact: {
        schema: shellManifest.schema,
        version: shellManifest.version,
        sourceCommit: shellManifest.sourceCommit,
        archiveSha256: shellManifest.archiveSha256,
        embeddedManifestSha256: shellManifest.embeddedManifestSha256,
        manifestSha256: shellManifest.manifestSha256,
      },
      sha256,
    } satisfies CapabilityVersionLockInputs;
  },
);

/**
 * Resolve both hosts and refuse divergence. Release assembly calls this
 * directly, so a divergent capability can never be packaged.
 */
export const enforceCapabilityVersionLock = Effect.fn("enforceCapabilityVersionLock")(function* (
  repoRoot: string,
) {
  const inputs = yield* readCapabilityVersionLockInputs(repoRoot);
  const document = resolveCapabilityVersionLock(inputs);
  const divergences = findCapabilityLockDivergences(document, inputs);

  if (divergences.length > 0) {
    return yield* new CapabilityLockDivergedError({
      divergences: divergences.map(describeCapabilityLockDivergence),
    });
  }

  return document;
});

export const checkCapabilityVersionLock = Effect.fn("checkCapabilityVersionLock")(function* (
  repoRoot: string,
  check: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const document = yield* enforceCapabilityVersionLock(repoRoot);
  const rendered = renderCapabilityVersionLock(document);
  const lockPath = path.join(repoRoot, CAPABILITY_VERSION_LOCK_FILENAME);

  if (check) {
    if (!(yield* fs.exists(lockPath))) {
      return yield* new CapabilityLockOutOfDateError({ lockPath, reason: "missing" });
    }
    // Compared by CONTENT, not by bytes: `vp fmt` runs repo-wide and reflows
    // this file, and a lock that went stale on whitespace would train everyone
    // to regenerate it without reading what changed.
    const committed = yield* decodeJsonDocument(yield* fs.readFileString(lockPath));
    if (canonicalCapabilityJson(committed) !== canonicalCapabilityJson(document)) {
      return yield* new CapabilityLockOutOfDateError({ lockPath, reason: "stale" });
    }
    yield* Effect.log(
      `[capability-lock] ${CAPABILITY_VERSION_LOCK_FILENAME} is up to date and both hosts resolve one capability version.`,
    );
    return;
  }

  yield* fs.writeFileString(lockPath, rendered);
  yield* Effect.log(`[capability-lock] Wrote ${lockPath}.`);
});

export const checkCapabilityVersionLockCommand = Command.make(
  "check-capability-version-lock",
  {
    repoRoot: Flag.string("repo-root").pipe(
      Flag.withDescription("Repository root to scan. Defaults to the current working directory."),
      Flag.withDefault("."),
    ),
    check: Flag.boolean("check").pipe(
      Flag.withDescription("Fail instead of writing when the committed lock is out of date."),
      Flag.withDefault(false),
    ),
  },
  ({ repoRoot, check }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      yield* checkCapabilityVersionLock(path.resolve(repoRoot), check);
    }),
).pipe(
  Command.withDescription(
    "Enforce one canonical capability version lock across the Code and CTOX hosts.",
  ),
);

if (import.meta.main) {
  Command.run(checkCapabilityVersionLockCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
