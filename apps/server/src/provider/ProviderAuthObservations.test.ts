// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { ProviderInstanceId } from "@t3tools/contracts";
import { assert, beforeEach, describe, it } from "@effect/vitest";

import {
  clearProviderAuthObservation,
  getProviderAuthObservation,
  isAuthenticationFailureMessage,
  reconcileAuthClaim,
  recordProviderAuthFailure,
  resetProviderAuthObservations,
} from "./ProviderAuthObservations.ts";

const claude = ProviderInstanceId.make("claudeAgent");

describe("telling an expired sign-in from a spent quota", () => {
  it("recognises the credential failures a turn actually reported", () => {
    // Verbatim from the CLI on 2026-08-23.
    assert.isTrue(
      isAuthenticationFailureMessage(
        "Failed to authenticate: OAuth session expired and could not be refreshed",
      ),
    );
    assert.isTrue(isAuthenticationFailureMessage("401 Unauthorized"));
    assert.isTrue(isAuthenticationFailureMessage("Invalid credentials"));
  });

  it("does NOT treat a spent quota as a broken sign-in", () => {
    // Also verbatim, from Codex the same evening. The credential is valid and
    // the account is simply out of budget; calling it an expired login would
    // send the operator to re-authenticate something that is fine.
    assert.isFalse(
      isAuthenticationFailureMessage(
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 27th, 2026 1:00 PM.",
      ),
    );
    assert.isFalse(isAuthenticationFailureMessage("Rate limit exceeded"));
    assert.isFalse(isAuthenticationFailureMessage("Model quota exhausted"));
  });
});

describe("an observed failure overrides a probe that never touched the API", () => {
  beforeEach(() => {
    resetProviderAuthObservations();
  });

  it("downgrades a probe's Authenticated when a later turn failed to authenticate", () => {
    // The exact defect: the probe reads a LOCAL handshake, which succeeds with
    // a dead token, and published "authenticated" while every turn failed.
    recordProviderAuthFailure(claude, "OAuth session expired", 2_000);

    const reconciled = reconcileAuthClaim({
      claim: { status: "authenticated", email: "person@example.com" },
      observation: getProviderAuthObservation(claude),
      probedAtMs: 1_000,
    });

    assert.equal(reconciled.status, "unauthenticated");
    assert.equal((reconciled as unknown as { message: string }).message, "OAuth session expired");
  });

  it("keeps a failure that is older than the probe out of the way", () => {
    // The operator may have signed in between the failure and the probe.
    // Holding the stale failure over a fresh look would invert the defect.
    recordProviderAuthFailure(claude, "OAuth session expired", 1_000);

    const reconciled = reconcileAuthClaim({
      claim: { status: "authenticated" },
      observation: getProviderAuthObservation(claude),
      probedAtMs: 5_000,
    });

    assert.equal(reconciled.status, "authenticated");
  });

  it("leaves a healthy provider's claim exactly as the probe made it", () => {
    const claim = { status: "authenticated", email: "person@example.com" } as const;

    const reconciled = reconcileAuthClaim({
      claim,
      observation: undefined,
      probedAtMs: 1_000,
    });

    assert.strictEqual(reconciled, claim);
  });

  it("forgets the failure once a turn gets through", () => {
    recordProviderAuthFailure(claude, "OAuth session expired", 2_000);
    clearProviderAuthObservation(claude);

    assert.isUndefined(getProviderAuthObservation(claude));
    assert.equal(
      reconcileAuthClaim({
        claim: { status: "authenticated" },
        observation: getProviderAuthObservation(claude),
        probedAtMs: 1_000,
      }).status,
      "authenticated",
    );
  });

  it("keeps observations apart per provider instance", () => {
    const codex = ProviderInstanceId.make("codex");
    recordProviderAuthFailure(claude, "OAuth session expired", 2_000);

    assert.isUndefined(getProviderAuthObservation(codex));
    assert.isDefined(getProviderAuthObservation(claude));
  });
});
