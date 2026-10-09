import type {
  CommandId,
  ProjectId,
  CtoxWorkjetProjectControlRequest,
  CtoxWorkjetProjectControlResult,
  DesktopCtoxBridge,
  CtoxWorkjetProjectKpis,
} from "@workjet/contracts";

export type WorkjetProjectControlPort = NonNullable<DesktopCtoxBridge["requestProjectControl"]>;
export type WorkjetProjectPoolPort = NonNullable<DesktopCtoxBridge["ensurePooled"]>;

function activeDesktopProjectControl(): WorkjetProjectControlPort | undefined {
  if (typeof window === "undefined") return undefined;
  return window.desktopBridge?.ctox?.requestProjectControl;
}

function activeDesktopProjectPool(): WorkjetProjectPoolPort | undefined {
  if (typeof window === "undefined") return undefined;
  return window.desktopBridge?.ctox?.ensurePooled;
}

/** Fixed discovery facts only; no response bodies or account material enter UI copy. */
export function describeWorkjetProjectControlFailure(
  failure: Extract<CtoxWorkjetProjectControlResult, { _tag: "failed" }>,
  instanceId: string | null = null,
): string {
  if (failure.code === "authentication_required")
    return instanceId?.startsWith("managed:")
      ? "Sign in to ctox.dev to reconnect this project's instance."
      : "Sign in to this CTOX instance to reconnect.";
  if (failure.discovery !== undefined)
    return `Instance discovery failed: ${failure.discovery.code}${failure.discovery.httpStatus === undefined ? "" : ` (HTTP ${failure.discovery.httpStatus})`}. Retry connection.`;
  if (failure.diagnostic !== undefined) {
    const messages = {
      owner_session_not_ready: "The instance's owner session is not ready. Reconnect the instance.",
      project_control_not_ready: "Project controls are not ready on this instance. Retry connection.",
      supervisor_control_not_ready: "Supervisor controls are not ready on this instance. Retry connection.",
      unsupported_action: "The connected instance does not support this action. Update its shell.",
      response_invalid: "The instance returned an invalid history response. Reload the history.",
      schema_invalid: "The history response does not match this Workjet version. Check the instance version.",
      receipt_mismatch: "The history receipt belongs to a different request or run. Reload the history.",
      exception: "The connected instance failed while reading history. Retry connection.",
    };
    return messages[failure.diagnostic.reason];
  }
  if (failure.code === "not_active")
    return "This project's bound instance is unavailable. Check the CTOX connection.";
  if (failure.code === "unsupported")
    return "The connected CTOX instance does not support this action. Update its Business OS shell.";
  return `CTOX: ${failure.code}. Check the task and reconnect.`;
}

export async function requestWorkjetProjectControl(
  instanceId: string,
  request: CtoxWorkjetProjectControlRequest,
  port: WorkjetProjectControlPort | undefined = activeDesktopProjectControl(),
  ensurePooled: WorkjetProjectPoolPort | undefined = activeDesktopProjectPool(),
): Promise<CtoxWorkjetProjectControlResult> {
  if (port === undefined) return { _tag: "failed", code: "not_active" };
  if (instanceId.trim() === "") return { _tag: "failed", code: "not_active" };
  const first = await port(instanceId, request);
  if (first._tag !== "failed" || first.code !== "not_active" || ensurePooled === undefined) {
    return first;
  }
  const preparation = await ensurePooled(instanceId);
  if (preparation._tag === "revoked") return { _tag: "failed", code: "not_active" };
  if (preparation._tag === "failed") return preparation;
  if (preparation.instanceId !== instanceId) return { _tag: "failed", code: "not_active" };
  return port(instanceId, request);
}

export async function listWorkjetProjects(
  instanceId: string,
  port?: WorkjetProjectControlPort,
): Promise<CtoxWorkjetProjectControlResult> {
  const configured = await requestWorkjetProjectControl(
    instanceId,
    { action: "project.list", includeConfiguration: true },
    port,
  );
  // Older shells reject the additive flag. Retry the same authorized guest's
  // legacy projection; count/completeness and instance guards remain unchanged.
  if (
    configured._tag === "failed" &&
    configured.discovery === undefined &&
    (configured.code === "unsupported" || configured.code === "guest_failed")
  ) {
    return requestWorkjetProjectControl(instanceId, { action: "project.list" }, port);
  }
  return configured;
}

export function createWorkjetProject(
  instanceId: string,
  request: Extract<CtoxWorkjetProjectControlRequest, { readonly action: "project.create" }>,
  port?: WorkjetProjectControlPort,
): Promise<CtoxWorkjetProjectControlResult> {
  return requestWorkjetProjectControl(instanceId, request, port);
}

export function configureWorkjetProject(
  instanceId: string,
  request: Extract<CtoxWorkjetProjectControlRequest, { readonly action: "project.configure" }>,
  port?: WorkjetProjectControlPort,
): Promise<CtoxWorkjetProjectControlResult> {
  return requestWorkjetProjectControl(instanceId, request, port);
}

export function readWorkjetProjectKpis(
  instanceId: string,
  projectId: ProjectId,
  commandId: CommandId,
  port?: WorkjetProjectControlPort,
): Promise<CtoxWorkjetProjectControlResult> {
  return requestWorkjetProjectControl(
    instanceId,
    { action: "project.kpis.read", commandId, projectId },
    port,
  );
}

/** Apply only the correlated native revision; never calculate or persist caller values. */
export async function saveWorkjetProjectKpis(
  instanceId: string,
  request: Extract<CtoxWorkjetProjectControlRequest, { readonly action: "project.kpis.configure" }>,
  port?: WorkjetProjectControlPort,
): Promise<CtoxWorkjetProjectKpis | null> {
  try {
    const result = await requestWorkjetProjectControl(instanceId, request, port);
    if (result._tag !== "completed" || result.response.action !== "project.kpis.configure")
      return null;
    const response = result.response;
    return response.commandId === request.commandId &&
      response.projectId === request.projectId &&
      response.kpis.project_id === request.projectId &&
      response.kpis.revision > request.expectedRevision
      ? response.kpis
      : null;
  } catch {
    return null;
  }
}

export function readWorkjetGalleryOrder(
  instanceId: string,
  commandId: CommandId,
  port?: WorkjetProjectControlPort,
): Promise<CtoxWorkjetProjectControlResult> {
  return requestWorkjetProjectControl(
    instanceId,
    { action: "project.gallery.order.read", commandId },
    port,
  );
}

export function saveWorkjetGalleryOrder(
  instanceId: string,
  request: {
    readonly commandId: CommandId;
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly projectIds: readonly ProjectId[];
  },
  port?: WorkjetProjectControlPort,
): Promise<CtoxWorkjetProjectControlResult> {
  return requestWorkjetProjectControl(
    instanceId,
    { action: "project.gallery.order.set", ...request },
    port,
  );
}
