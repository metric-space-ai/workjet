import * as Option from "effect/Option";
import type { ScopedThreadRef } from "@workjet/contracts";
import type { EnvironmentThreadState } from "@workjet/client-runtime/state/threads";
import { createCtoxReadAtomFamily } from "./readAtoms";
import { readWorkjetThreadDetail, type WorkjetThreadDocument } from "./workjetThreadData";
import { collectionLiveness } from "./liveness";

export const THREAD_READ_COLLECTIONS = [
  "workjet_threads",
  "workjet_thread_messages",
  "workjet_thread_activities",
  "workjet_thread_plans",
  "workjet_thread_checkpoints",
] as const;
const states = createCtoxReadAtomFamily<ScopedThreadRef, EnvironmentThreadState>({
  collections: THREAD_READ_COLLECTIONS,
  metrics: true,
  read: (api, ref) => {
    const row = api.get<WorkjetThreadDocument>("workjet_threads", ref.threadId).get();
    const data = readWorkjetThreadDetail(api, ref);
    if (!data)
      return {
        data: Option.none(),
        error: Option.none(),
        page: Option.none(),
        status:
          row?.environmentId === ref.environmentId && row.deletedAt != null ? "deleted" : "empty",
      };
    return {
      data: Option.some(data),
      error: Option.none(),
      page: Option.none(),
      status: collectionLiveness(api.metrics.get(), THREAD_READ_COLLECTIONS).allLive
        ? "live"
        : "cached",
    };
  },
});
export const ctoxThreadStateAtom = (ref: ScopedThreadRef) => states(JSON.stringify(ref));
