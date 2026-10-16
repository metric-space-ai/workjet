import type { CommandId } from "@workjet/contracts";
import { newCommandId } from "./utils";

/**
 * What the previous attempt under a command id ended with.
 *
 * - `null`: nothing settled yet (never sent, still open, remount).
 * - `"lost"`: the request threw before a typed answer arrived (transport/IPC).
 * - a project-control result, or any failure shaped like one.
 */
export type CommandAttemptOutcome =
  | null
  | "lost"
  | { readonly _tag: "completed" }
  | {
      readonly _tag: "failed";
      readonly code: string;
      readonly diagnostic?: { readonly reason: string } | undefined;
      readonly preparation?: unknown;
      readonly discovery?: unknown;
    };

// The core never answered, or its answer did not reach us.
const LOST_RECEIPT_CODES = new Set(["timeout", "not_active", "launch_failed"]);
const LOST_RECEIPT_REASONS = new Set([
  "peer_unavailable",
  "request_timeout",
  "network_unavailable",
  "owner_session_not_ready",
  "project_control_not_ready",
  "supervisor_control_not_ready",
]);

/**
 * True when the previous attempt has no final answer we know of. Resending the
 * same command id then asks the core for exactly that attempt's result, which
 * is what we want (CTOX v4 treats `commandId` as its idempotency key).
 */
export function isCommandReceiptUncertain(outcome: CommandAttemptOutcome): boolean {
  if (outcome === null || outcome === "lost") return true;
  if (outcome._tag === "completed") return false;
  if (LOST_RECEIPT_CODES.has(outcome.code)) return true;
  // Guest preparation (shell rebuild) and discovery fail before the core sees the command.
  if (outcome.preparation !== undefined || outcome.discovery !== undefined) return true;
  return outcome.diagnostic !== undefined && LOST_RECEIPT_REASONS.has(outcome.diagnostic.reason);
}

/**
 * The command id for the next attempt: the previous one while its receipt is
 * lost or unclear, a fresh one as soon as the previous attempt ended with a
 * final answer (completed, rejected, conflict, any core failure code). A final
 * answer is replayed verbatim for a reused id, so a retry must not reuse it.
 */
export function nextAttemptId(
  previous: CommandId | null | undefined,
  outcome: CommandAttemptOutcome,
  fresh: () => CommandId = newCommandId,
): CommandId {
  return previous != null && isCommandReceiptUncertain(outcome) ? previous : fresh();
}

/**
 * Attempts per logical operation (one key per scope/intent) for callers that
 * retry from UI state: begin() picks the id, settle() records how it ended.
 */
export function createCommandAttempts() {
  const attempts = new Map<string, { commandId: CommandId; outcome: CommandAttemptOutcome }>();
  return {
    begin(key: string, fresh: () => CommandId = newCommandId): CommandId {
      const previous = attempts.get(key);
      const commandId = nextAttemptId(previous?.commandId, previous?.outcome ?? null, fresh);
      attempts.set(key, { commandId, outcome: null });
      return commandId;
    },
    settle(key: string, commandId: CommandId, outcome: CommandAttemptOutcome): void {
      const current = attempts.get(key);
      if (current?.commandId === commandId) current.outcome = outcome;
    },
    has(key: string): boolean {
      return attempts.has(key);
    },
    clear(): void {
      attempts.clear();
    },
  };
}
export type CommandAttempts = ReturnType<typeof createCommandAttempts>;
