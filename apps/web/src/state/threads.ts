import { ctoxThreadStateAtom } from "../ctox/threadReadAtoms";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  type EnvironmentThreadState,
  createThreadEnvironmentAtoms,
} from "@workjet/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@workjet/contracts";

import { useActiveWorkjetScope } from "../activeWorkjetScope";
import { useWorkjetThreadState } from "../ctox/workjetThreadData";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

export const threadEnvironment = createThreadEnvironmentAtoms(connectionAtomRuntime);
const legacyEnvironmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreads = {
  ...legacyEnvironmentThreads,
  stateAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
    ctoxThreadStateAtom({ environmentId, threadId }),
};
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const { selectedInstanceId } = useActiveWorkjetScope();
  return useWorkjetThreadState(
    selectedInstanceId,
    environmentId === null || threadId === null ? null : { environmentId, threadId },
  );
}
