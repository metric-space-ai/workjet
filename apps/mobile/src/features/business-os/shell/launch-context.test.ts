import { describe, expect, it, vi } from "vite-plus/test";

import { buildBusinessOsLaunchContext, injectBusinessOsLaunchContext } from "./launch-context";

const instance = {
  id: "local-a",
  displayName: "Operations",
  instanceId: "instance-a",
  syncRoom: "ctox-business-os:instance-a",
  nativePeerId: "native-a",
  signalingUrls: ["wss://signal.example.test/socket"],
  inviteExpiresAt: "2026-08-25T13:00:00Z",
  capabilityExpiresAtMs: Date.parse("2026-08-25T12:30:00Z"),
  user: { id: "user-a", displayName: "Operator", role: "admin", isAdmin: true },
  browserTokenRef: "browser-ref",
  signalingAuthVersion: "ctox-role-bound-v1",
  browserTokenHash: "294dbc745bd2c516e81ae8a8bea452be757f78ae306a24f91c080885bd8bdf97", // gitleaks:allow -- deterministic SHA-256 test vector
  nativeTokenHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  capabilitySecretRef: "cap-ref",
  storageIdentity: "00000000-0000-4000-8000-000000000001",
  createdAtMs: 1,
  updatedAtMs: 1,
} as const;

describe("Business OS launch context", () => {
  it("injects direct RxDB/WebRTC bootstrap before shell scripts without a URL secret", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-25T12:00:00Z"));
    const context = buildBusinessOsLaunchContext(
      instance,
      { browserToken: "raw-browser-token", capabilityToken: "capability-secret" },
      "ios",
    );
    const html = injectBusinessOsLaunchContext(
      '<html><head><script src="shell.js"></script></head></html>',
      context,
    );
    expect(html.indexOf("data-workjet-mobile-bootstrap")).toBeLessThan(html.indexOf("shell.js"));
    expect(html).toContain('"data_plane":"rxdb-webrtc"');
    expect(html).toContain('"http_bridge_available":false');
    expect(html).not.toContain("ctox_config");
  });

  it("fails closed for expired capability tokens", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-25T13:00:00Z"));
    expect(() =>
      buildBusinessOsLaunchContext(
        instance,
        { browserToken: "raw-browser-token", capabilityToken: "capability-secret" },
        "android",
      ),
    ).toThrowError("expired");
  });
});
