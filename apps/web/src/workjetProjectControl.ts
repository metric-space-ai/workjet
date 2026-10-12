import type {
  CommandId,
  CtoxGuestPreparationDiagnostic,
  ProjectId,
  CtoxWorkjetProjectControlRequest,
  CtoxWorkjetProjectControlResult,
  DesktopCtoxBridge,
  CtoxWorkjetProjectKpis,
} from "@workjet/contracts";
import { projectControlReadKey } from "@workjet/shared/projectControlRead";
import { readActiveWorkjetScope } from "./activeWorkjetScope";
import { newCommandId } from "./lib/utils";

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

/** Workjet spricht Deutsch; die Electron-Browsersprache („en-US“) zählt nicht. */
export function workjetUiLanguage(): "de" | "en" {
  const language = typeof document !== "undefined" ? document.documentElement.lang : "de";
  return language.toLowerCase().startsWith("en") ? "en" : "de";
}

/**
 * Fehlermeldungen sind immer Deutsch, auch wenn ein Aufrufer eine Sprache übergibt.
 * Der optionale Sprachparameter bleibt nur für bestehende Aufrufstellen erhalten.
 */
export function describeGuestPreparationStage(
  stage: CtoxGuestPreparationDiagnostic["stage"],
  _language: "de" | "en" = "de",
): string {
  const labels = {
    discovery: "Instanz finden",
    launch: "Instanz starten",
    session: "Sitzung vorbereiten",
    host_window: "App-Fenster bereitstellen",
    renderer_budget: "Freien Instanzplatz bereitstellen",
    create_view: "Instanzansicht erstellen",
    request_guard: "Geschützte Verbindung einrichten",
    guest_handlers: "Instanzansicht vorbereiten",
    attach: "Instanzansicht einbinden",
    navigation_commit: "Instanzseite laden",
    session_events: "Sitzungsereignisse verbinden",
  };
  return labels[stage];
}

export function describeGuestPreparationReason(
  diagnostic: CtoxGuestPreparationDiagnostic,
  language: "de" | "en" = "de",
): string {
  const reason = diagnostic.reason;
  switch (reason) {
    case "peer_unavailable":
    case "request_timeout":
    case "network_unavailable":
    case "owner_session_not_ready":
    case "project_control_not_ready":
    case "supervisor_control_not_ready":
      return describeWorkjetProjectControlFailure(
        { _tag: "failed", code: "guest_failed", diagnostic: { stage: "execute", reason } },
        null,
        language,
      );
    default: {
      const messages = {
        unknown: "Keine genauere Ursache aufgezeichnet.",
        exception: "Die Vorbereitung ist fehlgeschlagen.",
        unsupported_action: "Die Instanz unterstützt diese Aktion noch nicht.",
        did_fail_load: "Die Instanzseite konnte nicht geladen werden.",
        blocked_navigation: "Die Navigation der Instanzseite wurde abgelehnt.",
        destroyed: "Die Instanzansicht wurde geschlossen.",
        navigation_timeout: "Die Instanzseite hat nicht rechtzeitig geladen.",
        load_url: "Die Instanzseite konnte nicht geöffnet werden.",
        navigation_setup: "Das Laden der Instanzseite konnte nicht vorbereitet werden.",
        unexpected_origin: "Die Instanzseite hat eine unerwartete Adresse geöffnet.",
      };
      return messages[reason];
    }
  }
}

/** Only safe typed classifications enter user-facing connection messages. */
export function describeWorkjetProjectControlFailure(
  failure: WorkjetProjectControlFailure,
  instanceId: string | null = null,
  _language: "de" | "en" = "de",
): string {
  if (failure.code === "instance_disabled") return "Instanz deaktiviert.";
  if (failure.code === "instance_removed") return "Instanz entfernt.";
  if (failure.code === "authentication_required")
    return instanceId?.startsWith("managed:")
      ? "Bei ctox.dev anmelden, um die Instanz zu verbinden."
      : "Bei der Instanz anmelden, um sie zu verbinden.";
  if (failure.preparation)
    return `Die Instanzverbindung konnte nicht vorbereitet werden: ${describeGuestPreparationStage(failure.preparation.stage)}.`;
  if (failure.discovery) return "Die Instanz konnte nicht erreicht werden.";
  if (failure.code === "unsupported")
    return "Die Instanz unterstützt diese Aktion noch nicht. Business-OS-Shell aktualisieren.";
  if (failure.diagnostic) {
    const messages = {
      peer_unavailable: "Die Datenverbindung zur Instanz ist noch nicht bereit.",
      request_timeout: "Die Datenabfrage hat zu lange gedauert.",
      network_unavailable: "Die Netzwerkverbindung zur Instanz ist gestört.",
      owner_session_not_ready: "Die Sitzung des Eigentümers ist noch nicht bereit.",
      project_control_not_ready: "Die Projektverbindung wird noch aufgebaut.",
      supervisor_control_not_ready: "Die Supervisor-Verbindung wird noch aufgebaut.",
    };
    return messages[failure.diagnostic.reason];
  }
  if (failure.code === "timeout") return "Die Instanz hat nicht rechtzeitig geantwortet.";
  return "Die Verbindung zur Instanz ist gestört.";
}

async function executeWorkjetProjectControl(
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

const pendingReads = new WeakMap<
  WorkjetProjectControlPort,
  Map<
    string,
    {
      readonly pool: WorkjetProjectPoolPort | undefined;
      readonly promise: Promise<CtoxWorkjetProjectControlResult>;
    }
  >
>();

export function requestWorkjetProjectControl(
  instanceId: string,
  request: CtoxWorkjetProjectControlRequest,
  port: WorkjetProjectControlPort | undefined = activeDesktopProjectControl(),
  ensurePooled: WorkjetProjectPoolPort | undefined = activeDesktopProjectPool(),
): Promise<CtoxWorkjetProjectControlResult> {
  const readKey = projectControlReadKey(request);
  if (!port || readKey === null)
    return executeWorkjetProjectControl(instanceId, request, port, ensurePooled);
  const key = JSON.stringify([instanceId, readActiveWorkjetScope().selectionRevision, readKey]);
  let reads = pendingReads.get(port);
  if (!reads) pendingReads.set(port, (reads = new Map()));
  const existing = reads.get(key);
  if (existing && existing.pool === ensurePooled) return existing.promise;
  const currentReads = reads;
  const entry: {
    readonly pool: WorkjetProjectPoolPort | undefined;
    readonly promise: Promise<CtoxWorkjetProjectControlResult>;
  } = {
    pool: ensurePooled,
    promise: executeWorkjetProjectControl(instanceId, request, port, ensurePooled).finally(() => {
      if (currentReads.get(key) === entry) currentReads.delete(key);
    }),
  };
  reads.set(key, entry);
  return entry.promise;
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

interface ProjectKpiReadQueue {
  active: number;
  readonly waiting: Array<() => void>;
  readonly pending: Map<string, Promise<CtoxWorkjetProjectControlResult>>;
}
const kpiReadQueues = new WeakMap<WorkjetProjectControlPort, Map<string, ProjectKpiReadQueue>>();

/** One KPI read per instance across gallery rounds and project overviews.
 * Each shared read owns one real command ID; native receipts are never rewritten. */
export function readWorkjetProjectKpis(
  instanceId: string,
  projectId: ProjectId,
  port: WorkjetProjectControlPort | undefined = activeDesktopProjectControl(),
): Promise<CtoxWorkjetProjectControlResult> {
  if (!port) return Promise.resolve({ _tag: "failed", code: "not_active" });
  const revision = readActiveWorkjetScope().selectionRevision;
  const key = instanceId;
  const projectKey = JSON.stringify([projectId, revision]);
  let queues = kpiReadQueues.get(port);
  if (!queues) kpiReadQueues.set(port, (queues = new Map()));
  let queue = queues.get(key);
  if (!queue) queues.set(key, (queue = { active: 0, waiting: [], pending: new Map() }));
  const existing = queue.pending.get(projectKey);
  if (existing) return existing;
  const currentQueue = queue;
  const currentQueues = queues;
  const reading = (async (): Promise<CtoxWorkjetProjectControlResult> => {
    if (currentQueue.active >= 1)
      await new Promise<void>((resolve) => currentQueue.waiting.push(resolve));
    else currentQueue.active++;
    try {
      if (readActiveWorkjetScope().selectionRevision !== revision)
        return { _tag: "failed", code: "not_active" };
      const commandId = newCommandId();
      const result = await requestWorkjetProjectControl(
        instanceId,
        { action: "project.kpis.read", commandId, projectId },
        port,
      );
      if (readActiveWorkjetScope().selectionRevision !== revision)
        return { _tag: "failed", code: "not_active" };
      if (
        result._tag === "completed" &&
        (result.response.action !== "project.kpis.read" ||
          result.response.commandId !== commandId ||
          result.response.projectId !== projectId ||
          result.response.kpis.project_id !== projectId)
      )
        return { _tag: "failed", code: "guest_failed" };
      return result;
    } finally {
      const next = currentQueue.waiting.shift();
      if (next) next();
      else currentQueue.active--;
    }
  })().finally(() => {
    currentQueue.pending.delete(projectKey);
    if (currentQueue.pending.size === 0) currentQueues.delete(key);
  });
  currentQueue.pending.set(projectKey, reading);
  return reading;
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
