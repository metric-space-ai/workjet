import { useEffect, useState } from "react";
import type { NativeSupervisorScope } from "../../nativeSupervisorComposer";
import { readSupervisorRoute, type SupervisorRouteState } from "../../workjetSupervisorRoute";
export function useSupervisorRouteDisplay(
  scope: NativeSupervisorScope | null,
): SupervisorRouteState | null {
  const instanceId = scope?.instanceId,
    projectId = scope?.projectId,
    threadId = scope?.threadId;
  const key = scope ? JSON.stringify([instanceId, projectId, threadId]) : null;
  const [snapshot, setSnapshot] = useState<{ key: string; value: SupervisorRouteState } | null>(
    null,
  );
  useEffect(() => {
    if (
      instanceId === undefined ||
      projectId === undefined ||
      threadId === undefined ||
      key === null
    )
      return;
    const controller = new AbortController();
    void readSupervisorRoute({ instanceId, projectId, threadId }, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setSnapshot({ key, value });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setSnapshot({ key, value: { phase: "unavailable", code: "guest_failed" } });
      });
    return () => controller.abort();
  }, [key, instanceId, projectId, threadId]);
  return snapshot?.key === key ? snapshot.value : null;
}
