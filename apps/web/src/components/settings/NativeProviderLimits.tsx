import type { WorkjetNativeProviderAccount } from "@workjet/contracts";
import { useEffect, useState } from "react";
import { AccountLimits } from "./WorkjetModelsProviders";
import { MODELS_QUOTA_FRESH_FOR_MS, normalizeNativeModelsQuota } from "./WorkjetModelsQuota";

export function NativeProviderLimits({
  provider,
  quota,
}: {
  readonly provider: string;
  readonly quota: WorkjetNativeProviderAccount["reportedQuota"];
}) {
  const [expiryTick, setExpiryTick] = useState(0);
  const now = Date.now();
  // Repaint only when evidence ages or a reported window expires.
  useEffect(() => {
    if (quota?.state !== "reported") return;
    const future = quota.windows.map((window) => window.resetAtMs).filter((at) => at > Date.now());
    if (future.length === 0) return;
    const staleAt = quota.observedAtMs + MODELS_QUOTA_FRESH_FOR_MS;
    if (staleAt > Date.now()) future.push(staleAt);
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
  return (
    <div role="cell" className="min-w-0">
      <AccountLimits
        provider={provider}
        health={{
          status: "unknown",
          message: null,
          retryAtMs: null,
          balance: null,
          windows: normalizeNativeModelsQuota(provider, quota, now),
          observedAtMs: quota.observedAtMs,
          quotaSupported: true,
          quotaRefreshing: false,
          quotaError: null,
        }}
      />
    </div>
  );
}
