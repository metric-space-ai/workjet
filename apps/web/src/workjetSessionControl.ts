import type {
  CtoxWorkjetSessionControlRequest,
  CtoxWorkjetSessionControlResult,
  DesktopCtoxBridge,
} from "@t3tools/contracts";

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
