import { useEffect, useState } from "react";

/** A calendar load that has not answered within this time ends in "Nicht geladen" + retry. */
export const CALENDAR_LOAD_TIMEOUT_MS = 10_000;

/** Calls `onExpire` once when the load is still running after the timeout; returns the cancel. */
export function startCalendarLoadDeadline(
  onExpire: () => void,
  timeoutMs: number = CALENDAR_LOAD_TIMEOUT_MS,
): () => void {
  const timer = setTimeout(onExpire, timeoutMs);
  return () => clearTimeout(timer);
}

export type CalendarLoadState = "loading" | "ready" | "failed";

/** A load always ends (UI-Vertrag §1): a timeout counts as a failure the user can retry. */
export function calendarLoadState(input: {
  readonly loading: boolean;
  readonly timedOut: boolean;
  readonly failed: boolean;
}): CalendarLoadState {
  if (input.failed || (input.loading && input.timedOut)) return "failed";
  return input.loading ? "loading" : "ready";
}

/**
 * Tracks the deadline of the current load attempt. `retry` starts a new
 * attempt, which gets its own full timeout.
 */
export function useCalendarLoad(loading: boolean, failed: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [timedOutAttempt, setTimedOutAttempt] = useState<number | null>(null);
  useEffect(() => {
    if (!loading) return;
    return startCalendarLoadDeadline(() => setTimedOutAttempt(attempt));
  }, [loading, attempt]);
  return {
    state: calendarLoadState({ loading, timedOut: timedOutAttempt === attempt, failed }),
    retry: () => setAttempt((previous) => previous + 1),
  };
}
