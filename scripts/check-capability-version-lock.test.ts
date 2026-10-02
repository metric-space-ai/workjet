// @effect-diagnostics nodeBuiltinImport:off -- The lock digests raw artifact bytes and the mutation proofs rewrite them on disk.
import { createHash } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { dualHostCapabilityIds } from "@metric-space-ai/workjet-capabilities";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  CAPABILITY_VERSION_LOCK_FILENAME,
  describeCapabilityLockDivergence,
  findCapabilityLockDivergences,
  parseSurfaceVersionConstants,
  renderCapabilityVersionLock,
  resolveCapabilityVersionLock,
  WEB_STACK_BIN_PATH,
  WEB_STACK_CONTRACT_PATH,
  WEB_STACK_FIXTURE_PATH,
  type CapabilityVersionLockInputs,
} from "./lib/capability-version-lock.ts";
import {
  checkCapabilityVersionLock,
  enforceCapabilityVersionLock,
  readCapabilityVersionLockInputs,
} from "./check-capability-version-lock.ts";

const repoRoot = new URL("..", import.meta.url).pathname;

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const realInputs = readCapabilityVersionLockInputs(repoRoot).pipe(
  Effect.provide(NodeServices.layer),
);

/** Mutate one on-disk artifact, run the real gate, then restore the bytes. */
const withMutatedFile = Effect.fn("withMutatedFile")(function* <A, E, R>(
  relativePath: string,
  mutate: (original: string) => string,
  body: Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolute = path.join(repoRoot, relativePath);
  const original = yield* fs.readFileString(absolute);
  const mutated = mutate(original);
  assert.notStrictEqual(mutated, original, `mutation of ${relativePath} changed nothing`);
  yield* fs.writeFileString(absolute, mutated);
  return yield* Effect.onExit(body, () =>
    fs.writeFileString(absolute, original).pipe(Effect.orDie),
  );
});

describe("capability version lock — canonical resolution", () => {
  it.effect("covers every dual-host capability and nothing else", () =>
    Effect.gen(function* () {
      const inputs = yield* realInputs;
      const document = resolveCapabilityVersionLock(inputs);

      assert.deepStrictEqual(
        document.capabilities.map(({ capabilityId }) => capabilityId),
        [...dualHostCapabilityIds],
      );
      for (const capability of document.capabilities) {
        assert.ok(capability.adapters.code.length > 0, capability.capabilityId);
        assert.ok(capability.adapters.ctox.length > 0, capability.capabilityId);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("resolves both hosts identically today, with no divergence", () =>
    Effect.gen(function* () {
      const inputs = yield* realInputs;
      const document = resolveCapabilityVersionLock(inputs);
      assert.deepStrictEqual(findCapabilityLockDivergences(document, inputs), []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("states a reason for every dimension it cannot enforce", () =>
    Effect.gen(function* () {
      const inputs = yield* realInputs;
      const document = resolveCapabilityVersionLock(inputs);

      for (const capability of document.capabilities) {
        for (const [dimension, record] of Object.entries(capability.dimensions)) {
          if (record.enforcement === "cross-host") {
            assert.ok(
              record.ctox !== null && record.ctoxSource !== null,
              `${capability.capabilityId}/${dimension} claims cross-host enforcement without a CTOX source`,
            );
            continue;
          }
          assert.strictEqual(record.ctox, null);
          assert.ok(
            record.reason.length > 80,
            `${capability.capabilityId}/${dimension} is unenforceable without stating why`,
          );
        }
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("is deterministic and re-runnable", () =>
    Effect.gen(function* () {
      const inputs = yield* realInputs;
      assert.strictEqual(
        renderCapabilityVersionLock(resolveCapabilityVersionLock(inputs)),
        renderCapabilityVersionLock(resolveCapabilityVersionLock(inputs)),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the committed lock file in sync with the sources", () =>
    checkCapabilityVersionLock(repoRoot, true).pipe(Effect.provide(NodeServices.layer)),
  );

  it("parses surface-version constants from both Rust and TypeScript spellings", () => {
    assert.deepStrictEqual(
      parseSurfaceVersionConstants(
        [
          'const SEARCH_SURFACE_VERSION: &str = "workjet-web-stack-json-v1";',
          'export const WEB_STACK_SURFACE_VERSION = "workjet-web-stack-json-v1\\n";',
        ].join("\n"),
        ["SEARCH_SURFACE_VERSION", "WEB_STACK_SURFACE_VERSION"],
      ),
      {
        SEARCH_SURFACE_VERSION: "workjet-web-stack-json-v1",
        WEB_STACK_SURFACE_VERSION: "workjet-web-stack-json-v1",
      },
    );
  });
});

describe("capability version lock — mutation proofs (the gate bites)", () => {
  const mutated = (
    inputs: CapabilityVersionLockInputs,
    overrides: Partial<CapabilityVersionLockInputs>,
  ): CapabilityVersionLockInputs => ({ ...inputs, ...overrides, sha256 });

  it.effect("fails when the two hosts publish different capability manifests", () =>
    Effect.gen(function* () {
      const inputs = yield* realInputs;
      const drifted = mutated(inputs, {
        ctoxFixture: {
          ...inputs.ctoxFixture,
          tools: inputs.ctoxFixture.tools.map((tool) =>
            tool.name === "web_search" ? { ...tool, contractVersion: "1.0.1" } : tool,
          ),
        },
      });
      const divergences = findCapabilityLockDivergences(
        resolveCapabilityVersionLock(drifted),
        drifted,
      );

      assert.deepStrictEqual(
        divergences.map(({ capabilityId, dimension }) => `${capabilityId}/${dimension}`),
        ["web-search/manifest"],
      );
      assert.match(describeCapabilityLockDivergence(divergences[0]!), /different manifest/u);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails when the two hosts resolve different JSON schemas", () =>
    Effect.gen(function* () {
      const inputs = yield* realInputs;
      const drifted = mutated(inputs, {
        ctoxContract: {
          ...inputs.ctoxContract,
          tools: inputs.ctoxContract.tools.map((tool) =>
            tool.name === "web_browser_automate"
              ? { ...tool, inputSchema: { type: "object", additionalProperties: true } }
              : tool,
          ),
        },
      });
      const divergences = findCapabilityLockDivergences(
        resolveCapabilityVersionLock(drifted),
        drifted,
      );

      assert.deepStrictEqual(
        divergences.map(({ capabilityId, dimension }) => `${capabilityId}/${dimension}`),
        ["web-stack-browser/schemas"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails when the two hosts run different implementation revisions", () =>
    Effect.gen(function* () {
      const inputs = yield* realInputs;
      const drifted = mutated(inputs, {
        ctoxSurfaceVersions: {
          ...inputs.ctoxSurfaceVersions,
          SEARCH_SURFACE_VERSION: "workjet-web-stack-json-v2",
        },
      });
      const divergences = findCapabilityLockDivergences(
        resolveCapabilityVersionLock(drifted),
        drifted,
      );

      assert.deepStrictEqual(
        divergences.map(({ capabilityId, dimension }) => `${capabilityId}/${dimension}`),
        ["web-search/implementationRevision"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails when the two hosts carry different contract artifacts", () =>
    Effect.gen(function* () {
      const inputs = yield* realInputs;
      const drifted = mutated(inputs, { codeContractArtifactIsByteCurrent: false });
      const divergences = findCapabilityLockDivergences(
        resolveCapabilityVersionLock(drifted),
        drifted,
      );

      assert.deepStrictEqual(
        divergences.map(({ capabilityId, dimension }) => `${capabilityId}/${dimension}`),
        ["web-search/artifactHash", "web-stack-browser/artifactHash"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("the real release gate refuses a hand-edited CTOX schema artifact", () =>
    withMutatedFile(
      WEB_STACK_CONTRACT_PATH,
      (original) => original.replace('"maxItems": 32', '"maxItems": 64'),
      Effect.gen(function* () {
        const failure = yield* enforceCapabilityVersionLock(repoRoot).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "CapabilityLockDivergedError");
        assert.match(failure.message, /web-stack-browser|web-search/u);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("the real release gate refuses a hand-edited CTOX surface version", () =>
    withMutatedFile(
      WEB_STACK_BIN_PATH,
      (original) =>
        original.replace(
          '"workjet-web-stack-browser-json-v1"',
          '"workjet-web-stack-browser-json-v2"',
        ),
      Effect.gen(function* () {
        const failure = yield* enforceCapabilityVersionLock(repoRoot).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "CapabilityLockDivergedError");
        assert.match(failure.message, /implementationRevision/u);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("the real release gate refuses a hand-edited CTOX adapter fixture", () =>
    withMutatedFile(
      WEB_STACK_FIXTURE_PATH,
      (original) => original.replace('"web_read"', '"web_reed"'),
      Effect.gen(function* () {
        const failure = yield* enforceCapabilityVersionLock(repoRoot).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "CapabilityLockDivergedError");
        assert.match(failure.message, /web-search: hosts resolve different manifest/u);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not go stale on formatting alone", () =>
    withMutatedFile(
      CAPABILITY_VERSION_LOCK_FILENAME,
      // `vp fmt` runs repo-wide and reflows this file; only content may matter.
      (original) => original.replaceAll("\n  ", "\n      "),
      checkCapabilityVersionLock(repoRoot, true),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a committed lock that no longer matches what the sources resolve", () =>
    withMutatedFile(
      CAPABILITY_VERSION_LOCK_FILENAME,
      (original) => original.replace('"version": "1.0.0"', '"version": "9.9.9"'),
      Effect.gen(function* () {
        const failure = yield* checkCapabilityVersionLock(repoRoot, true).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "CapabilityLockOutOfDateError");
        assert.match(failure.message, /capabilities:lock:generate/u);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
