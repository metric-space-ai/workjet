import { useSyncExternalStore } from "react";

import { crossModeSelectionMemory } from "./crossMode/crossModeSelectionMemory";
import { randomUUID } from "./lib/utils";
import type { WorkjetProductMode } from "./workjetProductMode";

export interface ActiveWorkjetScopeSnapshot {
  readonly mode: WorkjetProductMode;
  readonly selectedInstanceId: string | null;
  /** Monotone selection generation used by native hosts to reject stale work. */
  readonly selectionRevision: number;
}

let snapshot: ActiveWorkjetScopeSnapshot = {
  mode: "code",
  selectedInstanceId: crossModeSelectionMemory.readActiveCtoxInstanceId(),
  selectionRevision: 0,
};
const listeners = new Set<() => void>();
const hostContextListeners = new Set<() => void>();

function publish(next: ActiveWorkjetScopeSnapshot): void {
  if (
    next.mode === snapshot.mode &&
    next.selectedInstanceId === snapshot.selectedInstanceId &&
    next.selectionRevision === snapshot.selectionRevision
  )
    return;
  snapshot = next;
  for (const listener of listeners) listener();
}

export function readActiveWorkjetScope(): ActiveWorkjetScopeSnapshot {
  return snapshot;
}

export function subscribeActiveWorkjetScope(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Notify discovery consumers after a native host installed a newer context. */
export function notifyActiveWorkjetHostContextChanged(): void {
  for (const listener of hostContextListeners) listener();
}

export function subscribeActiveWorkjetHostContext(listener: () => void): () => void {
  hostContextListeners.add(listener);
  return () => hostContextListeners.delete(listener);
}

export function useActiveWorkjetScope(): ActiveWorkjetScopeSnapshot {
  return useSyncExternalStore(
    subscribeActiveWorkjetScope,
    readActiveWorkjetScope,
    readActiveWorkjetScope,
  );
}

export function synchronizeActiveWorkjetMode(mode: WorkjetProductMode): void {
  publish({ ...snapshot, mode });
}

/**
 * Desktop selection commits are immediate because Desktop Main and the Web
 * shell share one process authority. The old selection memory is now only a
 * persistence adapter; consumers must subscribe to this store instead.
 */
export function commitActiveWorkjetSelection(selectedInstanceId: string | null): number {
  const normalized = selectedInstanceId?.trim() || null;
  if (normalized === snapshot.selectedInstanceId) return snapshot.selectionRevision;
  const selectionRevision = snapshot.selectionRevision + 1;
  if (normalized === null) crossModeSelectionMemory.forget("business-os");
  else
    crossModeSelectionMemory.remember({
      mode: "business-os",
      ctoxInstanceId: normalized,
    });
  publish({ ...snapshot, selectedInstanceId: normalized, selectionRevision });
  return selectionRevision;
}

export interface ActiveWorkjetHostSelectionAck {
  readonly requestId: string;
  readonly selectedInstanceId: string | null;
  readonly revision: number;
}

export interface ActiveWorkjetSelectionRequest {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly selectedInstanceId: string | null;
}

export type ActiveWorkjetSelectionAdapter = (
  request: ActiveWorkjetSelectionRequest,
) => Promise<ActiveWorkjetHostSelectionAck>;

let selectionAdapter: ActiveWorkjetSelectionAdapter | null = null;

/**
 * A native host installs exactly one adapter at its platform boundary. The
 * shared shell never guesses whether persistence succeeded; it adopts the
 * selection only from the correlated acknowledgement returned by this port.
 */
export function installActiveWorkjetSelectionAdapter(
  adapter: ActiveWorkjetSelectionAdapter,
): () => void {
  selectionAdapter = adapter;
  return () => {
    if (selectionAdapter === adapter) selectionAdapter = null;
  };
}

function persistSelectionMirror(selectedInstanceId: string | null): void {
  if (selectedInstanceId === null) crossModeSelectionMemory.forget("business-os");
  else
    crossModeSelectionMemory.remember({
      mode: "business-os",
      ctoxInstanceId: selectedInstanceId,
    });
}

/**
 * Mobile/native hosts call this only after their compare-and-swap selection
 * has been durably persisted. Older acknowledgements and equal-revision
 * conflicts are rejected; the Web root never performs an optimistic mirror.
 */
export function applyActiveWorkjetHostSelectionAck(ack: ActiveWorkjetHostSelectionAck): boolean {
  if (ack.requestId.trim() === "" || !Number.isSafeInteger(ack.revision) || ack.revision < 0)
    return false;
  const selectedInstanceId = ack.selectedInstanceId?.trim() || null;
  if (ack.revision < snapshot.selectionRevision) return false;
  if (
    ack.revision === snapshot.selectionRevision &&
    selectedInstanceId !== snapshot.selectedInstanceId
  )
    return false;
  if (
    ack.revision === snapshot.selectionRevision &&
    selectedInstanceId === snapshot.selectedInstanceId
  ) {
    persistSelectionMirror(selectedInstanceId);
    return true;
  }
  persistSelectionMirror(selectedInstanceId);
  publish({ ...snapshot, selectedInstanceId, selectionRevision: ack.revision });
  return true;
}

/**
 * Desktop has no platform persistence hop and commits synchronously. Mobile
 * installs an adapter and must return its durable CAS acknowledgement before
 * this function changes the shared scope.
 */
export async function requestActiveWorkjetSelection(
  selectedInstanceId: string | null,
): Promise<boolean> {
  const normalized = selectedInstanceId?.trim() || null;
  if (normalized === snapshot.selectedInstanceId) return true;
  const adapter = selectionAdapter;
  if (adapter === null) {
    commitActiveWorkjetSelection(normalized);
    return true;
  }
  const request = {
    requestId: randomUUID(),
    expectedRevision: snapshot.selectionRevision,
    selectedInstanceId: normalized,
  } satisfies ActiveWorkjetSelectionRequest;
  const ack = await adapter(request);
  if (ack.requestId !== request.requestId || ack.selectedInstanceId !== normalized) return false;
  return applyActiveWorkjetHostSelectionAck(ack);
}

export function __resetActiveWorkjetScopeForTests(
  next: ActiveWorkjetScopeSnapshot = {
    mode: "code",
    selectedInstanceId: null,
    selectionRevision: 0,
  },
): void {
  selectionAdapter = null;
  hostContextListeners.clear();
  snapshot = next;
  for (const listener of listeners) listener();
}
