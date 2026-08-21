// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Workjet-owned component surfaces used by `ChatView`, behind ONE import.
 *
 * Upstream and this fork both edit ChatView's import block, and every Workjet
 * component added there was its own recurring merge hunk (docs/workjet-plan.md
 * §14). Re-exporting through a barrel means adding a Workjet surface changes
 * this file instead of the shared block, and the single import that does exist
 * sorts last among relative imports, where upstream rarely reaches.
 *
 * Nothing but re-exports belongs here — a barrel that grows logic becomes a
 * conflict site of its own.
 */
export { WorkjetHandoffInbox } from "./WorkjetHandoffInbox";
export { WorkjetWorkerOverview } from "./WorkjetWorkerOverview";
