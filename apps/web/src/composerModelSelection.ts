import type { ModelSelection, ScopedThreadRef } from "@workjet/contracts";

/** Track immediate metadata writes so a send or computer move cannot overtake a pick. */
export function createComposerModelSelectionWriter(
  write: (threadRef: ScopedThreadRef, selection: ModelSelection) => Promise<void>,
  onPendingChange: (pending: boolean) => void,
) {
  let pending = 0;
  return {
    isPending: () => pending > 0,
    save: async (threadRef: ScopedThreadRef, selection: ModelSelection) => {
      pending += 1;
      onPendingChange(true);
      try {
        await write(threadRef, selection);
      } finally {
        pending -= 1;
        onPendingChange(pending > 0);
      }
    },
  };
}
