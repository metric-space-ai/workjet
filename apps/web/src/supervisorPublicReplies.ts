import type {
  WorkjetSupervisorExecutionEvent,
  WorkjetSupervisorPublicAssistantText,
  WorkjetSupervisorNativeMessageText,
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

export interface SupervisorNativeMessageReply {
  id: string;
  source: "provider-message";
  executionKey: string;
  modelOperationId: string;
  nativeMessageId: string;
  model: string;
  upstreamRequestId: string;
  phase: "assistant";
  text: string;
  completed: boolean;
  truncated: false;
  incomplete: boolean;
}
export type SupervisorReply = SupervisorPublicReply | SupervisorNativeMessageReply;

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

const nativeReplyId = (attemptId: string, chunk: WorkjetSupervisorNativeMessageText) =>
  JSON.stringify([
    "provider-message",
    attemptId,
    chunk.execution_key,
    chunk.model_operation_id,
    chunk.native_message_id,
  ]);

/** Native upstream message identities stay separate from SDK/provider turn and item IDs.
 * Message completion is not Supervisor task, SDK query or goal completion. */
export function reconstructSupervisorNativeMessageReplies(
  attemptId: string,
  events: readonly WorkjetSupervisorExecutionEvent[],
): SupervisorNativeMessageReply[] {
  const replies = new Map<string, { reply: SupervisorNativeMessageReply; chars: string[] }>();
  const seen = new Map<string, { fingerprint: string; reply: SupervisorNativeMessageReply }>();
  const executionSizes = new Map<string, number>();
  for (const event of events) {
    const chunk = event.native_message_text;
    if (event.kind !== "worker.native_message_text" || !chunk) continue;
    const id = nativeReplyId(attemptId, chunk);
    let entry = replies.get(id);
    if (!entry) {
      if (replies.size >= 256) break;
      entry = {
        reply: {
          id,
          source: "provider-message",
          executionKey: chunk.execution_key,
          modelOperationId: chunk.model_operation_id,
          nativeMessageId: chunk.native_message_id,
          model: chunk.model,
          upstreamRequestId: chunk.upstream_request_id,
          phase: "assistant",
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
      if (previous.fingerprint !== fingerprint) {
        previous.reply.incomplete = true;
        entry.reply.incomplete = true;
      }
      continue;
    }
    seen.set(event.id, { fingerprint, reply: entry.reply });
    if (entry.reply.incomplete) continue;
    const chars = Array.from(chunk.text);
    const overlap = entry.chars.length - chunk.offset;
    if (
      entry.reply.model !== chunk.model ||
      entry.reply.upstreamRequestId !== chunk.upstream_request_id ||
      overlap < 0 ||
      (chunk.completed && chunk.offset + chars.length < entry.chars.length) ||
      chars
        .slice(0, Math.max(0, overlap))
        .some((char, index) => entry.chars[chunk.offset + index] !== char) ||
      (entry.reply.completed && (chars.length > overlap || !chunk.completed))
    ) {
      entry.reply.incomplete = true;
      continue;
    }
    const tail = chars.slice(Math.max(0, overlap));
    const executionSize = executionSizes.get(chunk.execution_key) ?? 0;
    if (entry.chars.length + tail.length > 65536 || executionSize + tail.length > 262144) {
      entry.reply.incomplete = true;
      continue;
    }
    entry.chars.push(...tail);
    executionSizes.set(chunk.execution_key, executionSize + tail.length);
    entry.reply.completed ||= chunk.completed;
  }
  return Array.from(replies.values(), ({ reply, chars }) => ({ ...reply, text: chars.join("") }));
}

export function reconstructSupervisorReplies(
  attemptId: string,
  events: readonly WorkjetSupervisorExecutionEvent[],
): SupervisorReply[] {
  const firstEvent = new Map<string, number>();
  for (const [index, event] of events.entries()) {
    const id = event.native_message_text
      ? nativeReplyId(attemptId, event.native_message_text)
      : event.public_text
        ? JSON.stringify([attemptId, event.public_text.turn_id, event.public_text.item_id])
        : undefined;
    if (id !== undefined && !firstEvent.has(id)) firstEvent.set(id, index);
  }
  return [
    ...reconstructSupervisorPublicReplies(attemptId, events),
    ...reconstructSupervisorNativeMessageReplies(attemptId, events),
  ].sort((left, right) => (firstEvent.get(left.id) ?? 0) - (firstEvent.get(right.id) ?? 0));
}
