import { useEffect, useRef } from "react";

import { type SlowRpcAckRequest, useSlowRpcAckRequests } from "../rpc/requestLatencyState";
import { toastManager } from "./ui/toast";

/**
 * Eine Zeile (UI-Vertrag): „2 Anfragen warten länger als 15 s“. Die einzelnen
 * Anfragen (Rohdaten) gehören in Einstellungen › Diagnose, nicht in den Toast.
 */
export function describeSlowRequests(requests: ReadonlyArray<SlowRpcAckRequest>): string {
  const count = requests.length;
  // Thresholds vary per method, so report the smallest one the batch has passed.
  const thresholdSeconds = Math.round(
    Math.min(...requests.map((request) => request.thresholdMs)) / 1000,
  );
  return count === 1
    ? `1 Anfrage wartet länger als ${thresholdSeconds} s`
    : `${count} Anfragen warten länger als ${thresholdSeconds} s`;
}

export function SlowRpcRequestToastCoordinator() {
  const slowRequests = useSlowRpcAckRequests();
  const toastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);

  useEffect(() => {
    if (slowRequests.length === 0) {
      if (toastIdRef.current !== null) {
        toastManager.close(toastIdRef.current);
        toastIdRef.current = null;
      }
      return;
    }

    const nextToast = {
      timeout: 0,
      title: describeSlowRequests(slowRequests),
      type: "warning" as const,
    };

    if (toastIdRef.current === null) {
      toastIdRef.current = toastManager.add(nextToast);
    } else {
      toastManager.update(toastIdRef.current, nextToast);
    }
  }, [slowRequests]);

  useEffect(
    () => () => {
      if (toastIdRef.current !== null) {
        toastManager.close(toastIdRef.current);
      }
    },
    [],
  );

  return null;
}
