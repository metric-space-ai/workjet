// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * The handoff slot between the link navigator and the Business OS shell.
 *
 * Code mode can be addressed immediately because its router is always
 * available. Business OS selection is asynchronous: a cross-mode target may
 * arrive before discovery contains the instance. This bounded one-shot
 * request lets the always-mounted provider adopt it only after discovery
 * confirms it.
 *
 * That waiting slot is here, deliberately outside React and deliberately
 * one-shot: `take` clears it, so a request can be honoured exactly once and a
 * stale request can never re-select an instance the user has since left.
 *
 * Bounded and address-only: an instance id and an optional app module id. No
 * Business OS record data crosses this slot — the guest reads its own data
 * from its own authority once it is up.
 */
import type { CrossModeTarget } from "./crossModeTarget";

export interface CrossModeBusinessOsRequest {
  /** Which CTOX instance the sidebar must select. */
  readonly instanceId: string;
  /** Which Business OS app to open in its guest, when the link names one. */
  readonly moduleId?: string;
}

let pending: CrossModeBusinessOsRequest | null = null;
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

/**
 * Ask the Business OS shell to select an instance. Called by the navigator's
 * `select-sidebar-entry` step, i.e. only AFTER the Code surface was released
 * and the product mode was switched.
 */
export function requestCrossModeBusinessOsInstance(target: CrossModeTarget): void {
  if (target.mode !== "business-os" || target.ctoxInstanceId === undefined) return;
  pending = { instanceId: target.ctoxInstanceId };
  notify();
}

/**
 * Ask for an app inside the already-requested instance. Called by the
 * navigator's `open-main-surface` step. Ignored when it does not match the
 * pending instance, so a late call cannot retarget a different guest.
 */
export function requestCrossModeBusinessOsApp(target: CrossModeTarget): void {
  if (target.mode !== "business-os") return;
  const moduleId = target.businessOsObject?.moduleId;
  if (moduleId === undefined) return;
  if (pending === null || pending.instanceId !== target.ctoxInstanceId) return;
  pending = { instanceId: pending.instanceId, moduleId };
  notify();
}

/** Read and clear the pending request. One-shot by design. */
export function takeCrossModeBusinessOsRequest(): CrossModeBusinessOsRequest | null {
  const request = pending;
  pending = null;
  return request;
}

/** Read without clearing. For assertions and for render-time gating. */
export function peekCrossModeBusinessOsRequest(): CrossModeBusinessOsRequest | null {
  return pending;
}

/** Drop a pending request — the mode was left again before it was honoured. */
export function clearCrossModeBusinessOsRequest(): void {
  if (pending === null) return;
  pending = null;
  notify();
}

export function subscribeToCrossModeBusinessOsRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
