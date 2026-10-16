import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  createThreadEnvironmentAtoms,
} from "@workjet/client-runtime/state/threads";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@workjet/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";
import { ctoxThreadStateAtom } from "../ctox/threadReadAtoms";
import { gateCtoxReadFamily } from "../ctox/v4GatedAtoms";

export const threadEnvironment = createThreadEnvironmentAtoms(connectionAtomRuntime);
const legacyEnvironmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
/** Scheibe C: thread state reads the local kernel on a V4 instance, the environment RPC on V3. */
const gatedThreadState = gateCtoxReadFamily(
  (ref: ScopedThreadRef) => legacyEnvironmentThreads.stateAtom(ref.environmentId, ref.threadId),
  ctoxThreadStateAtom,
);
export const environmentThreads = {
  ...legacyEnvironmentThreads,
  stateAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
    gatedThreadState({ environmentId, threadId }) as ReturnType<
      typeof legacyEnvironmentThreads.stateAtom
    >,
};
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("web-environment-thread:empty"),
);

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  return Option.getOrElse(
    AsyncResult.value(result),
    () => EMPTY_ENVIRONMENT_THREAD_STATE,
  ) as EnvironmentThreadState;
}
