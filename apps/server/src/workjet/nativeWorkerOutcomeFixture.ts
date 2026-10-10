// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  DEFAULT_MODEL, EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, WorkjetComputerId,
  WorkjetConnectionId, NATIVE_SUPERVISOR_WORKER_CONTRACT,
  type RemoteWorkerRequest, type RemoteWorkerResult, type NativeSupervisorSourceRegistration,
} from "@workjet/contracts";
import type { WorkerPullRequestReceipt } from "./WorkerPullRequestStore.ts";
import type { NativeSupervisorWorkerSource } from "./NativeSupervisorWorkerDispatch.ts";
export const worker: RemoteWorkerRequest = {
  schemaVersion: 1, requestId: ThreadId.make("worker-one"),
  targetEnvironmentId: EnvironmentId.make("target"), computerId: WorkjetComputerId.make("computer"),
  parent: { environmentId: EnvironmentId.make("source"), threadId: ThreadId.make("parent") },
  parentTeamRole: "supervisor", parentCapabilityIds: [], managedInstructions: "",
  project: { id: ProjectId.make("project"), title: "Fixture", repository: {
    canonicalKey: "github:owner/repo", locator: { source: "git-remote", remoteName: "origin", remoteUrl: "https://github.com/owner/repo.git" },
  } },
  revision: "a".repeat(40), task: "One PR", title: "Worker",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL },
  runtimeMode: "full-access", interactionMode: "default", enabledCapabilityIds: [],
  createdAt: "2026-10-10T00:00:00Z", expiresAt: "2026-10-11T00:00:00Z",
};
export const startup: RemoteWorkerResult = {
  schemaVersion: 1, status: "dispatched", workerThreadId: worker.requestId,
  environmentId: worker.targetEnvironmentId, computerId: worker.computerId,
  parent: worker.parent, branch: `workjet/worker/${worker.requestId}`, worktreePath: "/owned/worker",
  modelSelection: worker.modelSelection, enabledCapabilityIds: [],
};
export const persisted: WorkerPullRequestReceipt = {
  threadId: worker.requestId, worktreePath: startup.worktreePath, branchRef: startup.branch,
  provider: "github", prNumber: 7, prUrl: "https://github.com/owner/repo/pull/7",
  headOid: "a".repeat(40), state: "merged", executionStopped: 1,
};
export const source: NativeSupervisorWorkerSource = {
  source: { sourceEnvironmentId: worker.parent.environmentId,
    sourceSupervisorThreadId: worker.parent.threadId, projectId: worker.project.id },
  scope: { connectionId: WorkjetConnectionId.make("native"), instanceId: "source-instance" },
};
export const registration: NativeSupervisorSourceRegistration = {
  ...source.source, contract: NATIVE_SUPERVISOR_WORKER_CONTRACT,
  registrationId: "registered-source", revision: 3, ownerUserId: "owner",
  sourceInstanceId: source.scope.instanceId, authorityEpoch: 1, state: "active",
};
