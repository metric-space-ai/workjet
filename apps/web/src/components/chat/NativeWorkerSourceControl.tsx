import type {
  EnvironmentId,
  WorkjetConnectionSummary,
  WorkjetThreadConfig,
} from "@workjet/contracts";
import { useEffect, useRef, useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import {
  workerSourceConnectionForInstance,
  workerSourceIsBound,
  workerSourceProvisionRequest,
} from "../../workjetWorkerSourceConnection";

export function NativeWorkerSourceControl(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: string | null;
  readonly config: WorkjetThreadConfig;
  readonly bindConnection: (connection: WorkjetConnectionSummary) => Promise<boolean>;
  readonly unavailable: boolean;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.workjetDecisionHubConnections({
      environmentId: props.environmentId,
      input: {},
    }),
  );
  const scope = `${props.environmentId}:${props.instanceId ?? ""}`;
  const currentContext = useRef({ scope, bindConnection: props.bindConnection });
  currentContext.current = { scope, bindConnection: props.bindConnection };
  const [provisioned, setProvisioned] = useState<{
    readonly scope: string;
    readonly connection: WorkjetConnectionSummary;
    readonly queryData: typeof query.data;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ readonly scope: string; readonly message: string } | null>(
    null,
  );
  const inFlight = useRef(false);
  const autoAttempted = useRef<string | null>(null);
  const request = workerSourceProvisionRequest(props.environmentId, props.instanceId);
  // The refreshed catalog replaces the provisioning receipt, including revocation.
  const connections =
    provisioned?.scope === scope && provisioned.queryData === query.data
      ? [provisioned.connection]
      : (query.data?.connections ?? []);
  const source = workerSourceConnectionForInstance(connections, props.instanceId);
  const ready = source?.status === "ready";
  const bound = source !== undefined && workerSourceIsBound(props.config, source);
  const provision =
    typeof window === "undefined" ? undefined : window.desktopBridge?.ctox?.provisionDecisionHub;

  const connect = async () => {
    if (!request || props.unavailable || query.isPending || inFlight.current || bound) return;
    if (!ready && !provision) {
      setError({ scope, message: "Open Workjet desktop to connect this project's workers." });
      return;
    }
    const requestedScope = scope;
    const queryData = query.data;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      let accepted = ready ? source : undefined;
      if (!accepted && provision) {
        const result = await provision(request);
        if (currentContext.current.scope !== requestedScope) return;
        if (result._tag === "failed") {
          setError({
            scope: requestedScope,
            message:
              result.code === "signed_out"
                ? "Sign in to Business OS to connect workers."
                : "Could not connect workers. Check Business OS permissions and try again.",
          });
          return;
        }
        accepted = workerSourceConnectionForInstance([result.connection], props.instanceId);
      }
      if (!accepted || accepted.status !== "ready") {
        setError({
          scope: requestedScope,
          message: "The worker connection is not ready for the selected Business OS.",
        });
        return;
      }
      // Retry a failed config save with this existing grant, without issuing another.
      setProvisioned({ scope: requestedScope, connection: accepted, queryData });
      const saved = await currentContext.current.bindConnection(accepted);
      if (currentContext.current.scope !== requestedScope) return;
      query.refresh();
      if (!saved) {
        setError({
          scope: requestedScope,
          message:
            "Could not save the worker connection for this supervisor. Retry the worker connection.",
        });
      }
    } catch {
      if (currentContext.current.scope === requestedScope) {
        setError({
          scope: requestedScope,
          message: "Could not connect workers. Check Business OS permissions and try again.",
        });
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const connectRef = useRef(connect);
  connectRef.current = connect;
  useEffect(() => {
    if (props.unavailable || query.isPending || bound || autoAttempted.current === scope) return;
    autoAttempted.current = scope;
    if (request === null) {
      setError({ scope, message: "Select a managed instance to connect workers." });
      return;
    }
    void connectRef.current();
  }, [scope, props.unavailable, query.isPending, bound, request === null]);

  const currentError = error?.scope === scope ? error.message : null;
  return (
    <span
      className="inline-flex shrink-0 items-center text-xs"
      data-workjet-worker-source-connection-id={bound ? source?.connectionId : undefined}
      data-workjet-worker-source-instance-id={bound ? source?.instanceId : undefined}
    >
      {currentError ? <button
        type="button"
        aria-label="Reconnect project workers"
        title={currentError}
        className="rounded border px-2 py-1 text-amber-500 disabled:opacity-50"
        disabled={props.unavailable || busy || query.isPending || request === null}
        onClick={() => void connectRef.current()}
      >Erneut verbinden</button> : null}
    </span>
  );
}
