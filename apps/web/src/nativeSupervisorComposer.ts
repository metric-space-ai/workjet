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
import { describeWorkjetProjectControlFailure } from "./workjetProjectControl";

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
  if (input.registry.refreshFailed)
    return input.registry.refreshError
      ? describeWorkjetProjectControlFailure(
          input.registry.refreshError,
          input.registry.presentationInstanceId,
        )
      : "Could not read the CTOX project list.";
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
  const previous = config.ctoxSupervisorTurn;
  const previousTurns = [...(config.ctoxSupervisorPreviousTurns ?? [])].filter(
    (entry) => entry.intent.commandId !== journal.intent.commandId,
  );
  if (previous && previous.intent.commandId !== journal.intent.commandId) {
    if (canResumeSupervisorJournal(previous, null) && previous.submission !== "confirmed")
      throw new Error("Wait for the previous CTOX receipt before sending another message.");
    const index = previousTurns.findIndex(
      (entry) => entry.intent.commandId === previous.intent.commandId,
    );
    if (index < 0) previousTurns.push(previous);
    else previousTurns[index] = previous;
  }
  const active = previousTurns.filter((entry) => canResumeSupervisorJournal(entry, null));
  if (active.length > 64)
    throw new Error(
      "Too many active requests. Finish or cancel a task before sending another message.",
    );
  const settled = previousTurns.filter((entry) => !canResumeSupervisorJournal(entry, null));
  const available = 64 - active.length;
  const retained = [...(available > 0 ? settled.slice(-available) : []), ...active];
  const next = {
    ...config,
    ...(retained.length || config.ctoxSupervisorPreviousTurns
      ? { ctoxSupervisorPreviousTurns: retained }
      : {}),
    ctoxSupervisorTurn: journal,
  };
  const result = await input.dispatch(next);
  if (result._tag !== "Success")
    throw new Error("Could not save the supervisor request; message not sent.");
  return next;
}

/** Display the public reply of a result correlated to the persisted native turn. */
export function nativeSupervisorResultText(
  result: unknown,
  expected?: {
    readonly commandId: string;
    readonly taskId: string | null;
    readonly attempt: number;
  },
): string {
  if (result === null || result === undefined) return "";
  let envelope: unknown = result;
  if (typeof result === "string") {
    try {
      envelope = JSON.parse(result);
    } catch {
      return result;
    }
  }
  if (expected && envelope && typeof envelope === "object" && !Array.isArray(envelope)) {
    const value = envelope as Record<string, unknown>;
    if (
      typeof value.command_id === "string" &&
      typeof value.execution_task_id === "string" &&
      typeof value.attempt === "number" &&
      typeof value.user_reply === "string"
    ) {
      if (
        value.command_id !== expected.commandId ||
        value.execution_task_id !== expected.taskId ||
        value.attempt !== expected.attempt
      )
        return "The result belongs to a different Supervisor turn.";
      // Older native chat tools place their public reply in a serialized chat result.
      // Only unwrap that known envelope after both the turn and chat IDs match.
      try {
        const chat: unknown = JSON.parse(value.user_reply);
        if (
          chat &&
          typeof chat === "object" &&
          !Array.isArray(chat) &&
          (chat as Record<string, unknown>).chat_id === `chat_${expected.commandId}` &&
          typeof (chat as Record<string, unknown>).outbound_text === "string"
        )
          return (chat as Record<string, unknown>).outbound_text as string;
      } catch {
        // Ordinary Markdown remains unchanged.
      }
      return value.user_reply;
    }
  }
  return typeof result === "string" ? result : (JSON.stringify(result, null, 2) ?? "");
}

/** A lost receipt is recovered with its saved command; refusals need user action. */
export function canResumeSupervisorJournal(
  journal: WorkjetSupervisorJournal | null,
  failureCode: string | null,
): boolean {
  if (journal === null || journal.turn?.terminal) return false;
  if (
    journal.submission === "not-submitted" &&
    journal.submissionError !== "not_active" &&
    journal.submissionError !== "timeout"
  )
    return false;
  return failureCode === null || failureCode === "timeout" || failureCode === "not_active";
}
