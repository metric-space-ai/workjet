import {
  WorkjetSupervisorThreadId,
  type WorkjetSupervisorTurnIntent,
  type WorkjetSupervisorJournal,
  type WorkjetThreadConfig,
  type WorkjetComputer,
  type ThreadId,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import {
  resolveProjectHistoryBindings,
  type ProjectHistoryIdentity,
} from "./workjetProjectIdentity";
import type { WorkjetProjectRegistrySnapshot } from "./workjetProjectRegistry";

const decodeSupervisorThreadId = Schema.decodeUnknownSync(WorkjetSupervisorThreadId);

export interface NativeSupervisorScope {
  readonly instanceId: string;
  readonly projectId: WorkjetSupervisorTurnIntent["projectId"];
  readonly threadId: string;
}

export function isNativeSupervisorThread(config: WorkjetThreadConfig | null): boolean {
  return config?.schemaVersion === 2 && config.team?.role === "supervisor";
}

/** Only persisted project identities may select the native execution authority. */
export function resolveNativeSupervisorScope(input: {
  readonly config: WorkjetThreadConfig | null;
  readonly project: ProjectHistoryIdentity | null;
  readonly threadId: ThreadId | null;
  readonly instanceId: string | null;
  readonly registry: WorkjetProjectRegistrySnapshot;
  readonly computers: readonly WorkjetComputer[];
}): NativeSupervisorScope | null {
  const { config, project, threadId, instanceId, registry } = input;
  if (
    config?.schemaVersion !== 2 ||
    config.team?.role !== "supervisor" ||
    project === null ||
    threadId === null ||
    instanceId === null ||
    (project.ctoxRegistration != null && project.ctoxRegistration.status !== "confirmed") ||
    config.team.projectId !== project.id ||
    config.team.threadId !== threadId ||
    registry.presentationInstanceId !== instanceId ||
    registry.phase !== "ready" ||
    registry.refreshFailed
  )
    return null;
  const [binding] = resolveProjectHistoryBindings({
    instanceId,
    nativeProjects: registry.projects,
    projects: [project],
    computers: input.computers,
  });
  if (!binding) return null;
  const scope = { instanceId, projectId: binding.nativeProjectId, threadId };
  // Imported titles and Code provider session IDs are never native thread IDs.
  try {
    decodeSupervisorThreadId(threadId);
    return scope;
  } catch {
    return null;
  }
}

/** Names the first unmet condition behind a null scope, for the composer's notice. */
export function nativeSupervisorBlockReason(input: {
  readonly project: ProjectHistoryIdentity | null;
  readonly registry: WorkjetProjectRegistrySnapshot;
}): string {
  if (input.registry.refreshFailed) return "Could not read the CTOX project list.";
  if (input.registry.phase !== "ready") return "The CTOX project list is still loading.";
  const registration = input.project?.ctoxRegistration;
  if (registration != null && registration.status !== "confirmed")
    return "This project is waiting for confirmation from CTOX.";
  return "This project has no confirmed CTOX binding on this computer.";
}

export function supervisorJournalMatchesScope(
  journal: WorkjetSupervisorJournal,
  scope: NativeSupervisorScope,
): boolean {
  return (
    journal.intent.instanceId === scope.instanceId &&
    journal.intent.projectId === scope.projectId &&
    journal.intent.threadId === scope.threadId
  );
}

/** Preserve every unrelated config field; the server mutation must acknowledge the write. */
export async function persistSupervisorJournal(input: {
  readonly config: WorkjetThreadConfig;
  readonly journal: WorkjetSupervisorJournal;
  readonly dispatch: (config: WorkjetThreadConfig) => Promise<{ readonly _tag: string }>;
}): Promise<WorkjetThreadConfig> {
  const { config, journal } = input;
  if (
    config.schemaVersion !== 2 ||
    config.team?.role !== "supervisor" ||
    config.team.threadId !== journal.intent.threadId
  )
    throw new Error("Supervisor identity changed; message not sent.");
  const next = { ...config, ctoxSupervisorTurn: journal };
  const result = await input.dispatch(next);
  if (result._tag !== "Success")
    throw new Error("Could not save the supervisor request; message not sent.");
  return next;
}

export function nativeSupervisorResultText(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2) ?? "";
}

/** A lost receipt is recovered with its saved command; refusals need user action. */
export function canResumeSupervisorJournal(
  journal: WorkjetSupervisorJournal | null,
  failureCode: string | null,
): boolean {
  if (journal === null || journal.submission === "not-submitted" || journal.turn?.terminal)
    return false;
  return failureCode === null || failureCode === "timeout" || failureCode === "not_active";
}
