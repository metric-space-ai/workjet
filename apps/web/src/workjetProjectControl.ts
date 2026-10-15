import type { CtoxWorkjetProjectFeedPost } from "@workjet/contracts";
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
import { getCtoxClient } from "./ctox/ctoxClient";
import { readLocalWorkjetProjects, readLocalWorkjetKpis } from "./ctox/workjetCollections";

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

/**
 * The instance answers, but its CTOX core is older than the shell (#681).
 * Reconnecting cannot help; the core has to be applied on the instance.
 */
export function isCoreOutdatedFailure(failure: WorkjetProjectControlFailure | undefined): boolean {
  return failure?.diagnostic?.reason === "core_outdated";
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
      core_outdated:
        "Der CTOX-Core der Instanz ist zu alt für diese Funktion. CTOX auf der Instanz aktualisieren.",
      access_denied: "Dafür braucht dein Konto auf der Instanz die Rolle Owner oder Admin.",
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
  port?: WorkjetProjectControlPort,
  ensurePooled?: WorkjetProjectPoolPort,
): Promise<CtoxWorkjetProjectControlResult> {
  if (request.action === "project.list") return listWorkjetProjects(instanceId);
  if (request.action === "project.kpis.read")
    return readWorkjetProjectKpis(instanceId, request.projectId).then((result) =>
      result._tag === "completed" && result.response.action === "project.kpis.read"
        ? { ...result, response: { ...result.response, commandId: request.commandId } }
        : result,
    );
  const legacyPort = port ?? activeDesktopProjectControl();
  const legacyPool = ensurePooled ?? activeDesktopProjectPool();
  const readKey = projectControlReadKey(request);
  if (!legacyPort || readKey === null)
    return executeWorkjetProjectControl(instanceId, request, legacyPort, legacyPool);
  const key = JSON.stringify([instanceId, readActiveWorkjetScope().selectionRevision, readKey]);
  let reads = pendingReads.get(legacyPort);
  if (!reads) pendingReads.set(legacyPort, (reads = new Map()));
  const existing = reads.get(key);
  if (existing && existing.pool === legacyPool) return existing.promise;
  const currentReads = reads;
  const entry: {
    readonly pool: WorkjetProjectPoolPort | undefined;
    readonly promise: Promise<CtoxWorkjetProjectControlResult>;
  } = {
    pool: legacyPool,
    promise: executeWorkjetProjectControl(instanceId, request, legacyPort, legacyPool).finally(
      () => {
        if (currentReads.get(key) === entry) currentReads.delete(key);
      },
    ),
  };
  reads.set(key, entry);
  return entry.promise;
}

export async function listWorkjetProjects(
  instanceId: string,
  _port?: WorkjetProjectControlPort,
): Promise<CtoxWorkjetProjectControlResult> {
  const api = getCtoxClient(instanceId);
  if (api === null) return { _tag: "failed", code: "not_active" };
  const projects = readLocalWorkjetProjects(api);
  return {
    _tag: "completed",
    response: { action: "project.list", projects, count: projects.length, truncated: false },
  };
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

/** Read the selected instance's local projection; never dispatch a read command. */
export async function readWorkjetProjectKpis(
  instanceId: string,
  projectId: ProjectId,
  _port?: WorkjetProjectControlPort,
): Promise<CtoxWorkjetProjectControlResult> {
  const api = getCtoxClient(instanceId);
  if (api === null) return { _tag: "failed", code: "not_active" };
  const kpis = readLocalWorkjetKpis(api, projectId) ?? {
    project_id: projectId,
    revision: 0,
    items: [],
  };
  return {
    _tag: "completed",
    response: {
      action: "project.kpis.read",
      commandId: newCommandId(),
      projectId,
      contract: "ctox.workjet.project_kpis.v1",
      kpis,
    },
  };
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

/** Manual KPI recalculation (#502). CTOX bounds the run and reports per KPI; null = not reachable. */
export async function refreshWorkjetProjectKpis(
  instanceId: string,
  projectId: ProjectId,
  port?: WorkjetProjectControlPort,
): Promise<CtoxWorkjetProjectKpis | null> {
  const commandId = newCommandId();
  try {
    const result = await requestWorkjetProjectControl(
      instanceId,
      { action: "project.kpis.refresh", commandId, projectId },
      port,
    );
    if (result._tag !== "completed" || result.response.action !== "project.kpis.refresh")
      return null;
    const response = result.response;
    return response.commandId === commandId &&
      response.projectId === projectId &&
      response.kpis.project_id === projectId
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

/**
 * Supervisor-written feed posts (ctox.workjet.project_feed.v1). A core without
 * the feed answers `unsupported`; callers then keep their derived cards.
 */
export async function readWorkjetProjectFeed(
  instanceId: string,
  projectId: ProjectId,
  port: WorkjetProjectControlPort | undefined = activeDesktopProjectControl(),
): Promise<
  | { readonly _tag: "posts"; readonly posts: readonly CtoxWorkjetProjectFeedPost[] }
  | { readonly _tag: "unsupported" }
  | { readonly _tag: "failed"; readonly code: string }
> {
  if (!port) return { _tag: "failed", code: "not_active" };
  const commandId = newCommandId();
  const result = await requestWorkjetProjectControl(
    instanceId,
    { action: "project.feed.read", commandId, projectId, limit: 30 },
    port,
  );
  if (result._tag !== "completed")
    return result.code === "unsupported" ||
      ("reason" in result && /unsupported|unknown action/i.test(String(result.reason)))
      ? { _tag: "unsupported" }
      : { _tag: "failed", code: result.code };
  if (
    result.response.action !== "project.feed.read" ||
    result.response.commandId !== commandId ||
    result.response.projectId !== projectId
  )
    return { _tag: "failed", code: "guest_failed" };
  return { _tag: "posts", posts: result.response.posts };
}
