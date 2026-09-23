// @effect-diagnostics nodeBuiltinImport:off -- Test-only symlink fixture exercises real host filesystem behavior.
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import { canonicalWorkerRemovalPath } from "./WorkerWorktreeCleanup.ts";

describe("canonicalWorkerRemovalPath", () => {
  it("accepts the owned checkout and rejects direct and nested symlink redirects", async () => {
    const fixture = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-worker-cleanup-"));
    try {
      const trustedRoot = NodePath.join(fixture, "trusted");
      const workspaceRoot = NodePath.join(fixture, "workspace");
      const outsideRoot = NodePath.join(fixture, "outside");
      const inside = NodePath.join(trustedRoot, "worker");
      const outside = NodePath.join(outsideRoot, "worker");
      const redirectedInside = NodePath.join(trustedRoot, "other", "worker");
      await Promise.all([
        NodeFS.mkdir(inside, { recursive: true }),
        NodeFS.mkdir(outside, { recursive: true }),
        NodeFS.mkdir(redirectedInside, { recursive: true }),
        NodeFS.mkdir(workspaceRoot, { recursive: true }),
      ]);
      const directLink = NodePath.join(trustedRoot, "outside-link");
      const nestedLink = NodePath.join(trustedRoot, "nested-link");
      await NodeFS.symlink(outside, directLink, "dir");
      await NodeFS.symlink(NodePath.join(trustedRoot, "other"), nestedLink, "dir");

      const validate = (worktreePath: string) =>
        Effect.runPromise(
          canonicalWorkerRemovalPath({
            worktreePath,
            workspaceRoot,
            trustedRoots: [trustedRoot],
          }).pipe(Effect.provide(NodeServices.layer)),
        );

      expect(await validate(inside)).toBe(await NodeFS.realpath(inside));
      expect(await validate(directLink)).toBeNull();
      expect(await validate(NodePath.join(nestedLink, "worker"))).toBeNull();
      expect(await NodeFS.stat(outside)).toBeDefined();
    } finally {
      await NodeFS.rm(fixture, { recursive: true, force: true });
    }
  });
});
