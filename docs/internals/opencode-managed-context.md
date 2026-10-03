# OpenCode managed context

Workjet delivers the compiled managed instructions with the first prompt of an
OpenCode session and avoids repeating them on ordinary subsequent prompts.
The OpenCode `session.compacted` event invalidates that delivery marker for its
own session. The next prompt restores the instructions without creating an
additional task or interrupting the native compaction.

Each compaction advances a context epoch. A response to a prompt sent in an
older epoch cannot mark instructions as delivered in the new epoch, and its
cleanup cannot release a newer prompt's in-flight marker.

On session resume Workjet restores instructions even when the persisted cursor
contains a matching fingerprint: the native server may have compacted while
Workjet was disconnected. The native session ID and conversation are retained.
The fingerprint still deduplicates ordinary turns within the active context.

This restores the compiled Workjet prompt. Fetching fresh native Crew memory
requires a separately authorized Crew execution/context contract and is not
provided by this adapter change.
