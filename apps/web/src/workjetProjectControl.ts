import type {
  CommandId,
  CtoxGuestPreparationDiagnostic,
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

export type WorkjetProjectControlFailure = Extract<
  CtoxWorkjetProjectControlResult,
  { _tag: "failed" }
>;

export class WorkjetProjectControlError extends Error {
  constructor(
    readonly failure: WorkjetProjectControlFailure,
    instanceId: string,
  ) {
    super(describeWorkjetProjectControlFailure(failure, instanceId));
    this.name = "WorkjetProjectControlError";
  }
}

export function workjetUiLanguage(): "de" | "en" {
  const language =
    typeof document !== "undefined" && document.documentElement.lang
      ? document.documentElement.lang
      : typeof navigator !== "undefined"
        ? navigator.language
        : "en";
  return language.toLowerCase().startsWith("de") ? "de" : "en";
}

export function describeGuestPreparationStage(
  stage: CtoxGuestPreparationDiagnostic["stage"],
  language = workjetUiLanguage(),
): string {
  const labels = {
    discovery: ["Instanz finden", "Instance discovery"],
    launch: ["Instanz starten", "Instance launch"],
    session: ["Sitzung vorbereiten", "Session preparation"],
    host_window: ["App-Fenster bereitstellen", "Host window"],
    renderer_budget: ["Freien Instanzplatz bereitstellen", "Renderer capacity"],
    create_view: ["Instanzansicht erstellen", "Instance view"],
    request_guard: ["Geschützte Verbindung einrichten", "Request guard"],
    guest_handlers: ["Instanzansicht vorbereiten", "Instance handlers"],
    attach: ["Instanzansicht einbinden", "View attachment"],
    navigation_commit: ["Instanzseite laden", "Instance page loading"],
    session_events: ["Sitzungsereignisse verbinden", "Session events"],
  };
  return labels[stage][language === "de" ? 0 : 1]!;
}

/** Only safe typed classifications enter user-facing connection messages. */
export function describeWorkjetProjectControlFailure(
  failure: WorkjetProjectControlFailure,
  instanceId: string | null = null,
  language = workjetUiLanguage(),
): string {
  const de = language === "de";
  if (failure.code === "authentication_required")
    return instanceId?.startsWith("managed:")
      ? de
        ? "Bei ctox.dev anmelden, um die Instanz zu verbinden."
        : "Sign in to ctox.dev to reconnect this instance."
      : de
        ? "Bei der Instanz anmelden, um sie zu verbinden."
        : "Sign in to this instance to reconnect.";
  if (failure.preparation)
    return de
      ? `Die Instanzverbindung konnte nicht vorbereitet werden: ${describeGuestPreparationStage(failure.preparation.stage, language)}.`
      : `The instance connection could not be prepared: ${describeGuestPreparationStage(failure.preparation.stage, language)}.`;
  if (failure.discovery)
    return de ? "Die Instanz konnte nicht erreicht werden." : "The instance could not be reached.";
  if (failure.code === "unsupported")
    return de
      ? "Die Instanz unterstützt diese Aktion noch nicht. Business-OS-Shell aktualisieren."
      : "The connected instance does not support this action. Update its Business OS shell.";
  if (failure.diagnostic) {
    const messages = {
      peer_unavailable: [
        "Die Datenverbindung zur Instanz ist noch nicht bereit.",
        "The instance data connection is not connected yet.",
      ],
      request_timeout: [
        "Die Datenabfrage hat zu lange gedauert.",
        "The instance data request timed out.",
      ],
      network_unavailable: [
        "Die Netzwerkverbindung zur Instanz ist gestört.",
        "The instance connection could not reach the network.",
      ],
      owner_session_not_ready: [
        "Die Sitzung des Eigentümers ist noch nicht bereit.",
        "The instance Owner session is not ready.",
      ],
      project_control_not_ready: [
        "Die Projektverbindung wird noch aufgebaut.",
        "The instance project connection is still starting.",
      ],
      supervisor_control_not_ready: [
        "Die Supervisor-Verbindung wird noch aufgebaut.",
        "The instance Supervisor connection is still starting.",
      ],
    };
    return messages[failure.diagnostic.reason][de ? 0 : 1]!;
  }
  if (failure.code === "timeout")
    return de
      ? "Die Instanz hat nicht rechtzeitig geantwortet."
      : "The instance did not respond in time.";
  return de
    ? "Die Verbindung zur Instanz ist gestört."
    : "The connection to the instance is interrupted.";
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
  let configured = await requestWorkjetProjectControl(
    instanceId,
    { action: "project.list", includeConfiguration: true, includeSupervisorLuma: true },
    port,
  );
  // Negotiate the Luma projection separately so older configured shells keep
  // their metadata. Neither fallback changes guest or authority.
  if (
    configured._tag === "failed" &&
    configured.discovery === undefined &&
    configured.diagnostic === undefined &&
    configured.preparation === undefined &&
    (configured.code === "unsupported" || configured.code === "guest_failed")
  ) {
    configured = await requestWorkjetProjectControl(
      instanceId,
      { action: "project.list", includeConfiguration: true },
      port,
    );
  }
  // Pre-configuration shells retain their legacy projection.
  if (
    configured._tag === "failed" &&
    configured.discovery === undefined &&
    configured.diagnostic === undefined &&
    configured.preparation === undefined &&
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
