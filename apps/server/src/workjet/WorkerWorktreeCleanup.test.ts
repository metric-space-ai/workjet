// @effect-diagnostics nodeBuiltinImport:off -- Test-only symlink fixture exercises real host filesystem behavior.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import { canonicalWorkerRemovalPath } from "./WorkerWorktreeCleanup.ts";

describe("canonicalWorkerRemovalPath", () => {
  it.effect("accepts the owned checkout and rejects direct and nested symlink redirects", () =>
    Effect.gen(function* () {
      const fixture = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-worker-cleanup-")),
      );
      try {
        const trustedRoot = NodePath.join(fixture, "trusted");
        const workspaceRoot = NodePath.join(fixture, "workspace");
        const outsideRoot = NodePath.join(fixture, "outside");
        const inside = NodePath.join(trustedRoot, "worker");
        const outside = NodePath.join(outsideRoot, "worker");
        const redirectedInside = NodePath.join(trustedRoot, "other", "worker");
        yield* Effect.promise(() =>
          Promise.all([
            NodeFSP.mkdir(inside, { recursive: true }),
            NodeFSP.mkdir(outside, { recursive: true }),
            NodeFSP.mkdir(redirectedInside, { recursive: true }),
            NodeFSP.mkdir(workspaceRoot, { recursive: true }),
          ]),
        );
        const directLink = NodePath.join(trustedRoot, "outside-link");
        const nestedLink = NodePath.join(trustedRoot, "nested-link");
        yield* Effect.promise(() => NodeFSP.symlink(outside, directLink, "dir"));
        yield* Effect.promise(() =>
          NodeFSP.symlink(NodePath.join(trustedRoot, "other"), nestedLink, "dir"),
        );

        const validate = (worktreePath: string) =>
          canonicalWorkerRemovalPath({
            worktreePath,
            workspaceRoot,
            trustedRoots: [trustedRoot],
          });

        expect(yield* validate(inside)).toBe(yield* Effect.promise(() => NodeFSP.realpath(inside)));
        expect(yield* validate(directLink)).toBeNull();
        expect(yield* validate(NodePath.join(nestedLink, "worker"))).toBeNull();
        expect(yield* Effect.promise(() => NodeFSP.stat(outside))).toBeDefined();
      } finally {
        yield* Effect.promise(() => NodeFSP.rm(fixture, { recursive: true, force: true }));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
