// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * The renderer's bounded holding area for cross-mode notifications.
 *
 * It exists because notifications outlive the surface that shows them: a
 * Business OS approval raised while Code mode is showing must still be there
 * when the user looks, and the mode shells are unmounted precisely when the
 * other one is active. Module-level, capped, and address-only — the same
 * redaction rules as `crossModeNotification.ts`, which is the only thing that
 * can build an entry.
 *
 * `settled` is tracked separately from emptiness so the pending-approval
 * indicator can tell "the authority answered and there is nothing" apart from
 * "nobody has answered yet". Both render, and they render differently.
 */
import {
  decodeCrossModeNotificationEvent,
  toCrossModeNotification,
  type CrossModeNotification,
} from "./crossModeNotification";

/** Beyond this many, the oldest entries are dropped. */
export const CROSS_MODE_NOTIFICATION_LIMIT = 50;

export interface CrossModeNotificationSnapshot {
  /** True once an authority has reported, even if it reported nothing. */
  readonly settled: boolean;
  /** Newest first. */
  readonly notifications: readonly CrossModeNotification[];
}

export interface CrossModeNotificationStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => CrossModeNotificationSnapshot;
  /**
   * Accept one untrusted event. Returns the built notification, or `null` when
   * the value is not a bounded cross-mode event. Marks the store settled.
   */
  readonly publish: (rawEvent: unknown) => CrossModeNotification | null;
  /** Record that an authority answered with nothing to report. */
  readonly settle: () => void;
  readonly dismiss: (notificationId: string) => void;
  readonly reset: () => void;
}

const EMPTY: CrossModeNotificationSnapshot = { settled: false, notifications: [] };

export function createCrossModeNotificationStore(): CrossModeNotificationStore {
  let snapshot: CrossModeNotificationSnapshot = EMPTY;
  const listeners = new Set<() => void>();

  const commit = (next: CrossModeNotificationSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    publish: (rawEvent) => {
      const event = decodeCrossModeNotificationEvent(rawEvent);
      if (event === null) return null;
      const notification = toCrossModeNotification(event);
      const withoutDuplicate = snapshot.notifications.filter(
        (existing) => existing.notificationId !== notification.notificationId,
      );
      commit({
        settled: true,
        notifications: [notification, ...withoutDuplicate].slice(0, CROSS_MODE_NOTIFICATION_LIMIT),
      });
      return notification;
    },
    settle: () => {
      if (snapshot.settled) return;
      commit({ ...snapshot, settled: true });
    },
    dismiss: (notificationId) => {
      const next = snapshot.notifications.filter(
        (existing) => existing.notificationId !== notificationId,
      );
      if (next.length === snapshot.notifications.length) return;
      commit({ ...snapshot, notifications: next });
    },
    reset: () => {
      commit(EMPTY);
    },
  };
}

/** The renderer's single store. Outlives both mode shells, like the memory. */
export const crossModeNotificationStore: CrossModeNotificationStore =
  createCrossModeNotificationStore();
