import type {
  CtoxWorkjetSessionControlRequest,
  CtoxWorkjetSessionControlResult,
  DesktopCtoxBridge,
} from "@workjet/contracts";
import { getCtoxClient } from "./ctox/ctoxClient";
import { localReadFailure } from "./ctox/projectReadData";
import { readCtoxSessions } from "./ctox/sessionData";
import { readCtoxSessionTransfer } from "./ctox/sessionTransferData";

export type WorkjetSessionControlPort = NonNullable<DesktopCtoxBridge["requestSessionControl"]>;
export type WorkjetSessionPoolPort = NonNullable<DesktopCtoxBridge["ensurePooled"]>;

function activeDesktopSessionControl(): WorkjetSessionControlPort | undefined {
  if (typeof window === "undefined") return undefined;
  return window.desktopBridge?.ctox?.requestSessionControl;
}

function activeDesktopSessionPool(): WorkjetSessionPoolPort | undefined {
  if (typeof window === "undefined") return undefined;
  return window.desktopBridge?.ctox?.ensurePooled;
}

export async function requestWorkjetSessionControl(
  instanceId: string,
  request: CtoxWorkjetSessionControlRequest,
  port: WorkjetSessionControlPort | undefined = activeDesktopSessionControl(),
  ensurePooled: WorkjetSessionPoolPort | undefined = activeDesktopSessionPool(),
): Promise<CtoxWorkjetSessionControlResult> {
  // V4 instance (bound kernel client): session reads are local queries (E32).
  const api = getCtoxClient(instanceId);
  if (api !== null && request.action === "session.transfer.status") {
    try {
      return {
        _tag: "completed",
        response: { action: request.action, outcome: readCtoxSessionTransfer(api, request) },
      };
    } catch (error) {
      const failure = localReadFailure(error);
      return {
        _tag: "failed",
        code: "invalid_input",
        ...(failure._tag === "failed" && failure.error ? { error: failure.error } : {}),
      };
    }
  }
  if (api !== null && request.action === "session.list")
    return {
      _tag: "completed",
      response: { action: "session.list", sessions: readCtoxSessions(api) },
    };
  if (port === undefined) return { _tag: "failed", code: "not_active" };
  if (instanceId.trim() === "") return { _tag: "failed", code: "not_active" };
  const first = await port(instanceId, request);
  if (first._tag !== "failed" || first.code !== "not_active" || ensurePooled === undefined) {
    return first;
  }
  await ensurePooled(instanceId);
  return port(instanceId, request);
}

export function listWorkjetSessions(
  instanceId: string,
  port?: WorkjetSessionControlPort,
  ensurePooled?: WorkjetSessionPoolPort,
): Promise<CtoxWorkjetSessionControlResult> {
  return requestWorkjetSessionControl(instanceId, { action: "session.list" }, port, ensurePooled);
}

export function createWorkjetSession(
  instanceId: string,
  request: Extract<CtoxWorkjetSessionControlRequest, { readonly action: "session.create" }>,
  port?: WorkjetSessionControlPort,
  ensurePooled?: WorkjetSessionPoolPort,
): Promise<CtoxWorkjetSessionControlResult> {
  return requestWorkjetSessionControl(instanceId, request, port, ensurePooled);
}

export function startWorkjetSessionTransfer(
  instanceId: string,
  request: Extract<CtoxWorkjetSessionControlRequest, { readonly action: "session.transfer.start" }>,
  port?: WorkjetSessionControlPort,
  ensurePooled?: WorkjetSessionPoolPort,
): Promise<CtoxWorkjetSessionControlResult> {
  return requestWorkjetSessionControl(instanceId, request, port, ensurePooled);
}

export function readWorkjetSessionTransferStatus(
  instanceId: string,
  request: Extract<
    CtoxWorkjetSessionControlRequest,
    { readonly action: "session.transfer.status" }
  >,
  port?: WorkjetSessionControlPort,
  ensurePooled?: WorkjetSessionPoolPort,
): Promise<CtoxWorkjetSessionControlResult> {
  return requestWorkjetSessionControl(instanceId, request, port, ensurePooled);
}

export function abortWorkjetSessionTransfer(
  instanceId: string,
  request: Extract<CtoxWorkjetSessionControlRequest, { readonly action: "session.transfer.abort" }>,
  port?: WorkjetSessionControlPort,
  ensurePooled?: WorkjetSessionPoolPort,
): Promise<CtoxWorkjetSessionControlResult> {
  return requestWorkjetSessionControl(instanceId, request, port, ensurePooled);
}

export function acknowledgeWorkjetSessionPause(
  instanceId: string,
  request: Extract<
    CtoxWorkjetSessionControlRequest,
    { readonly action: "session.transfer.pause_ack" }
  >,
  port?: WorkjetSessionControlPort,
  ensurePooled?: WorkjetSessionPoolPort,
): Promise<CtoxWorkjetSessionControlResult> {
  return requestWorkjetSessionControl(instanceId, request, port, ensurePooled);
}
