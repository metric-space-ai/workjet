import type {
  WorkjetSupervisorExecutionEvent,
  WorkjetSupervisorPublicAssistantText,
} from "@workjet/contracts";

export interface SupervisorPublicReply {
  id: string;
  turnId: string;
  itemId: string;
  phase: WorkjetSupervisorPublicAssistantText["phase"];
  text: string;
  completed: boolean;
  truncated: boolean;
  incomplete: boolean;
}

/** Preserve conflicting retained events so reconstruction can report a gap honestly. */
export function appendSupervisorExecutionEvents(
  previous: readonly WorkjetSupervisorExecutionEvent[],
  incoming: readonly WorkjetSupervisorExecutionEvent[],
): { events: readonly WorkjetSupervisorExecutionEvent[]; limited: boolean; conflicted: boolean } {
  const events = [...previous];
  const fingerprints = new Map(previous.map((event) => [event.id, JSON.stringify(event)]));
  let conflicted = false;
  for (const event of incoming) {
    const fingerprint = JSON.stringify(event);
    const known = fingerprints.get(event.id);
    if (known === fingerprint) continue;
    if (events.length >= 4096) return { events, limited: true, conflicted };
    if (known !== undefined) conflicted = true;
    events.push(event);
    fingerprints.set(event.id, fingerprint);
  }
  return { events, limited: false, conflicted };
}

/** Rebuild only contiguous, persisted public chunks from the selected native attempt. */
export function reconstructSupervisorPublicReplies(
  attemptId: string,
  events: readonly WorkjetSupervisorExecutionEvent[],
): SupervisorPublicReply[] {
  const replies = new Map<string, { reply: SupervisorPublicReply; chars: string[] }>();
  const seen = new Map<string, string>();
  const turnSizes = new Map<string, number>();
  for (const event of events) {
    const chunk = event.public_text;
    if (event.kind !== "worker.assistant_text" || !chunk) continue;
    const id = JSON.stringify([attemptId, chunk.turn_id, chunk.item_id]);
    let entry = replies.get(id);
    if (!entry) {
      if (replies.size >= 256) break;
      entry = {
        reply: {
          id,
          turnId: chunk.turn_id,
          itemId: chunk.item_id,
          phase: chunk.phase,
          text: "",
          completed: false,
          truncated: false,
          incomplete: false,
        },
        chars: [],
      };
      replies.set(id, entry);
    }
    const fingerprint = JSON.stringify(chunk);
    const previous = seen.get(event.id);
    if (previous !== undefined) {
      if (previous !== fingerprint) entry.reply.incomplete = true;
      continue;
    }
    seen.set(event.id, fingerprint);
    if (entry.reply.incomplete) continue;
    const chars = Array.from(chunk.text);
    const overlap = entry.chars.length - chunk.offset;
    if (
      chunk.phase !== entry.reply.phase ||
      overlap < 0 ||
      ((chunk.completed || chunk.truncated) && chunk.offset + chars.length < entry.chars.length) ||
      chars
        .slice(0, Math.max(0, overlap))
        .some((char, index) => entry.chars[chunk.offset + index] !== char) ||
      (entry.reply.completed && (chars.length > overlap || !chunk.completed))
    ) {
      entry.reply.incomplete = true;
      continue;
    }
    const tail = chars.slice(Math.max(0, overlap));
    const turnSize = turnSizes.get(chunk.turn_id) ?? 0;
    if (entry.chars.length + tail.length > 65536 || turnSize + tail.length > 262144) {
      entry.reply.incomplete = true;
      continue;
    }
    entry.chars.push(...tail);
    turnSizes.set(chunk.turn_id, turnSize + tail.length);
    entry.reply.completed ||= chunk.completed;
    entry.reply.truncated ||= chunk.truncated;
  }
  return Array.from(replies.values(), ({ reply, chars }) => ({ ...reply, text: chars.join("") }));
}
