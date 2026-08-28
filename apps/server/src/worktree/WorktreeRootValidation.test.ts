import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import {
  inspectWorktreeRootCandidateWithPlatform,
  WorktreeRootValidationPlatformError,
  type WorktreeRootValidationPlatform,
} from "./WorktreeRootValidation.ts";

const healthyPlatform = (homeDirectory: string): WorktreeRootValidationPlatform => ({
  homeDirectory,
  checkWritable: () => Effect.void,
  readAvailableBytes: () => Effect.succeed(987_654_321),
});

const inspect = (
  requestedRoot: string,
  input: {
    readonly workspaceRoot: string;
    readonly baseDir: string;
    readonly platform: WorktreeRootValidationPlatform;
  },
) =>
  inspectWorktreeRootCandidateWithPlatform(requestedRoot, input.platform).pipe(
    Effect.provide(ServerConfig.layerTest(input.workspaceRoot, input.baseDir)),
  );

const expectInvalidReason = <A extends { readonly status: "valid" | "invalid" }>(
  inspection: A,
  reason: string,
) => {
  assert.equal(inspection.status, "invalid");
  if (inspection.status === "invalid") {
    assert.equal((inspection as A & { readonly reason: string }).reason, reason);
  }
};

describe("WorktreeRootValidation", () => {
  it.effect("requires an absolute, existing directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const container = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "worktree-root-shape-" }),
      );
      const workspaceRoot = path.join(container, "workspace");
      const baseDir = path.join(container, "server-base");
      const home = path.join(container, "home");
      const file = path.join(container, "not-a-directory");
      yield* fs.makeDirectory(workspaceRoot, { recursive: true });
      yield* fs.makeDirectory(home, { recursive: true });
      yield* fs.writeFileString(file, "file");
      const platform = healthyPlatform(home);

      expectInvalidReason(
        yield* inspect("relative/worktrees", { workspaceRoot, baseDir, platform }),
        "absolute-path-required",
      );
      expectInvalidReason(
        yield* inspect(path.join(container, "missing"), { workspaceRoot, baseDir, platform }),
        "not-found",
      );
      expectInvalidReason(
        yield* inspect(file, { workspaceRoot, baseDir, platform }),
        "not-directory",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports deterministic writeability and free-space health", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const container = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "worktree-root-health-" }),
      );
      const workspaceRoot = path.join(container, "workspace");
      const baseDir = path.join(container, "server-base");
      const home = path.join(container, "home");
      const candidate = path.join(container, "candidate");
      yield* Effect.forEach([workspaceRoot, home, candidate], (directory) =>
        fs.makeDirectory(directory, { recursive: true }),
      );

      const valid = yield* inspect(candidate, {
        workspaceRoot,
        baseDir,
        platform: healthyPlatform(home),
      });
      assert.deepInclude(valid, {
        status: "valid",
        canonicalRoot: candidate,
        writable: true,
        availableBytes: 987_654_321,
      });

      expectInvalidReason(
        yield* inspect(candidate, {
          workspaceRoot,
          baseDir,
          platform: {
            ...healthyPlatform(home),
            checkWritable: () =>
              Effect.fail(new WorktreeRootValidationPlatformError({ cause: "read only" })),
          },
        }),
        "not-writable",
      );
      const unavailable = yield* inspect(candidate, {
        workspaceRoot,
        baseDir,
        platform: {
          ...healthyPlatform(home),
          readAvailableBytes: () =>
            Effect.fail(new WorktreeRootValidationPlatformError({ cause: "statfs unavailable" })),
        },
      });
      expectInvalidReason(unavailable, "space-unavailable");
      if (unavailable.status === "invalid") assert.equal(unavailable.writable, true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("canonicalizes symlinks before enforcing checkout boundaries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const container = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "worktree-root-symlink-" }),
      );
      const workspaceRoot = path.join(container, "workspace");
      const insideCheckout = path.join(workspaceRoot, "linked-target");
      const candidateLink = path.join(container, "candidate-link");
      const baseDir = path.join(container, "server-base");
      const home = path.join(container, "home");
      yield* Effect.forEach([insideCheckout, home], (directory) =>
        fs.makeDirectory(directory, { recursive: true }),
      );
      yield* fs.symlink(insideCheckout, candidateLink);

      const inspection = yield* inspect(candidateLink, {
        workspaceRoot,
        baseDir,
        platform: healthyPlatform(home),
      });
      expectInvalidReason(inspection, "inside-checkout");
      if (inspection.status === "invalid") assert.equal(inspection.canonicalRoot, insideCheckout);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects every protected boundary category", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const container = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "worktree-root-boundaries-" }),
      );
      const workspaceRoot = path.join(container, "workspace");
      const insideCheckout = path.join(workspaceRoot, "nested");
      const baseDir = path.join(container, "server-base");
      const stateDir = path.join(baseDir, "userdata");
      const home = path.join(container, "home");
      yield* Effect.forEach([insideCheckout, home], (directory) =>
        fs.makeDirectory(directory, { recursive: true }),
      );
      const platform = healthyPlatform(home);

      expectInvalidReason(
        yield* inspect(path.resolve("/"), { workspaceRoot, baseDir, platform }),
        "filesystem-root",
      );
      expectInvalidReason(
        yield* inspect(home, { workspaceRoot, baseDir, platform }),
        "home-directory",
      );
      expectInvalidReason(
        yield* inspect(workspaceRoot, { workspaceRoot, baseDir, platform }),
        "project-boundary",
      );
      expectInvalidReason(
        yield* inspect(insideCheckout, { workspaceRoot, baseDir, platform }),
        "inside-checkout",
      );
      expectInvalidReason(
        yield* inspect(baseDir, { workspaceRoot, baseDir, platform }),
        "server-boundary",
      );
      expectInvalidReason(
        yield* inspect(stateDir, { workspaceRoot, baseDir, platform }),
        "server-boundary",
      );
      expectInvalidReason(
        yield* inspect(container, { workspaceRoot, baseDir, platform }),
        "contains-protected-location",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows the immutable default even though it lives under the server base", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const container = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "worktree-root-default-" }),
      );
      const workspaceRoot = path.join(container, "workspace");
      const baseDir = path.join(container, "server-base");
      const home = path.join(container, "home");
      yield* Effect.forEach([workspaceRoot, home], (directory) =>
        fs.makeDirectory(directory, { recursive: true }),
      );

      const inspection = yield* inspect("", {
        workspaceRoot,
        baseDir,
        platform: healthyPlatform(home),
      });
      assert.equal(inspection.status, "valid");
      if (inspection.status === "valid") {
        assert.equal(inspection.canonicalRoot, path.join(baseDir, "worktrees"));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
