// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * What a REAL turn observed about a provider's sign-in, so the settings
 * surface can stop claiming a liveness it never measured.
 *
 * ── The lie this exists to end ──────────────────────────────────────────────
 * `probeClaudeCapabilities` deliberately never reaches the API. Its own
 * comment says so: "This prevents any prompt from reaching the Anthropic API."
 * It spawns the CLI, reads the local initialization handshake, and returns the
 * account metadata found there — and that handshake succeeds perfectly well
 * with a dead token. On the strength of it the provider was published as
 * `auth: { status: "authenticated" }`.
 *
 * Measured on 2026-08-23: the Harnesses page read "Claude v2.1.226 ·
 * Authenticated · checked just now" while every single turn came back
 * "Failed to authenticate: OAuth session expired and could not be refreshed".
 * Thirteen consecutive failures under a green claim. Nothing in settings ever
 * tested the credential, so nothing could contradict it.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * A turn is the only thing here that actually spends the credential, so a turn
 * is the only thing that can testify about it. When a turn's authentication
 * failed at or after the probe that produced a claim, the observation wins:
 * the probe looked at a local handshake, the turn looked at the API.
 *
 * Ordering, not mere presence, decides. A failure from BEFORE the latest probe
 * says nothing about the credential now — the operator may have signed in
 * again between the two, and holding a stale failure over a fresh probe would
 * invert the defect instead of fixing it.
 *
 * ── Deliberately NOT here ───────────────────────────────────────────────────
 * No network call and no probe of its own. This module records what already
 * happened; it never spends the credential to find out. And it only ever
 * downgrades a claim — it can report a sign-in as expired, never as working,
 * because a turn that succeeded proves the credential worked at that moment
 * and nothing about the provider's installation or version.
 */
import type { ProviderInstanceId } from "@t3tools/contracts";

/** A failed sign-in seen by a real turn. */
export interface ProviderAuthObservation {
  readonly failedAtMs: number;
  /** The provider's own wording, shown to the operator verbatim. */
  readonly message: string;
}

/**
 * Whether a provider's failure text is about the CREDENTIAL rather than about
 * the request.
 *
 * Kept narrow on purpose. A quota refusal ("You've hit your usage limit …") is
 * a perfectly valid sign-in that has run out of budget; reporting it as an
 * expired login would send the operator to re-authenticate a credential that
 * is fine, which is the same class of wrong answer this module exists to
 * remove — only pointing the other way.
 */
export function isAuthenticationFailureMessage(message: string): boolean {
  const text = message.toLowerCase();
  if (text.includes("usage limit") || text.includes("quota") || text.includes("rate limit")) {
    return false;
  }
  return (
    text.includes("authenticate") ||
    text.includes("authentication") ||
    text.includes("oauth") ||
    text.includes("unauthorized") ||
    text.includes("credentials")
  );
}

/**
 * Process-local, because that is exactly the lifetime of the claim it
 * corrects: provider status is rebuilt by probes in this process, and a fresh
 * process re-probes from scratch. Persisting a failure across restarts would
 * outlive the sign-in it describes.
 */
const observations = new Map<string, ProviderAuthObservation>();

export function recordProviderAuthFailure(
  instanceId: ProviderInstanceId,
  message: string,
  failedAtMs: number,
): void {
  observations.set(String(instanceId), { failedAtMs, message });
}

/**
 * A turn got through, so whatever was wrong with the credential is over.
 * Called on provider success rather than on a probe, because only a turn
 * spends the credential.
 */
export function clearProviderAuthObservation(instanceId: ProviderInstanceId): void {
  observations.delete(String(instanceId));
}

export function getProviderAuthObservation(
  instanceId: ProviderInstanceId,
): ProviderAuthObservation | undefined {
  return observations.get(String(instanceId));
}

/** Test seam: the registry is module state, so a test must be able to reset it. */
export function resetProviderAuthObservations(): void {
  observations.clear();
}

export interface ReconcilableAuthClaim {
  readonly status: string;
  readonly email?: string | undefined;
}

/**
 * Fold an observation into the claim a local probe produced.
 *
 * Returns the probe's own claim untouched unless a real turn contradicts it,
 * so a healthy provider reads exactly as before and only a provider that
 * actually failed to authenticate is downgraded.
 */
export function reconcileAuthClaim<T extends ReconcilableAuthClaim>(input: {
  readonly claim: T;
  readonly observation: ProviderAuthObservation | undefined;
  /**
   * When the probe that produced `claim` ran. Ordering against this is the
   * whole rule: a failure from before it may already have been resolved by a
   * fresh sign-in, and burying a newer probe under an older failure would
   * invert the defect rather than fix it.
   */
  readonly probedAtMs: number;
}): T {
  const observation = input.observation;
  if (observation === undefined) return input.claim;
  if (observation.failedAtMs < input.probedAtMs) return input.claim;
  // Same shape as the claim, one field narrowed: the surface renders whatever
  // status it is given, and `message` is the provider's own wording.
  return {
    ...input.claim,
    status: "unauthenticated",
    message: observation.message,
  } as unknown as T;
}
