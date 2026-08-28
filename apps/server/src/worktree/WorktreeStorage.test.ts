import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WorktreeStorage from "./WorktreeStorage.ts";

function makeLiveLayer(input: {
  readonly workspaceRoot: string;
  readonly baseDir: string;
  readonly automaticWorktreeRoot?: string;
  readonly previousAutomaticWorktreeRoots?: ReadonlyArray<string>;
}) {
  const settingsLayer = ServerSettings.layerTest({
    automaticWorktreeRoot: input.automaticWorktreeRoot ?? "",
    previousAutomaticWorktreeRoots: [...(input.previousAutomaticWorktreeRoots ?? [])],
  });
  const configLayer = ServerConfig.layerTest(input.workspaceRoot, input.baseDir);
  const storageLayer = WorktreeStorage.layer.pipe(
    Layer.provide(settingsLayer),
    Layer.provide(configLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  return Layer.merge(settingsLayer, storageLayer);
}

describe("WorktreeStorage", () => {
  it.effect("inspects candidates with configured, default, and effective context", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const container = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "worktree-storage-inspect-" }),
      );
      const workspaceRoot = path.join(container, "workspace");
      const baseDir = path.join(container, "base");
      const candidate = path.join(container, "candidate");
      yield* Effect.forEach([workspaceRoot, candidate], (directory) =>
        fs.makeDirectory(directory, { recursive: true }),
      );

      const inspection = yield* Effect.gen(function* () {
        const storage = yield* WorktreeStorage.WorktreeStorage;
        return yield* storage.inspect(candidate);
      }).pipe(
        Effect.provide(makeLiveLayer({ workspaceRoot, baseDir, automaticWorktreeRoot: candidate })),
      );

      assert.equal(inspection.status, "valid");
      assert.equal(inspection.configuredRoot, candidate);
      assert.equal(inspection.effectiveRoot, candidate);
      assert.equal(inspection.defaultRoot, path.join(baseDir, "worktrees"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses collision-resistant repository and ref path components", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const container = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "worktree-storage-hashes-" }),
      );
      const workspaceRoot = path.join(container, "workspace");
      const baseDir = path.join(container, "base");
      const automaticRoot = path.join(container, "automatic");
      const commonA = path.join(container, "owner-a", "same-name", ".git");
      const commonB = path.join(container, "owner-b", "same-name", ".git");
      yield* Effect.forEach([workspaceRoot, automaticRoot, commonA, commonB], (directory) =>
        fs.makeDirectory(directory, { recursive: true }),
      );

      const paths = yield* Effect.gen(function* () {
        const storage = yield* WorktreeStorage.WorktreeStorage;
        return yield* Effect.all([
          storage.resolveAutomaticPath({
            cwd: workspaceRoot,
            gitCommonDir: commonA,
            ref: "feature/a",
          }),
          storage.resolveAutomaticPath({
            cwd: workspaceRoot,
            gitCommonDir: commonB,
            ref: "feature/a",
          }),
          storage.resolveAutomaticPath({
            cwd: workspaceRoot,
            gitCommonDir: commonA,
            ref: "feature-a",
          }),
        ]);
      }).pipe(
        Effect.provide(
          makeLiveLayer({ workspaceRoot, baseDir, automaticWorktreeRoot: automaticRoot }),
        ),
      );

      assert.notEqual(path.dirname(paths[0]), path.dirname(paths[1]));
      assert.notEqual(path.basename(paths[0]), path.basename(paths[2]));
      for (const resolved of paths) assert.isTrue(resolved.startsWith(`${automaticRoot}/`));
      assert.match(path.basename(path.dirname(paths[0])), /^same-name-[a-f0-9]{12}$/);
      assert.match(path.basename(paths[0]), /^feature-a-[a-f0-9]{12}$/);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("switches A to B dynamically on one live service and retains all trusted roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const container = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "worktree-storage-dynamic-" }),
      );
      const workspaceRoot = path.join(container, "workspace");
      const baseDir = path.join(container, "base");
      const rootA = path.join(container, "root-a");
      const rootB = path.join(container, "root-b");
      const priorRoot = path.join(container, "prior-root");
      const commonDir = path.join(container, "repository", ".git");
      yield* Effect.forEach([workspaceRoot, rootA, rootB, priorRoot, commonDir], (directory) =>
        fs.makeDirectory(directory, { recursive: true }),
      );

      const result = yield* Effect.gen(function* () {
        const storage = yield* WorktreeStorage.WorktreeStorage;
        const settings = yield* ServerSettings.ServerSettingsService;
        const atA = yield* storage.resolveAutomaticPath({
          cwd: workspaceRoot,
          gitCommonDir: commonDir,
          ref: "feature/a",
        });
        yield* settings.updateSettings({ automaticWorktreeRoot: rootB });
        const atB = yield* storage.resolveAutomaticPath({
          cwd: workspaceRoot,
          gitCommonDir: commonDir,
          ref: "feature/b",
        });
        return { atA, atB, trustedRoots: yield* storage.trustedRoots };
      }).pipe(
        Effect.provide(
          makeLiveLayer({
            workspaceRoot,
            baseDir,
            automaticWorktreeRoot: rootA,
            previousAutomaticWorktreeRoots: [priorRoot],
          }),
        ),
      );

      assert.isTrue(result.atA.startsWith(`${rootA}/`));
      assert.isTrue(result.atB.startsWith(`${rootB}/`));
      assert.sameMembers(
        [...result.trustedRoots],
        [path.join(baseDir, "worktrees"), rootB, priorRoot, rootA],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "does not follow a replaced prior-root symlink while building the review allowlist",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const container = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "worktree-storage-prior-symlink-" }),
        );
        const workspaceRoot = path.join(container, "workspace");
        const baseDir = path.join(container, "base");
        const automaticRoot = path.join(container, "automatic");
        const formerRoot = path.join(container, "former-root");
        const outside = path.join(container, "outside");
        yield* Effect.forEach([workspaceRoot, automaticRoot, outside], (directory) =>
          fs.makeDirectory(directory, { recursive: true }),
        );
        yield* fs.symlink(outside, formerRoot);

        const trustedRoots = yield* Effect.gen(function* () {
          const storage = yield* WorktreeStorage.WorktreeStorage;
          return yield* storage.trustedRoots;
        }).pipe(
          Effect.provide(
            makeLiveLayer({
              workspaceRoot,
              baseDir,
              automaticWorktreeRoot: automaticRoot,
              previousAutomaticWorktreeRoots: [formerRoot],
            }),
          ),
        );

        assert.include(trustedRoots, formerRoot);
        assert.notInclude(trustedRoots, outside);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
