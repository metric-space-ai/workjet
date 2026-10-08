import type { CtoxWorkjetSessionProjection } from "@workjet/contracts";
import { listWorkjetSessions } from "../workjetSessionControl";

export interface SessionCalendarSnapshot {
  readonly status: "loading" | "ready" | "unavailable";
  readonly sessions: readonly CtoxWorkjetSessionProjection[];
}
/** Single read in flight. A burst of transfer notices coalesces to one follow-up.
 * Disposal fences late responses from a previous instance or signed-out user. */
export function createSessionCalendarReader(
  instanceId: string,
  publish: (snapshot: SessionCalendarSnapshot) => void,
  read = listWorkjetSessions,
) {
  let disposed = false;
  let pending = false;
  let queued = false;
  let sessions: readonly CtoxWorkjetSessionProjection[] = [];
  const refresh = async (): Promise<void> => {
    if (disposed) return;
    if (pending) {
      queued = true;
      return;
    }
    pending = true;
    publish({ status: "loading", sessions });
    try {
      const result = await read(instanceId);
      if (disposed) return;
      if (result._tag !== "completed" || result.response.action !== "session.list") {
        publish({ status: "unavailable", sessions });
      } else {
        sessions = result.response.sessions;
        publish({ status: "ready", sessions });
      }
    } catch {
      if (!disposed) publish({ status: "unavailable", sessions });
    } finally {
      pending = false;
      if (queued && !disposed) {
        queued = false;
        void refresh();
      }
    }
  };
  return {
    refresh,
    dispose: () => {
      disposed = true;
      queued = false;
    },
  };
}
