// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, describe, it } from "@effect/vitest";

import {
  checkLinuxBackendFailsClosed,
  interpretKeychainSmoke,
  KEYCHAIN_SMOKE_SENTINEL,
} from "./keychain-smoke.ts";

// The smoke itself needs a real OS keychain, so CI cannot run it everywhere.
// Its DECISIONS are pure, and those are what must not rot: a smoke that
// reports "pass" for the wrong reason is worse than no smoke at all.
describe("keychain smoke verdict", () => {
  const ok = { ok: true, available: true } as const;

  it("passes only when a second process returned the sentinel", () => {
    assert.strictEqual(
      interpretKeychainSmoke({
        encrypt: ok,
        decrypt: { ...ok, plaintext: KEYCHAIN_SMOKE_SENTINEL },
      }).verdict,
      "pass",
    );
  });

  it("fails when the fresh process decrypted something else", () => {
    // The shape of a key that never reached the keychain: the phases run, but
    // what comes back is not what went in.
    const result = interpretKeychainSmoke({
      encrypt: ok,
      decrypt: { ...ok, plaintext: "something-else" },
    });
    assert.strictEqual(result.verdict, "fail");
    assert.include(result.detail, "did not survive process death");
  });

  it("fails when the decrypt phase itself failed", () => {
    assert.strictEqual(
      interpretKeychainSmoke({ encrypt: ok, decrypt: { ok: false, error: "boom" } }).verdict,
      "fail",
    );
  });

  it("reports unavailable rather than failing where there is no keychain", () => {
    // A headless box has none. Saying so beats a red run that proves nothing
    // about the code — but it must never read as a pass either.
    const result = interpretKeychainSmoke({
      encrypt: { ok: false, available: false },
      decrypt: { ok: false },
    });
    assert.strictEqual(result.verdict, "unavailable");
  });

  it("never reports pass without a decrypt result", () => {
    for (const decrypt of [{ ok: true }, { ok: true, plaintext: null }] as const) {
      assert.notStrictEqual(interpretKeychainSmoke({ encrypt: ok, decrypt }).verdict, "pass");
    }
  });
});

describe("linux backend guard", () => {
  it("fails closed on the plaintext backends", () => {
    // basic_text answers "encryption available" while writing plaintext. A
    // green run against it is the exact false positive being guarded.
    for (const backend of ["basic_text", "basic", "BASIC_TEXT", " basic_text "]) {
      const result = checkLinuxBackendFailsClosed(backend);
      assert.isFalse(result.ok, `${backend} must fail closed`);
      assert.include(result.detail, "plaintext");
    }
  });

  it("accepts a real keyring backend", () => {
    for (const backend of ["gnome_libsecret", "kwallet6"]) {
      assert.isTrue(checkLinuxBackendFailsClosed(backend).ok);
    }
  });
});
