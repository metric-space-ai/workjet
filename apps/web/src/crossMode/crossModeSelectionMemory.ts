// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * The context-preserving half of the cross-mode switch (docs/workjet-plan.md
 * "Cross-mode workflow bridge", item 4: "context-preserving mode switch").
 *
 * Switching modes tears the outgoing mode's main surface down. Without a
 * memory, coming back lands on that mode's zero state and the user has to find
 * their place again. This store remembers exactly ONE selection per mode — the
 * last place the navigator left it — so a bare `{ mode: "code" }` link, or the
 * header's mode toggle, restores the previous selection instead.
 *
 * Bounded and redaction-clean by construction: what is remembered is a
 * {@link CrossModeTarget}, i.e. addresses only. No record data, no thread
 * content, no titles fetched from either authority. Two slots, no history, no
 * growth.
 */
import {
  decodeCrossModeTarget,
  isAddressedCrossModeTarget,
  normalizeCrossModeTarget,
  type CrossModeMode,
  type CrossModeTarget,
} from "./crossModeTarget";

export const ACTIVE_CTOX_INSTANCE_STORAGE_KEY = "workjet:active-ctox-instance:v1";

interface ActiveCtoxInstanceStorage {
  readonly getItem: (key: string) => string | null;
  readonly removeItem: (key: string) => void;
  readonly setItem: (key: string, value: string) => void;
}

export interface CrossModeSelectionMemoryOptions {
  readonly activeInstanceStorage?: ActiveCtoxInstanceStorage;
  readonly activeInstanceStorageKey?: string;
}

export interface CrossModeSelectionMemory {
  /** The last selection recorded for `mode`, or `null` if there is none. */
  readonly read: (mode: CrossModeMode) => CrossModeTarget | null;
  /**
   * Record a selection. An UNADDRESSED target (a bare mode with no entry) is
   * ignored rather than stored: forgetting where the user was is worse than
   * remembering a slightly stale place, and a bare target carries nothing to
   * restore anyway.
   */
  readonly remember: (target: CrossModeTarget) => void;
  /** Drop a mode's memory — used when its entry is revoked or deleted. */
  readonly forget: (mode: CrossModeMode) => void;
  /** The one persisted instance scope consumed by both product modes. */
  readonly readActiveCtoxInstanceId: () => string | null;
  /**
   * Subscribe to the one active CTOX instance shared by Code and Business OS.
   * Code-side environment/thread scoping binds here once the authoritative
   * instance-to-environment membership snapshot is available; callers must
   * never guess that an instance id is itself an environment id.
   */
  readonly subscribeToActiveCtoxInstance: (listener: () => void) => () => void;
}

function persistedActiveCtoxTarget(
  storage: ActiveCtoxInstanceStorage | undefined,
  storageKey: string,
): CrossModeTarget | null {
  if (storage === undefined) return null;
  try {
    const instanceId = storage.getItem(storageKey);
    if (instanceId === null) return null;
    return decodeCrossModeTarget({ mode: "business-os", ctoxInstanceId: instanceId });
  } catch {
    // Selection persistence is a convenience, never a reason to prevent the
    // renderer from booting (private mode and hardened storage may throw).
    return null;
  }
}

export function createCrossModeSelectionMemory(
  options: CrossModeSelectionMemoryOptions = {},
): CrossModeSelectionMemory {
  const slots = new Map<CrossModeMode, CrossModeTarget>();
  const listeners = new Set<() => void>();
  const storageKey = options.activeInstanceStorageKey ?? ACTIVE_CTOX_INSTANCE_STORAGE_KEY;
  const persisted = persistedActiveCtoxTarget(options.activeInstanceStorage, storageKey);
  if (persisted !== null && isAddressedCrossModeTarget(persisted)) {
    slots.set("business-os", persisted);
  }

  const notifyActiveCtoxInstance = () => {
    for (const listener of listeners) listener();
  };

  const persistActiveCtoxInstance = (instanceId: string | null) => {
    const storage = options.activeInstanceStorage;
    if (storage === undefined) return;
    try {
      if (instanceId === null) storage.removeItem(storageKey);
      else storage.setItem(storageKey, instanceId);
    } catch {
      // Keep the in-memory source of truth working when persistence is denied.
    }
  };

  return {
    read: (mode) => slots.get(mode) ?? null,
    remember: (target) => {
      const normalized = decodeCrossModeTarget(target);
      if (normalized === null) return;
      if (!isAddressedCrossModeTarget(normalized)) return;
      const previous = slots.get(normalized.mode);
      slots.set(normalized.mode, normalized);
      if (normalized.mode === "business-os") {
        const instanceId = normalized.ctoxInstanceId;
        if (instanceId === undefined) return;
        persistActiveCtoxInstance(instanceId);
        if (previous?.ctoxInstanceId !== instanceId) notifyActiveCtoxInstance();
      }
    },
    forget: (mode) => {
      const existed = slots.has(mode);
      slots.delete(mode);
      if (mode === "business-os") {
        persistActiveCtoxInstance(null);
        if (existed) notifyActiveCtoxInstance();
      }
    },
    readActiveCtoxInstanceId: () => slots.get("business-os")?.ctoxInstanceId ?? null,
    subscribeToActiveCtoxInstance: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * The renderer's single memory. Module-level on purpose: the memory has to
 * outlive both mode shells, and each shell is unmounted precisely when the
 * other one is showing.
 */
function rendererSelectionStorage(): ActiveCtoxInstanceStorage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

const activeInstanceStorage = rendererSelectionStorage();
export const crossModeSelectionMemory: CrossModeSelectionMemory =
  activeInstanceStorage === undefined
    ? createCrossModeSelectionMemory()
    : createCrossModeSelectionMemory({ activeInstanceStorage });

export interface CrossModeSelectionResolution {
  readonly target: CrossModeTarget;
  /** True when the remembered selection supplied the entry, not the link. */
  readonly restored: boolean;
}

/**
 * Resolve what to actually select: an addressed link always wins, and a bare
 * link falls back to the remembered selection for its mode.
 */
export function resolveCrossModeSelection(
  target: CrossModeTarget,
  remembered: CrossModeTarget | null,
): CrossModeSelectionResolution {
  const normalized = normalizeCrossModeTarget(target);
  if (isAddressedCrossModeTarget(normalized)) return { target: normalized, restored: false };
  if (remembered === null || remembered.mode !== normalized.mode) {
    return { target: normalized, restored: false };
  }
  return { target: normalizeCrossModeTarget(remembered), restored: true };
}
