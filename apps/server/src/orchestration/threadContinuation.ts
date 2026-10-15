import type { MessageId } from "@workjet/contracts";

type TranscriptMessage = {
  readonly id: MessageId;
  readonly role: string;
  readonly text: string;
  readonly streaming?: boolean;
};

/** Switching back may append to a common transcript, but may never overwrite a divergent branch. */
export function continuationPrefixIssue(
  existing: ReadonlyArray<TranscriptMessage>,
  incoming: ReadonlyArray<TranscriptMessage>,
): string | null {
  if (new Set(incoming.map((message) => message.id)).size !== incoming.length)
    return "The source transcript contains duplicate message identities. No history was copied.";
  if (existing.length > incoming.length)
    return "This computer has newer conversation history. Open its thread before switching; no history was overwritten.";
  for (const [index, message] of existing.entries()) {
    const source = incoming[index];
    if (
      message.streaming ||
      message.id !== source?.id ||
      message.role !== source.role ||
      message.text !== source.text
    )
      return "The computers have conflicting conversation history. Keep both threads for review; no history was overwritten.";
  }
  return null;
}
