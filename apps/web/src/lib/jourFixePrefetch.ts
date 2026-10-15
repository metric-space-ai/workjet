import { ProjectId, type WorkjetJourFixeMeeting } from "@workjet/contracts";
import { prepareJourFixeNarration } from "./jourFixeNarration";
import { readJourFixePresentation } from "./jourFixePresentation";

/** Meetings further away than this are not worth the CTOX round trips yet. */
export const JOUR_FIXE_PREFETCH_WINDOW_MS = 6 * 60 * 60 * 1000;

const inFlight = new Map<string, Promise<void>>();

/**
 * Loads the deck and every slide's narration of an upcoming meeting into the
 * durable cache, one request at a time, so opening the room needs no CTOX
 * round trip. It outlives the view that started it and never throws: a
 * failed slide is simply fetched again when the room needs it.
 */
export function prefetchJourFixeMeeting(
  instanceId: string,
  meeting: WorkjetJourFixeMeeting,
  now: number = Date.now(),
): Promise<void> {
  if (meeting.state !== "ready" && meeting.state !== "live") return Promise.resolve();
  if (Math.abs(meeting.scheduled_at_ms - now) > JOUR_FIXE_PREFETCH_WINDOW_MS)
    return Promise.resolve();
  const key = `${instanceId}:${meeting.id}:${meeting.deck_revision}`;
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = (async () => {
    const projectId = ProjectId.make(meeting.project_id);
    try {
      await readJourFixePresentation(instanceId, projectId, meeting.id);
    } catch {
      // The room retries the deck itself.
    }
    const scope = {
      instanceId,
      projectId: meeting.project_id,
      meetingId: meeting.id,
      deckRevision: meeting.deck_revision,
    };
    for (const slide of [...meeting.slides].sort((a, b) => a.position - b.position)) {
      try {
        await prepareJourFixeNarration({
          scope,
          slideId: slide.id,
          signal: new AbortController().signal,
        });
      } catch {
        // Slides without retained narration or a failed range stay uncached.
      }
    }
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}
