import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";
import { acquireProfileOwnership } from "../profileOwnership.ts";
import { ensurePinnedRuntimeInstalled, pinnedRuntimePaths } from "./pinnedRuntime.ts";
import { bundledRuntimeNodePath, BUNDLED_RUNTIME_RECEIPT } from "./bundledRuntime.ts";

const fixture = Effect.fn("test.bundled_runtime.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "workjet-bundle-test-" });
  const baseDir = path.join(root, "profile");
  const source = path.join(root, "source");
  const files = [
    "dist/bin.mjs",
    "dist/service-launcher.mjs",
    "runtime/node/bin/node",
    "runtime/node/LICENSE",
    "runtime/node/workjet-runtime.json",
  ];
  for (const file of files) {
    const target = path.join(source, "package", file);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    // Files model the package layout only. These tests do not run a real Node binary.
    yield* fs.writeFileString(target, "fixture\n");
  }
  yield* fs.writeFileString(path.join(source, "package/package.json"), '{"version":"1.2.3"}');
  const archivePath = path.join(root, "bundle.tgz");
  yield* Effect.try(() =>
    execFileSync("tar", ["-czf", archivePath, "-C", source, "package"], { timeout: 30_000 }),
  );
  const sha256 = createHash("sha256")
    .update(yield* fs.readFile(archivePath))
    .digest("hex");
  const input = {
    baseDir,
    version: "1.2.3",
    fs,
    path,
    bundle: { archivePath, sha256 },
    runner: ProcessRunner.ProcessRunner.of({
      run: () => Effect.die("Bundled install must never invoke npm"),
    }),
    validate: () => Effect.void,
  };
  return { input, fs, path, baseDir };
});

it.layer(NodeServices.layer)("bundled pinned runtime import", (it) => {
  it.effect("publishes and reuses the exact content without npm or the original archive", () =>
    Effect.gen(function* () {
      const { input, fs, path } = yield* fixture();
      const installed = yield* ensurePinnedRuntimeInstalled(input);
      assert.equal(yield* fs.readFileString(installed.sentinelPath), "1.2.3\n");
      assert.equal(
        yield* fs.readFileString(path.join(installed.versionDir, BUNDLED_RUNTIME_RECEIPT)),
        `${input.bundle.sha256}\n`,
      );
      assert.isTrue(yield* fs.exists(bundledRuntimeNodePath(installed.entryPath)));
      yield* fs.remove(input.bundle.archivePath);
      assert.deepEqual(yield* ensurePinnedRuntimeInstalled(input), installed);
      assert.deepEqual(yield* fs.readDirectory(path.dirname(installed.versionDir)), ["1.2.3"]);
    }),
  );
  it.effect("does not publish corrupt archives and cleans its private staging", () =>
    Effect.gen(function* () {
      const { input, fs, path, baseDir } = yield* fixture();
      yield* fs.writeFileString(input.bundle.archivePath, "corrupt");
      const error = yield* ensurePinnedRuntimeInstalled(input).pipe(Effect.flip);
      assert.equal(error._tag, "PinnedRuntimeInstallError");
      const final = pinnedRuntimePaths(path, baseDir, input.version);
      assert.isFalse(yield* fs.exists(final.versionDir));
      assert.deepEqual(yield* fs.readDirectory(path.dirname(final.versionDir)), []);
    }),
  );
  it.effect("rejects an archive with a different package version", () =>
    Effect.gen(function* () {
      const { input, fs, path, baseDir } = yield* fixture();
      yield* ensurePinnedRuntimeInstalled({ ...input, version: "1.2.4" }).pipe(Effect.flip);
      assert.isFalse(yield* fs.exists(pinnedRuntimePaths(path, baseDir, "1.2.4").versionDir));
    }),
  );
  it.effect("preserves the installed version when another artifact claims the same version", () =>
    Effect.gen(function* () {
      const { input, fs, path } = yield* fixture();
      const installed = yield* ensurePinnedRuntimeInstalled(input);
      yield* ensurePinnedRuntimeInstalled({
        ...input,
        bundle: { ...input.bundle, sha256: "0".repeat(64) },
      }).pipe(Effect.flip);
      assert.equal(
        yield* fs.readFileString(path.join(installed.versionDir, BUNDLED_RUNTIME_RECEIPT)),
        `${input.bundle.sha256}\n`,
      );
      assert.equal(yield* fs.readFileString(installed.entryPath), "fixture\n");
    }),
  );
  it.effect("rejects different content published by a nonparticipating writer during staging", () =>
    Effect.gen(function* () {
      const { input, fs, path, baseDir } = yield* fixture();
      const final = pinnedRuntimePaths(path, baseDir, input.version);
      yield* ensurePinnedRuntimeInstalled({
        ...input,
        validate: () =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(path.dirname(final.entryPath), { recursive: true });
            yield* fs.writeFileString(final.entryPath, "other build");
            yield* fs.writeFileString(final.sentinelPath, `${input.version}\n`);
            yield* fs.writeFileString(
              path.join(final.versionDir, BUNDLED_RUNTIME_RECEIPT),
              `${"b".repeat(64)}\n`,
            );
          }).pipe(Effect.orDie),
      }).pipe(Effect.flip);
      assert.equal(yield* fs.readFileString(final.entryPath), "other build");
      assert.equal(
        yield* fs.readFileString(path.join(final.versionDir, BUNDLED_RUNTIME_RECEIPT)),
        `${"b".repeat(64)}\n`,
      );
    }),
  );
  it.effect("adopts matching bundled content after publication contention and validates it", () =>
    Effect.gen(function* () {
      const { input, fs, path, baseDir } = yield* fixture();
      const final = pinnedRuntimePaths(path, baseDir, input.version);
      const validated: string[] = [];
      const installed = yield* ensurePinnedRuntimeInstalled({
        ...input,
        validate: (candidate) =>
          Effect.gen(function* () {
            validated.push(candidate.versionDir);
            if (candidate.versionDir !== final.versionDir) {
              yield* fs.copy(candidate.versionDir, final.versionDir);
              yield* fs.writeFileString(final.sentinelPath, `${input.version}\n`);
            }
            assert.isTrue(yield* fs.exists(bundledRuntimeNodePath(candidate.entryPath)));
          }).pipe(Effect.orDie),
      });
      assert.deepEqual(installed, final);
      assert.equal(validated.length, 2);
      assert.equal(validated[1], final.versionDir);
      assert.deepEqual(yield* fs.readDirectory(path.dirname(final.versionDir)), ["1.2.3"]);
    }),
  );
  it.effect("does not replace an incomplete existing version", () =>
    Effect.gen(function* () {
      const { input, fs, path, baseDir } = yield* fixture();
      const final = pinnedRuntimePaths(path, baseDir, input.version);
      yield* fs.makeDirectory(final.versionDir, { recursive: true });
      yield* fs.writeFileString(path.join(final.versionDir, "keep"), "owned");
      yield* ensurePinnedRuntimeInstalled(input).pipe(Effect.flip);
      assert.equal(yield* fs.readFileString(path.join(final.versionDir, "keep")), "owned");
    }),
  );
  it.effect("fails before publication while another connection owns installation", () =>
    Effect.gen(function* () {
      const { input, fs, path, baseDir } = yield* fixture();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.tryPromise(() => acquireProfileOwnership(baseDir, "installation")),
            (lock) => Effect.sync(() => lock.release()),
          );
          const error = yield* ensurePinnedRuntimeInstalled(input).pipe(Effect.flip);
          assert.equal(error._tag, "PinnedRuntimeInstallError");
          assert.isFalse(
            yield* fs.exists(pinnedRuntimePaths(path, baseDir, input.version).versionDir),
          );
        }),
      );
      yield* ensurePinnedRuntimeInstalled(input);
    }),
  );
});
