import type { WorkjetNativeProviderAccount } from "@workjet/contracts";
import { useEffect, useState } from "react";

export function NativeProviderLimits({
  quota,
}: {
  readonly quota: WorkjetNativeProviderAccount["reportedQuota"];
}) {
  const [expiryTick, setExpiryTick] = useState(0);
  const now = Date.now();
  // Repaint only when a reported window expires, never continuously.
  useEffect(() => {
    if (quota?.state !== "reported") return;
    const future = quota.windows
      .map((window) => window.resetAtMs)
      .filter((reset) => reset > Date.now());
    if (future.length === 0) return;
    const timer = setTimeout(
      () => setExpiryTick((tick) => tick + 1),
      Math.max(1, Math.min(...future) - Date.now() + 1),
    );
    return () => clearTimeout(timer);
  }, [quota, expiryTick]);

  if (quota?.state !== "reported") {
    return (
      <div
        role="cell"
        className="text-xs text-muted-foreground"
        title={
          quota?.state === "unavailable"
            ? "Reported limits could not be read (quota_read_failed). Reopen Models to try again."
            : "This instance account has not reported limits."
        }
      >
        —
      </div>
    );
  }
  const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
  return (
    <div role="cell" className="grid gap-0.5 text-[11px] tabular-nums">
      {quota.windows.map((window) => {
        const label = window.kind === "five_hour" ? "5h" : "7d";
        const expired = window.resetAtMs <= now;
        const used = window.utilization === null ? null : percent.format(window.utilization);
        const reported = new Date(quota.observedAtMs).toLocaleString();
        const reset = new Date(window.resetAtMs).toLocaleString();
        return (
          <span
            key={window.kind}
            className={
              expired
                ? "text-muted-foreground"
                : window.status === "rejected"
                  ? "text-amber-500"
                  : ""
            }
            title={
              `Last reported ${reported}: ${used === null ? "utilization not supplied" : used + " used"}; ${window.status}. Reset ${reset}.` +
              (expired ? " This observation has expired." : "")
            }
          >
            {label} ·{" "}
            {expired
              ? "expired"
              : used === null
                ? window.status === "rejected"
                  ? "limit reached"
                  : "—"
                : used + " used"}
          </span>
        );
      })}
    </div>
  );
}
