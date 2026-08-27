import { describe, expect, it } from "@effect/vitest";

import { deriveBootstrapCredential, hashCredential } from "./DeviceSessions.ts";

describe("Workjet device-session credentials", () => {
  it("derives a stable 256-bit bootstrap without persisting plaintext", () => {
    const first = deriveBootstrapCredential("relay-only-secret", "grant-1");
    expect(first).toHaveLength(43);
    expect(deriveBootstrapCredential("relay-only-secret", "grant-1")).toBe(first);
    expect(deriveBootstrapCredential("relay-only-secret", "grant-2")).not.toBe(first);
    expect(hashCredential(first)).toMatch(/^[a-f0-9]{64}$/u);
  });
});
