import { describe, expect, it } from "vite-plus/test";

import { normalizeWorkjetDeviceInviteReferenceEndpoint } from "./businessOsMobileInvite.ts";

describe("Workjet device invite reference redemption", () => {
  it("accepts HTTPS and loopback HTTP origins and strips only a trailing slash", () => {
    expect(normalizeWorkjetDeviceInviteReferenceEndpoint("https://workjet.example.test/")).toBe(
      "https://workjet.example.test",
    );
    expect(normalizeWorkjetDeviceInviteReferenceEndpoint("http://127.0.0.1:13773/")).toBe(
      "http://127.0.0.1:13773",
    );
    expect(normalizeWorkjetDeviceInviteReferenceEndpoint("http://localhost:13773/")).toBe(
      "http://localhost:13773",
    );
  });

  it("rejects credentials, fragments, query strings, and non-http schemes", () => {
    expect(
      normalizeWorkjetDeviceInviteReferenceEndpoint("https://user:secret@example.test"),
    ).toBeNull();
    expect(
      normalizeWorkjetDeviceInviteReferenceEndpoint("https://example.test/#secret"),
    ).toBeNull();
    expect(
      normalizeWorkjetDeviceInviteReferenceEndpoint("https://example.test/?code=x"),
    ).toBeNull();
    expect(normalizeWorkjetDeviceInviteReferenceEndpoint("workjet://pair")).toBeNull();
    expect(normalizeWorkjetDeviceInviteReferenceEndpoint("http://192.168.1.20:13773/")).toBeNull();
  });
});
