import {
  normalizeWorkjetThreadConfig,
  type WorkjetConnectionSummary,
  type WorkjetThreadConfig,
} from "./workjet.ts";
import type { WorkjetSupervisorJournal } from "./workjetSupervisor.ts";
import * as Schema from "effect/Schema";

const GrantUuid = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i),
);
const decodeGrantUuid = Schema.decodeUnknownOption(GrantUuid);

/** Same identity grammar as the desktop worker-source grant issuer. */
export function ctoxWorkerSourceTenantId(connectionId: string): string | undefined {
  const match = /^ctox-dev-worker-source:([^:]+):([^:]+)$/.exec(connectionId);
  if (!match) return undefined;
  const tenant = decodeGrantUuid(match[1]);
  const token = decodeGrantUuid(match[2]);
  return tenant._tag === "Some" && token._tag === "Some" ? tenant.value : undefined;
}

export function isWorkjetCtoxCredentialRotation(
  previous: { readonly connectionId: string; readonly instanceId?: string },
  next: { readonly connectionId: string; readonly instanceId?: string },
): boolean {
  const tenantId = ctoxWorkerSourceTenantId(previous.connectionId);
  // Tokens identify credentials, not authority. Only ctox.dev worker-source
  // grants for the same tenant AND immutable native instance may rotate;
  // local connections, foreign tenants and instance retargeting remain forbidden.
  return (
    tenantId !== undefined &&
    tenantId === ctoxWorkerSourceTenantId(next.connectionId) &&
    previous.instanceId !== undefined &&
    previous.instanceId === next.instanceId
  );
}

export function workjetCtoxWorkerSourceSuccessor(
  connections: readonly WorkjetConnectionSummary[],
  target: { readonly connectionId: string; readonly instanceId?: string },
): { readonly connection?: WorkjetConnectionSummary; readonly error: string | null } {
  const original = connections.find((entry) => entry.connectionId === target.connectionId);
  if (
    !original ||
    original.source !== "ctox_dev" ||
    original.status === "ready" ||
    original.instanceId !== target.instanceId ||
    !ctoxWorkerSourceTenantId(original.connectionId)
  )
    return { error: null };
  const candidates = connections.filter(
    (entry) =>
      entry.source === "ctox_dev" &&
      entry.status === "ready" &&
      isWorkjetCtoxCredentialRotation(target, entry),
  );
  if (candidates.length > 1)
    return {
      error:
        "Multiple authorized worker connections match this instance. Remove the unused connection in Settings before reconnecting.",
    };
  return candidates[0] ? { connection: candidates[0], error: null } : { error: null };
}

/** Rotate only credential references, retaining disabled tools, journals and receipts. */
export function rotateWorkjetCtoxWorkerSource(
  config: WorkjetThreadConfig,
  connections: readonly WorkjetConnectionSummary[],
): {
  readonly config: WorkjetThreadConfig;
  readonly changed: boolean;
  readonly error: string | null;
} {
  const normalized = normalizeWorkjetThreadConfig(config);
  let changed = false;
  let error: string | null = null;
  const capabilityBindings = normalized.capabilityBindings.map((binding) => {
    if (binding.capabilityId !== "ctox-business-os") return binding;
    const result = workjetCtoxWorkerSourceSuccessor(connections, binding.target);
    error ??= result.error;
    if (!result.connection) return binding;
    changed = true;
    return {
      ...binding,
      target: { ...binding.target, connectionId: result.connection.connectionId },
    };
  });
  let ctoxCrewChat = normalized.ctoxCrewChat;
  if (ctoxCrewChat) {
    const result = workjetCtoxWorkerSourceSuccessor(connections, ctoxCrewChat);
    error ??= result.error;
    if (result.connection) {
      changed = true;
      ctoxCrewChat = { ...ctoxCrewChat, connectionId: result.connection.connectionId };
    }
  }
  if (error || !changed) return { config, changed: false, error };
  const retained = retainWorkjetCtoxBinding(config, {
    ...normalized,
    capabilityBindings,
    ...(ctoxCrewChat ? { ctoxCrewChat } : {}),
  });
  return { ...retained, changed: retained.error === null };
}

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
  for (const input of previous.inputs ?? []) {
    const retained = next.inputs?.find(
      (entry) => entry.intent.commandId === input.intent.commandId,
    );
    if (
      !retained ||
      JSON.stringify(retained.intent) !== JSON.stringify(input.intent) ||
      (input.submission === "awaiting-receipt" && retained.submission === "prepared") ||
      (input.receipt !== null && JSON.stringify(retained.receipt) !== JSON.stringify(input.receipt))
    )
      return "A Supervisor context retry must keep its saved identity and receipt.";
  }
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
      (originalChat.connectionId !== requestedChat.connectionId &&
        !isWorkjetCtoxCredentialRotation(originalChat, requestedChat)) ||
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
    ((original.target.connectionId !== binding.target.connectionId &&
      !isWorkjetCtoxCredentialRotation(original.target, binding.target)) ||
      original.target.instanceId !== binding.target.instanceId)
  ) {
    return {
      config: next,
      error:
        "This thread keeps its original CTOX instance and tenant. Select a worker connection for that instance.",
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
