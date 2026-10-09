import { normalizeWorkjetThreadConfig, type WorkjetThreadConfig } from "./workjet.ts";
import type { WorkjetSupervisorJournal } from "./workjetSupervisor.ts";

function supervisorObservationError(
  previous: WorkjetSupervisorJournal,
  next: WorkjetSupervisorJournal,
): string | null {
  const a = previous.intent;
  const b = next.intent;
  if (a.instanceId !== b.instanceId || a.projectId !== b.projectId || a.threadId !== b.threadId)
    return "This thread keeps its original native supervisor binding.";
  if (
    a.commandId !== b.commandId ||
    a.goal !== b.goal ||
    a.createdAt !== b.createdAt ||
    (a.turnKind ?? "work") !== (b.turnKind ?? "work")
  )
    return "A native supervisor retry must keep its saved command and payload.";
  if (
    (previous.submission === "awaiting-receipt" &&
      next.submission !== "awaiting-receipt" &&
      next.submission !== "confirmed") ||
    (previous.submission === "confirmed" && next.submission !== "confirmed")
  )
    return "A native supervisor submission cannot erase its dispatch or receipt.";
  if (
    previous.turn &&
    next.turn &&
    (previous.turn.commandId !== next.turn.commandId ||
      (previous.turn.taskId !== null && previous.turn.taskId !== next.turn.taskId) ||
      previous.turn.attempt > next.turn.attempt)
  )
    return "Native supervisor observation must retain its task and execution identity.";
  return null;
}

/** Disabling tools revokes access, but does not erase a thread's instance identity. */
export function retainWorkjetCtoxBinding(
  previous: WorkjetThreadConfig,
  next: WorkjetThreadConfig,
): { readonly config: WorkjetThreadConfig; readonly error: string | null } {
  const before = normalizeWorkjetThreadConfig(previous);
  const after = normalizeWorkjetThreadConfig(next);
  const previousSupervisor = before.ctoxSupervisorTurn;
  const nextSupervisor = after.ctoxSupervisorTurn;
  if (previousSupervisor && nextSupervisor) {
    const a = previousSupervisor.intent;
    const b = nextSupervisor.intent;
    const unchangedPrevious = after.ctoxSupervisorPreviousTurns?.some(
      (entry) => JSON.stringify(entry) === JSON.stringify(previousSupervisor),
    );
    if (a.commandId !== b.commandId) {
      if (a.instanceId !== b.instanceId || a.projectId !== b.projectId || a.threadId !== b.threadId)
        return { config: next, error: "This thread keeps its original native supervisor binding." };
      if (
        previousSupervisor.submission !== "not-submitted" &&
        !previousSupervisor.turn?.terminal &&
        !(previousSupervisor.submission === "confirmed" && unchangedPrevious)
      )
        return {
          config: next,
          error:
            "The existing native supervisor submission is still unresolved. Resume that saved command before starting another turn.",
        };
    } else {
      const error = supervisorObservationError(previousSupervisor, nextSupervisor);
      if (error) return { config: next, error };
    }
  }
  const previousTurns = before.ctoxSupervisorPreviousTurns ?? [];
  const requestedTurns = after.ctoxSupervisorPreviousTurns ?? previousTurns;
  const seen = new Set<string>();
  for (const entry of requestedTurns) {
    if (
      seen.has(entry.intent.commandId) ||
      entry.intent.commandId === nextSupervisor?.intent.commandId
    )
      return { config: next, error: "Supervisor task history contains a duplicate command." };
    seen.add(entry.intent.commandId);
    if (
      nextSupervisor &&
      (entry.intent.instanceId !== nextSupervisor.intent.instanceId ||
        entry.intent.projectId !== nextSupervisor.intent.projectId ||
        entry.intent.threadId !== nextSupervisor.intent.threadId)
    )
      return { config: next, error: "Supervisor task history belongs to another project." };
    const previous =
      previousTurns.find((item) => item.intent.commandId === entry.intent.commandId) ??
      (previousSupervisor?.intent.commandId === entry.intent.commandId ? previousSupervisor : null);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(entry))
      return {
        config: next,
        error: "Keep the original Supervisor receipt when retaining a previous task.",
      };
  }
  for (const entry of previousTurns) {
    const observed =
      nextSupervisor?.intent.commandId === entry.intent.commandId
        ? nextSupervisor
        : requestedTurns.find((item) => item.intent.commandId === entry.intent.commandId);
    if (!observed && entry.submission !== "not-submitted" && !entry.turn?.terminal)
      return { config: next, error: "An active Supervisor task cannot be removed from history." };
    if (observed) {
      const error = supervisorObservationError(entry, observed);
      if (error) return { config: next, error };
    }
  }
  const original = before.capabilityBindings.find(
    (binding) => binding.capabilityId === "ctox-business-os",
  );
  const requested = after.capabilityBindings.filter(
    (binding) => binding.capabilityId === "ctox-business-os",
  );
  const binding = requested[0];
  const originalChat = before.ctoxCrewChat;
  const requestedChat = after.ctoxCrewChat;
  if (
    originalChat &&
    requestedChat &&
    (originalChat.instanceId !== requestedChat.instanceId ||
      originalChat.connectionId !== requestedChat.connectionId ||
      originalChat.chatId !== requestedChat.chatId)
  ) {
    return {
      config: next,
      error:
        "This thread keeps its original private CTOX chat. Start a new thread for another chat.",
    };
  }
  if (requested.length > 1 || (binding && !binding.target.instanceId)) {
    return { config: next, error: "CTOX Business OS requires one explicit instance binding." };
  }
  if (
    original &&
    binding &&
    (original.target.connectionId !== binding.target.connectionId ||
      original.target.instanceId !== binding.target.instanceId)
  ) {
    return {
      config: next,
      error:
        "This thread keeps its original CTOX instance. Start a new thread to use another connection.",
    };
  }
  const instanceId = original?.target.instanceId ?? binding?.target.instanceId;
  if (
    instanceId &&
    ((before.ctoxSession && before.ctoxSession.instanceId !== instanceId) ||
      (after.ctoxSession && after.ctoxSession.instanceId !== instanceId))
  ) {
    return {
      config: next,
      error: "The CTOX tool binding must match the thread's registered instance.",
    };
  }
  // A replace-all config update may omit the chat while changing unrelated
  // settings. Preserve the first private-chat identity just like the native
  // instance binding, so a later command cannot erase or retarget it.
  const retainedChat =
    originalChat && !requestedChat ? { ...after, ctoxCrewChat: originalChat } : next;
  const retainedHistory = requestedTurns.length
    ? { ...normalizeWorkjetThreadConfig(retainedChat), ctoxSupervisorPreviousTurns: requestedTurns }
    : retainedChat;
  const retainedSupervisor =
    previousSupervisor && !nextSupervisor
      ? { ...normalizeWorkjetThreadConfig(retainedHistory), ctoxSupervisorTurn: previousSupervisor }
      : retainedHistory;
  return {
    config:
      original && !binding
        ? {
            ...normalizeWorkjetThreadConfig(retainedSupervisor),
            capabilityBindings: [...after.capabilityBindings, original],
          }
        : retainedSupervisor,
    error: null,
  };
}
