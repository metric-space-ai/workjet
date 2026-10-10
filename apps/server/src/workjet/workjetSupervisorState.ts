import {
  type WorkjetSupervisorJournal,
  type ThreadId,
  type WorkjetThreadConfig,
} from "@workjet/contracts";

const belongsToThread = (journal: WorkjetSupervisorJournal, threadId: ThreadId) =>
  journal.intent.threadId === threadId &&
  (journal.turn === null || journal.turn.threadId === threadId);

/** Older clients may copy a parent's journals while creating a child. */
export function withoutForeignSupervisorStateAtCreation(
  config: WorkjetThreadConfig,
  threadId: ThreadId,
): WorkjetThreadConfig {
  if (config.schemaVersion !== 2) return config;
  const foreignCurrent =
    config.ctoxSupervisorTurn !== undefined &&
    !belongsToThread(config.ctoxSupervisorTurn, threadId);
  const history = config.ctoxSupervisorPreviousTurns?.filter((entry) =>
    belongsToThread(entry, threadId),
  );
  if (!foreignCurrent && history?.length === config.ctoxSupervisorPreviousTurns?.length)
    return config;
  const clean = { ...config };
  if (foreignCurrent) delete clean.ctoxSupervisorTurn;
  if (history?.length) clean.ctoxSupervisorPreviousTurns = history;
  else delete clean.ctoxSupervisorPreviousTurns;
  return clean;
}
