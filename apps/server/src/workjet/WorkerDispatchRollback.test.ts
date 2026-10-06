import { expect, it } from "@effect/vitest";
import { GitCommandError } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/unstable/process";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  NativeWorkerWorktreeRemover,
  NativeWorkerWorktreeRemovalError,
} from "./NativeWorkerWorktreeRemover.ts";
import { make } from "./WorkerDispatchRollback.ts";

const input = { cwd: "/repo", worktreePath: "/workers/one", branchRef: "workjet/worker/one" };
const identity = {
  worktreePath: input.worktreePath,
  worktreeDev: "1",
  worktreeIno: "2",
  adminPath: "/repo/.git/worktrees/one",
  adminDev: "1",
  adminIno: "3",
};

const fixture = () => {
  const calls: string[] = [];
  const state = {
    ino: "2",
    adminIno: "3",
    head: "a".repeat(40),
    branch: `refs/heads/${input.branchRef}`,
    status: "",
    truncated: false,
    rejectRemoval: false,
    partialFailure: false,
    failRefDelete: false,
  };
  const git = Layer.mock(GitVcsDriver)({
    resolveCommit: () => Effect.succeed({ commitSha: state.head }),
    execute: (command) =>
      Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(0),
        stderr: "",
        stderrTruncated: false,
        stdoutTruncated: state.truncated,
        stdout: command.args[0] === "symbolic-ref" ? state.branch : state.status,
      }),
    deleteBranchAtCommit: (command) =>
      Effect.gen(function* () {
        expect(command).toEqual({
          cwd: input.cwd,
          refName: input.branchRef,
          expectedCommitSha: "a".repeat(40),
        });
        calls.push("delete-ref");
        if (state.failRefDelete)
          return yield* new GitCommandError({
            operation: "delete-ref",
            command: "git",
            cwd: input.cwd,
            detail: "compare failed",
          });
      }),
  });
  const remover = Layer.mock(NativeWorkerWorktreeRemover)({
    capture: () =>
      Effect.sync(() => ({ ...identity, worktreeIno: state.ino, adminIno: state.adminIno })),
    quarantineCaptured: (captured) =>
      Effect.gen(function* () {
        // Quarantine uses the original capture, not a post-rejection snapshot.
        expect(captured).toEqual(identity);
        calls.push("quarantine-captured");
        if (state.rejectRemoval)
          return yield* new NativeWorkerWorktreeRemovalError({ reason: "identity" });
        if (state.partialFailure)
          return yield* new NativeWorkerWorktreeRemovalError({
            reason: "failed",
            originalWorktreePath: input.worktreePath,
            originalAdminPath: identity.adminPath,
            recoveryLocationStatus: "candidate",
            recoveryWorktreePath: "/workers/one.workjet-rejected-2",
            recoveryAdminPath: "/repo/.git/workjet-rejected/one-3",
          });
        return {
          originalWorktreePath: input.worktreePath,
          originalAdminPath: identity.adminPath,
          recoveryLocationStatus: "verified" as const,
          recoveryWorktreePath: "/workers/one.workjet-rejected-2",
          recoveryAdminPath: "/repo/.git/workjet-rejected/one-3",
        };
      }),
  });
  return { calls, state, service: make().pipe(Effect.provide(Layer.mergeAll(git, remover))) };
};

it.effect("quarantines the checkout and compare-deletes only its original ref", () =>
  Effect.gen(function* () {
    const test = fixture();
    const service = yield* test.service;
    const rollback = yield* service.prepare(input);
    expect(test.calls).toEqual([]);
    const recovery = yield* rollback;
    expect(recovery.recoveryWorktreePath).toBe("/workers/one.workjet-rejected-2");
    expect(test.calls).toEqual(["quarantine-captured", "delete-ref"]);
  }),
);

for (const mutation of [
  "ino",
  "adminIno",
  "head",
  "branch",
  "tracked",
  "untracked",
  "ignored",
  "truncated",
] as const) {
  it.effect(`retains source if ${mutation} changes after capture`, () =>
    Effect.gen(function* () {
      const test = fixture();
      const service = yield* test.service;
      const rollback = yield* service.prepare(input);
      if (mutation === "ino") test.state.ino = "9";
      else if (mutation === "adminIno") test.state.adminIno = "9";
      else if (mutation === "head") test.state.head = "b".repeat(40);
      else if (mutation === "branch") test.state.branch = "refs/heads/user-work";
      else if (mutation === "truncated") test.state.truncated = true;
      else
        test.state.status =
          mutation === "ignored"
            ? "!! user.txt\n"
            : mutation === "untracked"
              ? "?? user.txt\n"
              : " M user.txt\n";
      const error = yield* rollback.pipe(Effect.flip);
      expect(error.reason).toBe("changed");
      expect(test.calls).toEqual([]);
    }),
  );
}

it.effect("keeps the ref when the native helper rejects a late path replacement", () =>
  Effect.gen(function* () {
    const test = fixture();
    const service = yield* test.service;
    const rollback = yield* service.prepare(input);
    test.state.rejectRemoval = true;
    yield* rollback.pipe(Effect.flip);
    expect(test.calls).toEqual(["quarantine-captured"]);
  }),
);

for (const failure of ["partialFailure", "failRefDelete"] as const) {
  it.effect(`returns recovery locations without cleanup success after ${failure}`, () =>
    Effect.gen(function* () {
      const test = fixture();
      const service = yield* test.service;
      const rollback = yield* service.prepare(input);
      test.state[failure] = true;
      const error = yield* rollback.pipe(Effect.flip);
      expect(error.reason).toBe("unavailable");
      expect(error.recoveryWorktreePath).toBe("/workers/one.workjet-rejected-2");
      expect(error.recoveryAdminPath).toBe("/repo/.git/workjet-rejected/one-3");
      expect(error.originalAdminPath).toBe(identity.adminPath);
      expect(error.originalWorktreePath).toBe(input.worktreePath);
      expect(error.recoveryLocationStatus).toBe(
        failure === "partialFailure" ? "candidate" : "verified",
      );
      expect(test.calls).toEqual(
        failure === "partialFailure"
          ? ["quarantine-captured"]
          : ["quarantine-captured", "delete-ref"],
      );
    }),
  );
}
