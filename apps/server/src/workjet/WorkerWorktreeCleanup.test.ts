// @effect-diagnostics nodeBuiltinImport:off -- Test-only symlink fixture exercises real host filesystem behavior.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeEffectPath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it } from "@effect/vitest";
import { ChangeRequest, ProjectId, ThreadId } from "@workjet/contracts";

import { canonicalWorkerRemovalPath, make } from "./WorkerWorktreeCleanup.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SourceControlProvider } from "../sourceControl/SourceControlProvider.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import * as WorktreeStorage from "../worktree/WorktreeStorage.ts";
import {
  NativeWorkerWorktreeRemover,
  NativeWorkerWorktreeRemovalError,
} from "./NativeWorkerWorktreeRemover.ts";
import {
  WorkerCleanupReceiptStore,
  type WorkerCleanupReceipt,
} from "./WorkerCleanupReceiptStore.ts";

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

const cleanupFixture = () => {
  const threadId = ThreadId.make("00000000-0000-4000-8000-00000000000a");
  const ref = `workjet/worker/${threadId}`;
  const identity = {
    worktreePath: "/workers/one",
    worktreeDev: "1",
    worktreeIno: "2",
    adminPath: "/repo/.git/worktrees/one",
    adminDev: "1",
    adminIno: "3",
  };
  const receipt: WorkerCleanupReceipt = {
    threadId,
    worktreePath: identity.worktreePath,
    branchRef: ref,
    mergedHeadOid: "a".repeat(40),
    mergedChangeRequestUrl: "https://example.test/pull/7",
    status: "verified",
  };
  const calls: string[] = [];
  const state = {
    exists: true,
    isRepo: true,
    dirty: false,
    ref,
    head: receipt.mergedHeadOid,
    ino: identity.worktreeIno,
    receiptStatus: "verified" as WorkerCleanupReceipt["status"],
    duringVerification: () => {},
    duringReceipt: () => {},
  };
  const unexpected = () => Effect.die("Unexpected provider operation");
  const provider = SourceControlProvider.of({
    kind: "github",
    listChangeRequests: () =>
      Effect.sync(() => {
        calls.push("verify-merge");
        state.duringVerification();
        return [
          ChangeRequest.make({
            provider: "github",
            number: 7,
            title: "Worker result",
            url: receipt.mergedChangeRequestUrl,
            baseRefName: "main",
            headRefName: ref,
            headCommitOid: receipt.mergedHeadOid,
            state: "merged",
            updatedAt: Option.none(),
          }),
        ];
      }),
    getChangeRequest: unexpected,
    createChangeRequest: unexpected,
    getRepositoryCloneUrls: unexpected,
    createRepository: unexpected,
    getDefaultBranch: unexpected,
    checkoutChangeRequest: unexpected,
  });
  const services = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadWorktreeCleanupContext: () =>
        Effect.succeed(
          Option.some({
            threadId,
            projectId: ProjectId.make("00000000-0000-4000-8000-00000000000b"),
            workspaceRoot: "/repo",
            workjetRole: "worker",
            branch: ref,
            worktreePath: identity.worktreePath,
            archivedAt: null,
          }),
        ),
    }),
    Layer.mock(GitWorkflowService)({
      invalidateLocalStatus: () =>
        Effect.sync(() => {
          calls.push("invalidate-status");
        }),
      localStatus: () =>
        Effect.sync(() => {
          calls.push("read-status");
          return {
            isRepo: state.isRepo,
            hasPrimaryRemote: true,
            isDefaultRef: false,
            refName: state.ref,
            hasWorkingTreeChanges: state.dirty,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          };
        }),
    }),
    Layer.mock(GitVcsDriver)({
      resolveCommit: () => Effect.sync(() => ({ commitSha: state.head })),
      localBranchRefExists: () => Effect.succeed(true),
      deleteBranchAtCommit: () =>
        Effect.sync(() => {
          calls.push("delete-ref");
        }),
    }),
    Layer.mock(SourceControlProviderRegistry)({ resolve: () => Effect.succeed(provider) }),
    WorktreeStorage.layerTest({ trustedRoots: ["/workers"] }),
    Layer.mock(WorkerCleanupReceiptStore)({
      recordVerified: () =>
        Effect.sync(() => {
          calls.push("record-verification");
          state.duringReceipt();
          return true;
        }),
      get: () => Effect.sync(() => Option.some({ ...receipt, status: state.receiptStatus })),
      markRemoved: () =>
        Effect.sync(() => {
          calls.push("mark-removed");
        }),
      markComplete: () =>
        Effect.sync(() => {
          calls.push("mark-complete");
        }),
    }),
    FileSystem.layerNoop({ exists: () => Effect.sync(() => state.exists) }),
    Layer.mock(NativeWorkerWorktreeRemover)({
      capture: () =>
        Effect.sync(() => {
          calls.push("capture");
          return { ...identity, worktreeIno: state.ino };
        }),
      removeCaptured: (captured) =>
        Effect.gen(function* () {
          calls.push("remove-captured");
          expect(captured).toEqual(identity);
          if (captured.worktreeIno !== state.ino)
            return yield* new NativeWorkerWorktreeRemovalError({ reason: "identity" });
        }),
    }),
  );
  return {
    threadId,
    calls,
    state,
    receipt,
    service: make(() => Effect.succeed(identity.worktreePath)).pipe(
      Effect.provide(Layer.mergeAll(services, NodeEffectPath.layer)),
    ),
  };
};

describe("verified worker cleanup identity and late edits", () => {
  it.effect("removes only the directory captured before the provider merge lookup", () =>
    Effect.gen(function* () {
      const test = cleanupFixture();
      const service = yield* test.service;
      expect((yield* service.cleanupDeletedThread(test.threadId)).status).toBe("cleaned");
      expect(test.calls.filter((call) => call === "capture")).toHaveLength(1);
      expect(test.calls.indexOf("capture")).toBeLessThan(test.calls.indexOf("verify-merge"));
      expect(test.calls.slice(-4)).toEqual([
        "remove-captured",
        "mark-removed",
        "delete-ref",
        "mark-complete",
      ]);
    }),
  );

  it.effect("does not delete a replacement directory installed during merge verification", () =>
    Effect.gen(function* () {
      const test = cleanupFixture();
      test.state.duringVerification = () => {
        test.state.ino = "9";
      };
      const service = yield* test.service;
      const error = yield* service.cleanupDeletedThread(test.threadId).pipe(Effect.flip);
      expect(error.step).toBe("remove-worktree");
      expect(test.calls).toContain("remove-captured");
      expect(test.calls).not.toContain("mark-removed");
      expect(test.calls).not.toContain("delete-ref");
      expect(test.calls).not.toContain("mark-complete");
    }),
  );

  for (const mutation of ["dirty", "ref", "head"] as const) {
    for (const phase of ["duringVerification", "duringReceipt"] as const) {
      it.effect(`retains the checkout when ${mutation} changes ${phase}`, () =>
        Effect.gen(function* () {
          const test = cleanupFixture();
          test.state[phase] = () => {
            if (mutation === "dirty") test.state.dirty = true;
            else if (mutation === "ref") test.state.ref = "user-work";
            else test.state.head = "b".repeat(40);
          };
          const service = yield* test.service;
          expect(yield* service.cleanupDeletedThread(test.threadId)).toEqual({
            status: "skipped",
            reason: "merge-unverified",
          });
          expect(test.calls).not.toContain("remove-captured");
          expect(test.calls).not.toContain("delete-ref");
          expect(test.calls).not.toContain("mark-complete");
        }),
      );
    }
  }

  it.effect("does not capture a checkout that appeared after the initial existence check", () =>
    Effect.gen(function* () {
      const test = cleanupFixture();
      test.state.exists = false;
      const service = yield* test.service;
      expect(yield* service.cleanupDeletedThread(test.threadId)).toEqual({
        status: "skipped",
        reason: "merge-unverified",
      });
      expect(test.calls).not.toContain("capture");
      expect(test.calls).not.toContain("remove-captured");
    }),
  );

  it.effect(
    "retries branch cleanup from a removal receipt when the checkout is already absent",
    () =>
      Effect.gen(function* () {
        const test = cleanupFixture();
        test.state.exists = false;
        test.state.isRepo = false;
        test.state.receiptStatus = "removed";
        const service = yield* test.service;
        expect((yield* service.cleanupDeletedThread(test.threadId)).status).toBe("cleaned");
        expect(test.calls).not.toContain("capture");
        expect(test.calls).not.toContain("remove-captured");
        expect(test.calls.slice(-2)).toEqual(["delete-ref", "mark-complete"]);
      }),
  );
});
