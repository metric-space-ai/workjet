import type { WorkjetNativeProviderAccount } from "@workjet/contracts";
import { useEffect, useState } from "react";
import { AccountLimits } from "./WorkjetModelsProviders";
import { RowStatusDot } from "../ui/row";
import {
  MODELS_QUOTA_FRESH_FOR_MS,
  nativeQuotaResets,
  normalizeNativeModelsQuota,
} from "./WorkjetModelsQuota";

export function NativeProviderLimits({
  provider,
  quota,
  className = "",
}: {
  readonly provider: string;
  readonly quota: WorkjetNativeProviderAccount["reportedQuota"];
  readonly className?: string;
}) {
  const [expiryTick, setExpiryTick] = useState(0);
  const now = Date.now();
  // Repaint only when evidence ages or a reported window expires.
  useEffect(() => {
    if (quota?.state !== "reported") return;
    const future = nativeQuotaResets(quota).filter((at) => at > Date.now());
    if (future.length === 0) return;
    const staleAt = quota.observedAtMs + MODELS_QUOTA_FRESH_FOR_MS;
    if (staleAt > Date.now()) future.push(staleAt);
    const timer = setTimeout(
      () => setExpiryTick((tick) => tick + 1),
      Math.max(1, Math.min(...future) - Date.now() + 1),
    );
    return () => clearTimeout(timer);
  }, [quota, expiryTick]);

  if (quota?.state === "unavailable") {
    // A failed quota read is the status dot alone, never a sentence (ctox#872).
    return (
      <div role="cell" className={`flex items-center ${className}`}>
        <RowStatusDot status="error" label="Kontingent nicht lesbar" />
      </div>
    );
  }
  if (quota?.state !== "reported") {
    return (
      // Unknown limits show nothing (#610).
      <div role="cell" className={`text-xs text-muted-foreground ${className}`} />
    );
  }
  return (
    <div role="cell" className={`min-w-0 ${className}`}>
      <AccountLimits
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
