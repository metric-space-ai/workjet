import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkjetNativeProviderRegistry } from "@workjet/contracts";
import {
  WorkjetProjectControlError,
  type WorkjetProjectControlFailure,
} from "../../workjetProjectControl";
import {
  requestInstanceProviders,
  type NativeProviderInput,
} from "../../lib/workjetNativeProviders";

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
  const controller = useRef<AbortController | undefined>(undefined);
  const run = useCallback(
    async (input: NativeProviderInput) => {
      if (!instanceId || !alive.current) return undefined;
      controller.current?.abort();
      const active = new AbortController();
      controller.current = active;
      setError(undefined);
      setBusy(true);
      try {
        const result = await requestInstanceProviders(instanceId, input, active.signal);
        if (!active.signal.aborted && alive.current) {
          setSnapshot({ instanceId, registry: result });
          return result;
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
  useEffect(() => {
    alive.current = true;
    setSnapshot(undefined);
    setError(undefined);
    setBusy(false);
    if (instanceId) void run({ action: "instance.providers.read" });
    return () => {
      alive.current = false;
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
    refresh,
  };
}
