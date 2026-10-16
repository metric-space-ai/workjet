import type { LiveDoc } from "./ctoxClient";

/** App-API get() may return fresh objects. React requires a stable snapshot until data changes. */
export function createLiveStore<T>(live: LiveDoc<T>) {
  let snapshot = live.get();
  let serialized = JSON.stringify(snapshot);
  const accept = (value: T) => {
    const next = JSON.stringify(value);
    if (next === serialized) return false;
    serialized = next;
    snapshot = value;
    return true;
  };
  return {
    getSnapshot: () => {
      accept(live.get());
      return snapshot;
    },
    subscribe: (listener: () => void) => {
      // Notification cursors belong to subscribers. A prior getSnapshot() or another
      // subscriber must not consume this subscriber's change notification.
      let notified = serialized;
      return live.subscribe((value) => {
        const next = JSON.stringify(value);
        accept(value);
        if (next === notified) return;
        notified = next;
        listener();
      });
    },
  };
}
