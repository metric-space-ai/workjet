import type {
  EnvironmentId,
  WorkjetConnectionSummary,
  WorkjetThreadConfig,
} from "@workjet/contracts";
import { rotateWorkjetCtoxWorkerSource } from "@workjet/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  WorkerSourceConnectionPicker,
  type WorkerSourceConnectionChoice,
} from "./WorkerSourceConnectionPicker";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import {
  workerSourceConnectionForInstance,
  workerSourceIsBound,
  workerSourceProvisionRequest,
  workerSourceBindingError,
  workerSourceBindingFailure,
} from "../../workjetWorkerSourceConnection";

export interface WorkerSourceConnectionStatus {
  readonly message: string;
  readonly retry: (() => void) | null;
  readonly disabled: boolean;
  readonly authenticationRequired: boolean;
  readonly choice?: WorkerSourceConnectionChoice;
}

export function NativeWorkerSourceControl(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: string | null;
  readonly config: WorkjetThreadConfig;
  readonly bindConnection: (
    connection: WorkjetConnectionSummary,
  ) => Promise<{ readonly _tag: "saved" } | { readonly _tag: "failed"; readonly error: unknown }>;
  readonly unavailable: boolean;
  readonly headless?: boolean;
  readonly onStatusChange?: (status: WorkerSourceConnectionStatus | null) => void;
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
  const [error, setError] = useState<{
    readonly scope: string;
    readonly message: string;
    readonly retryable?: boolean;
    readonly authenticationRequired?: boolean;
  } | null>(null);
  const inFlight = useRef(false);
  const autoAttempted = useRef<string | null>(null);
  const request = workerSourceProvisionRequest(props.environmentId, props.instanceId);
  // The refreshed catalog replaces the provisioning receipt, including revocation.
  const connections = useMemo(
    () =>
      provisioned?.scope === scope && provisioned.queryData === query.data
        ? [provisioned.connection]
        : (query.data?.connections ?? []),
    [provisioned, scope, query.data],
  );
  const boundSource = connections.find(
    (entry) =>
      workerSourceConnectionForInstance([entry], props.instanceId) &&
      workerSourceIsBound(props.config, entry),
  );
  const source = boundSource ?? workerSourceConnectionForInstance(connections, props.instanceId);
  const selectionError =
    rotateWorkjetCtoxWorkerSource(props.config, connections).error ??
    (!boundSource &&
    connections.filter(
      (entry) =>
        entry.status === "ready" && workerSourceConnectionForInstance([entry], props.instanceId),
    ).length > 1
      ? "Multiple authorized worker connections match this instance. Remove the unused connection in Settings before reconnecting."
      : source?.status === "ready"
        ? workerSourceBindingError(props.config, props.instanceId, source)
        : null);
  const ready = source?.status === "ready";
  const bound = source !== undefined && workerSourceIsBound(props.config, source);
  const selectableConnections = useMemo(
    () =>
      connections.filter(
        (entry) =>
          entry.status === "ready" &&
          workerSourceConnectionForInstance([entry], props.instanceId) &&
          workerSourceBindingError(props.config, props.instanceId, entry) === null,
      ),
    [connections, props.instanceId, props.config],
  );
  const chooseConnection = !bound && selectableConnections.length > 1;
  const provision =
    typeof window === "undefined" ? undefined : window.desktopBridge?.ctox?.provisionDecisionHub;

  const connect = async (renew = false, selectedConnectionId?: string) => {
    const selected = selectableConnections.find(
      (entry) => entry.connectionId === selectedConnectionId,
    );
    if (
      !request ||
      props.unavailable ||
      query.isPending ||
      inFlight.current ||
      (bound && !renew) ||
      (selectionError && !selected) ||
      (selectedConnectionId !== undefined && !selected)
    )
      return;
    if (!selected && (!ready || renew) && !provision) {
      setError({ scope, message: "Open Workjet desktop to connect this project's workers." });
      return;
    }
    const requestedScope = scope;
    const queryData = query.data;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      let accepted = selected ?? (ready && !renew ? source : undefined);
      if (!accepted && provision) {
        const result = await provision(request);
        if (currentContext.current.scope !== requestedScope) return;
        if (result._tag === "failed") {
          setError({
            scope: requestedScope,
            authenticationRequired: result.code === "signed_out",
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
      const bindingError = workerSourceBindingError(props.config, props.instanceId, accepted);
      if (bindingError) {
        setError({ scope: requestedScope, message: bindingError, retryable: false });
        return;
      }
      setProvisioned({ scope: requestedScope, connection: accepted, queryData });
      const saved = await currentContext.current.bindConnection(accepted);
      if (currentContext.current.scope !== requestedScope) return;
      query.refresh();
      if (saved._tag === "failed") {
        setError({
          scope: requestedScope,
          ...workerSourceBindingFailure(saved.error),
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
    if (
      props.unavailable ||
      query.isPending ||
      busy ||
      inFlight.current ||
      bound ||
      selectionError ||
      autoAttempted.current === scope
    )
      return;
    autoAttempted.current = scope;
    if (request === null) {
      setError({ scope, message: "Select a managed instance to connect workers." });
      return;
    }
    void connectRef.current();
  }, [scope, props.unavailable, query.isPending, busy, bound, selectionError, request === null]);

  const currentError =
    error?.scope === scope
      ? error.message
      : bound
        ? null
        : (selectionError ??
          (error?.scope === scope ? error.message : null) ??
          (!query.isPending && source !== undefined && !ready
            ? source.status === "needs_auth"
              ? "Worker connection needs authorization. Reconnect project workers."
              : "The worker connection is unavailable. Reconnect project workers."
            : !query.isPending &&
                ready &&
                props.config.schemaVersion === 2 &&
                props.config.capabilityBindings.some(
                  (binding) => binding.capabilityId === "ctox-business-os",
                )
              ? "A replacement worker connection is ready. Reconnect this thread to use it."
              : null));
  const canRetry = !selectionError && !(error?.scope === scope && error.retryable === false);
  useEffect(() => {
    props.onStatusChange?.(
      currentError || chooseConnection
        ? {
            message: chooseConnection
              ? error?.scope === scope
                ? error.message
                : "Choose worker access for this Supervisor."
              : currentError!,
            authenticationRequired:
              !chooseConnection &&
              (source?.status === "needs_auth" ||
                (error?.scope === scope && error.authenticationRequired === true)),
            retry: canRetry ? () => void connectRef.current(bound) : null,
            disabled: props.unavailable || busy || query.isPending || request === null,
            ...(chooseConnection
              ? {
                  choice: {
                    connections: selectableConnections,
                    select: (connectionId: string) => void connectRef.current(false, connectionId),
                  },
                }
              : {}),
          }
        : null,
    );
  }, [
    currentError,
    chooseConnection,
    selectableConnections,
    error?.message,
    source?.status,
    error?.scope,
    error?.authenticationRequired,
    canRetry,
    bound,
    props.unavailable,
    busy,
    query.isPending,
    request === null,
    props.onStatusChange,
  ]);
  if (props.headless) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center text-xs"
      data-workjet-worker-source-connection-id={bound ? source?.connectionId : undefined}
      data-workjet-worker-source-instance-id={bound ? source?.instanceId : undefined}
    >
      {chooseConnection ? (
        <WorkerSourceConnectionPicker
          choice={{
            connections: selectableConnections,
            select: (connectionId) => void connectRef.current(false, connectionId),
          }}
          disabled={props.unavailable || busy || query.isPending || request === null}
        />
      ) : currentError &&
        (selectionError || (error?.scope === scope && error.retryable === false)) ? (
        <span role="alert" className="text-amber-500">
          {currentError}
        </span>
      ) : currentError ? (
        <button
          type="button"
          aria-label="Reconnect project workers"
          title={currentError}
          className="rounded border px-2 py-1 text-amber-500 disabled:opacity-50"
          disabled={props.unavailable || busy || query.isPending || request === null}
          onClick={() => void connectRef.current(bound)}
        >
          Erneut verbinden
        </button>
      ) : null}
      {chooseConnection && error?.scope === scope ? (
        <span role="alert" className="text-amber-500">
          {error.message}
        </span>
      ) : null}
    </span>
  );
}
