import { expect, it } from "vite-plus/test";
import {
  workerNamespaceSpawnInput,
  type WorkerNamespaceSpawnCapture,
} from "./WorkerNamespaceSpawn.ts";

const capture: WorkerNamespaceSpawnCapture = {
  helperPath: "/runtime/workjet-resource-monitor",
  worktree: {
    kind: "isolated",
    worktreePath: "/assigned/worker",
    worktreeDev: "1",
    worktreeIno: "2",
    adminPath: "/assigned/worker/.git",
    adminDev: "1",
    adminIno: "3",
  },
  profile: { path: "/runtime/profiles/worker", identity: { device: "1", inode: "4" } },
  modelSocket: {
    root: "/runtime/model-ipc",
    path: "/proc/111/fd/12/s",
    directory: "/runtime/model-ipc/m-worker",
    directoryIdentity: { device: "1", inode: "5" },
    socketIdentity: { device: "1", inode: "6" },
    hostNetworkIdentity: { device: "7", inode: "8" },
  },
  runtimeFiles: [],
};
const spawn = {
  command: "/usr/bin/python3",
  args: ["-c", "print('argument with spaces')"],
  cwd: capture.worktree.worktreePath,
  env: { WORKJET_SOURCE_ISOLATED: "true", WORKJET_WORKER_SOURCE_KEY: "scoped-fixture-key" },
};

it("keeps command arguments and private credentials in their original channels", () => {
  const wrapped = workerNamespaceSpawnInput(spawn, capture);
  expect(wrapped.command).toBe(capture.helperPath);
  expect(wrapped.args.slice(2)).toEqual(["--", spawn.command, ...spawn.args]);
  expect(wrapped.env).toBe(spawn.env);
  expect(wrapped.cwd).toBe(spawn.cwd);
  expect(wrapped.args.join(" ")).not.toContain("scoped-fixture-key");
});

it("rejects linked metadata and a foreign cwd before starting a process", () => {
  expect(() =>
    workerNamespaceSpawnInput(spawn, {
      ...capture,
      worktree: {
        worktreePath: capture.worktree.worktreePath,
        worktreeDev: capture.worktree.worktreeDev,
        worktreeIno: capture.worktree.worktreeIno,
        adminPath: capture.worktree.adminPath,
        adminDev: capture.worktree.adminDev,
        adminIno: capture.worktree.adminIno,
      },
    }),
  ).toThrow("custody");
  expect(() => workerNamespaceSpawnInput({ ...spawn, cwd: "/foreign" }, capture)).toThrow(
    "custody",
  );
  expect(() =>
    workerNamespaceSpawnInput(spawn, {
      ...capture,
      worktree: { ...capture.worktree, adminPath: "/shared/git" },
    }),
  ).toThrow("custody");
});

it("rejects ambient environment inheritance and unresolved or redirected executables", () => {
  expect(() =>
    workerNamespaceSpawnInput(spawn, capture, [{ type: "http", url: "http://127.0.0.1:32100" }]),
  ).toThrow("confined server");
  expect(() => workerNamespaceSpawnInput({ ...spawn, env: {} }, capture)).toThrow("custody");
  expect(() => workerNamespaceSpawnInput({ ...spawn, command: "python3" }, capture)).toThrow(
    "custody",
  );
  expect(() =>
    workerNamespaceSpawnInput(spawn, {
      ...capture,
      runtimeFiles: [{ path: "/runtime/../secret", identity: { device: "1", inode: "9" } }],
    }),
  ).toThrow("custody");
});
