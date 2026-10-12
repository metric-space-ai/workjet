import { useNavigate } from "@tanstack/react-router";

import { type SlowRpcAckRequest, useSlowRpcAckRequests } from "../rpc/requestLatencyState";

/**
 * Eine Zeile (UI-Vertrag): „2 Anfragen warten länger als 15 s“. Die einzelnen
 * Anfragen (Rohdaten) gehören in Einstellungen › Diagnose, nicht in einen Toast.
 */
export function describeSlowRequests(requests: ReadonlyArray<SlowRpcAckRequest>): string {
  const count = requests.length;
  // Thresholds vary per method, so report the smallest one the batch has passed.
  const thresholdSeconds = Math.round(
    Math.min(...requests.map((request) => request.thresholdMs)) / 1000,
  );
  // Zahl und Einheit bleiben bei 420 px zusammen (geschütztes Leerzeichen).
  return count === 1
    ? `1 Anfrage wartet länger als ${thresholdSeconds} s`
    : `${count} Anfragen warten länger als ${thresholdSeconds} s`;
}

/**
 * Kleiner Chip in der Kopfzeile statt Toast. Die einzige Aktion ist der Klick
 * auf den Chip; er führt zu Einstellungen › Diagnose.
 */
export function SlowRpcRequestChip() {
  const slowRequests = useSlowRpcAckRequests();
  const navigate = useNavigate();
  if (slowRequests.length === 0) return null;
  return (
    <button
      type="button"
      className="no-drag inline-flex shrink-0 items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] whitespace-nowrap text-amber-400 hover:bg-amber-500/20 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      data-workjet-slow-requests=""
      title="Einstellungen › Diagnose"
      onClick={() => void navigate({ to: "/settings/diagnostics" })}
    >
      {describeSlowRequests(slowRequests)}
    </button>
  );
}

/**
 * Früher: Toast mit „Diagnose“-Knopf. Der Hinweis ist jetzt der Chip in der
 * Kopfzeile (SlowRpcRequestChip im WorkjetHeader); diese Hülle bleibt nur,
 * weil die Wurzel sie noch einhängt.
 */
export function SlowRpcRequestToastCoordinator() {
  return null;
}
