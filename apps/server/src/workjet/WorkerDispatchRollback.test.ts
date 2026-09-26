import { expect, it } from "@effect/vitest";
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
      Effect.sync(() => {
        expect(command).toEqual({
          cwd: input.cwd,
          refName: input.branchRef,
          expectedCommitSha: "a".repeat(40),
        });
        calls.push("delete-ref");
      }),
  });
  const remover = Layer.mock(NativeWorkerWorktreeRemover)({
    capture: () =>
      Effect.sync(() => ({ ...identity, worktreeIno: state.ino, adminIno: state.adminIno })),
    removeCaptured: (captured) =>
      Effect.gen(function* () {
        // The descriptor passed for deletion must be the original capture.
        expect(captured).toEqual(identity);
        calls.push("remove-captured");
        if (state.rejectRemoval)
          return yield* new NativeWorkerWorktreeRemovalError({ reason: "identity" });
      }),
  });
  return { calls, state, service: make().pipe(Effect.provide(Layer.mergeAll(git, remover))) };
};

it.effect("removes only the unchanged checkout and compare-deletes its original ref", () =>
  Effect.gen(function* () {
    const test = fixture();
    const service = yield* test.service;
    const rollback = yield* service.prepare(input);
    expect(test.calls).toEqual([]);
    yield* rollback;
    expect(test.calls).toEqual(["remove-captured", "delete-ref"]);
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
    expect(test.calls).toEqual(["remove-captured"]);
  }),
);
