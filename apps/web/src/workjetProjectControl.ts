import type {
  CommandId,
  ProjectId,
  CtoxWorkjetProjectControlRequest,
  CtoxWorkjetProjectControlResult,
  DesktopCtoxBridge,
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
