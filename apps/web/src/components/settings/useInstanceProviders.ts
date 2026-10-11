import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkjetNativeModelProbe, WorkjetNativeProviderRegistry } from "@workjet/contracts";
import {
  WorkjetProjectControlError,
  type WorkjetProjectControlFailure,
} from "../../workjetProjectControl";
import {
  requestInstanceProviders,
  checkInstanceModel,
  type NativeProviderInput,
} from "../../lib/workjetNativeProviders";

// Quota refresh failures never replace a genuine model-check result or classify provider auth.
async function readReportedLimits(instanceId: string, signal: AbortSignal) {
  try {
    return await requestInstanceProviders(
      instanceId,
      { action: "instance.providers.read" },
      signal,
    );
  } catch {
    return undefined;
  }
}
function withReportedLimits(
  registry: WorkjetNativeProviderRegistry,
  receipt: WorkjetNativeProviderRegistry | undefined,
): WorkjetNativeProviderRegistry {
  if (receipt === undefined)
    return {
      ...registry,
      accounts: registry.accounts.map((account) => ({
        ...account,
        reportedQuota: { state: "unavailable", errorClass: "quota_read_failed" } as const,
      })),
    };
  return {
    ...receipt,
    accounts: receipt.accounts.map((account) => {
      const previous = registry.accounts.find(
        (entry) =>
          entry.id === account.id &&
          entry.provider === account.provider &&
          entry.holder.id === account.holder.id &&
          entry.revision === account.revision,
      );
      const checks = new Map<string, WorkjetNativeModelProbe>();
      for (const probe of [...(previous?.modelChecks ?? []), ...(account.modelChecks ?? [])]) {
        if (!account.effectiveModels.includes(probe.modelId)) continue;
        const saved = checks.get(probe.modelId);
        if (!saved || saved.checkedAtMs <= probe.checkedAtMs) checks.set(probe.modelId, probe);
      }
      return {
        ...account,
        reportedQuota: account.reportedQuota ?? ({ state: "unknown" } as const),
        ...(checks.size ? { modelChecks: [...checks.values()].slice(0, 256) } : {}),
      };
    }),
  };
}

export function useInstanceProviders(instanceId: string | null) {
  const [snapshot, setSnapshot] = useState<{
    instanceId: string;
    registry: WorkjetNativeProviderRegistry;
  }>();
  const [error, setError] = useState<{
    accountId: string | null;
    message: string;
    failure?: WorkjetProjectControlFailure;
  }>();
  const [busy, setBusy] = useState(false);
  const alive = useRef(false);
  const scope = useRef<string | null>(instanceId);
  const controller = useRef<AbortController | undefined>(undefined);
  const run = useCallback(
    async (input: NativeProviderInput) => {
      if (!instanceId || !alive.current || scope.current !== instanceId) return undefined;
      controller.current?.abort();
      const active = new AbortController();
      controller.current = active;
      setError(undefined);
      setBusy(true);
      try {
        const result = await requestInstanceProviders(instanceId, input, active.signal);
        const receipt =
          input.action === "instance.providers.read"
            ? result
            : await readReportedLimits(instanceId, active.signal);
        if (!active.signal.aborted && alive.current && scope.current === instanceId) {
          const registry = withReportedLimits(result, receipt);
          setSnapshot({ instanceId, registry });
          return registry;
        }
      } catch (failure) {
        if (!active.signal.aborted && alive.current)
          setError({
            accountId:
              failure instanceof WorkjetProjectControlError
                ? null
                : "accountId" in input
                  ? input.accountId
                  : null,
            ...(failure instanceof WorkjetProjectControlError ? { failure: failure.failure } : {}),
            message:
              failure instanceof Error ? failure.message : "Instance accounts could not be read.",
          });
      } finally {
        if (controller.current === active && !active.signal.aborted && alive.current)
          setBusy(false);
      }
      return undefined;
    },
    [instanceId],
  );
  const check = useCallback(
    async (accountId: string, accountRevision: number, modelId: string) => {
      if (!instanceId || !alive.current || scope.current !== instanceId) return undefined;
      controller.current?.abort();
      const active = new AbortController();
      controller.current = active;
      setError(undefined);
      setBusy(true);
      try {
        const probe = await checkInstanceModel(
          instanceId,
          accountId,
          accountRevision,
          modelId,
          active.signal,
        );
        if (!active.signal.aborted && alive.current) {
          setSnapshot((current) => {
            if (current?.instanceId !== instanceId) return current;
            return {
              ...current,
              registry: {
                ...current.registry,
                accounts: current.registry.accounts.map((account) =>
                  account.id === accountId && account.revision === accountRevision
                    ? {
                        ...account,
                        modelChecks: [
                          ...(account.modelChecks ?? []).filter(
                            (saved) => saved.modelId !== modelId,
                          ),
                          probe,
                        ],
                      }
                    : account,
                ),
              },
            };
          });
          const receipt = await readReportedLimits(instanceId, active.signal);
          if (!active.signal.aborted && alive.current && scope.current === instanceId) {
            setSnapshot((current) =>
              current?.instanceId === instanceId
                ? { ...current, registry: withReportedLimits(current.registry, receipt) }
                : current,
            );
            return probe;
          }
        }
      } catch (failure) {
        if (!active.signal.aborted && alive.current)
          setError({
            accountId,
            ...(failure instanceof WorkjetProjectControlError ? { failure: failure.failure } : {}),
            message: failure instanceof Error ? failure.message : "Model check unavailable.",
          });
      } finally {
        if (controller.current === active && !active.signal.aborted && alive.current)
          setBusy(false);
      }
      return undefined;
    },
    [instanceId],
  );
  useEffect(() => {
    alive.current = true;
    scope.current = instanceId;
    setSnapshot(undefined);
    setError(undefined);
    setBusy(false);
    if (instanceId) void run({ action: "instance.providers.read" });
    return () => {
      alive.current = false;
      scope.current = null;
      controller.current?.abort();
    };
  }, [instanceId, run]);
  const refresh = useCallback(() => run({ action: "instance.providers.adopt" }), [run]);
  return {
    registry: snapshot?.instanceId === instanceId ? snapshot.registry : undefined,
    error: error?.message,
    errorAccountId: error?.accountId,
    ...(error?.failure ? { connectionFailure: error.failure } : {}),
    busy,
    run,
    check,
    refresh,
  };
}
