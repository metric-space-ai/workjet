// @effect-diagnostics nodeBuiltinImport:off -- Server-owned native process capture, never a client policy grant.
import * as NodePath from "node:path";
import type { CapturedWorkerWorktree } from "./NativeWorkerWorktreeRemover.ts";
import type { WorkerSourceModelSocketDescription } from "./WorkerSourceModelSocket.ts";

export interface WorkerNamespaceFileCapture {
  readonly path: string;
  readonly identity: { readonly device: string; readonly inode: string };
}

export interface WorkerNamespaceSpawnCapture {
  readonly helperPath: string;
  readonly worktree: CapturedWorkerWorktree;
  readonly profile: WorkerNamespaceFileCapture;
  readonly modelSocket: WorkerSourceModelSocketDescription;
  /** Only files from the server's verified runtime producer, with original identities. */
  readonly runtimeFiles: ReadonlyArray<WorkerNamespaceFileCapture>;
  readonly runtimeDirectories?: ReadonlyArray<WorkerNamespaceFileCapture>;
}

export function workerNamespaceSpawnInput(
  spawn: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
  },
  capture: WorkerNamespaceSpawnCapture,
  mcpServers: ReadonlyArray<unknown> = [],
) {
  if (mcpServers.length > 0)
    throw new Error("Namespace MCP execution is unavailable; a confined server is required");
  const canonical = (path: string) => NodePath.isAbsolute(path) && NodePath.resolve(path) === path;
  if (
    capture.worktree.kind !== "isolated" ||
    capture.worktree.adminPath !== NodePath.join(capture.worktree.worktreePath, ".git") ||
    spawn.cwd !== capture.worktree.worktreePath ||
    spawn.env?.WORKJET_SOURCE_ISOLATED !== "true" ||
    !canonical(spawn.command) ||
    !canonical(capture.helperPath) ||
    !canonical(capture.worktree.worktreePath) ||
    !canonical(capture.profile.path) ||
    capture.runtimeFiles.some((file) => !canonical(file.path)) ||
    capture.runtimeDirectories?.some((directory) => !canonical(directory.path))
  )
    throw new Error("Worker process requires original private namespace custody");

  const plan = {
    version: 1,
    worktree: {
      path: capture.worktree.worktreePath,
      identity: { device: capture.worktree.worktreeDev, inode: capture.worktree.worktreeIno },
    },
    gitIdentity: { device: capture.worktree.adminDev, inode: capture.worktree.adminIno },
    profile: capture.profile,
    modelSocket: { path: capture.modelSocket.path, identity: capture.modelSocket.socketIdentity },
    hostNetwork: capture.modelSocket.hostNetworkIdentity,
    runtimeFiles: capture.runtimeFiles,
    runtimeDirectories: capture.runtimeDirectories ?? [],
  };
  return {
    command: capture.helperPath,
    args: ["--worker-namespace-launch", JSON.stringify(plan), "--", spawn.command, ...spawn.args],
    cwd: spawn.cwd,
    env: spawn.env,
  };
}
