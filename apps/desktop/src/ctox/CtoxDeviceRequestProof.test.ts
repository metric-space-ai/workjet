import { describe, expect, it } from "vite-plus/test";
import { createCtoxDeviceProofKey } from "./CtoxDeviceProofKey.ts";
// Exact verifier copied from mkh-welsch/ctox-dev lib/desktop-device-proof.ts,
// commit 7e758a20ad9ed31c4e291f999fd37b9246d44f14 (MIT).
import { deviceProofPayload, deviceKeyThumbprint, verifyDeviceProof } from "./fixtures/ctox-dev-desktop-device-proof.mjs";

describe("ctox.dev request proof interoperability", () => {
  it("verifies a fixed message with the upstream verifier and rejects substitution", () => {
    const key = createCtoxDeviceProofKey();
    const nonce = Buffer.alloc(32, 7).toString("base64url");
    const body = '{"tenantId":"11111111-1111-4111-8111-111111111111"}';
    const signature = key.signRequest({ nonce, method: "POST", baseUrl: "http://127.0.0.1:3107", pathname: "/api/desktop/launch-token", body });
    const payload = (host: string, bytes: string) => deviceProofPayload(nonce, "POST", host, "/api/desktop/launch-token", Buffer.from(bytes));
    expect(key.thumbprint).toBe(deviceKeyThumbprint(key.publicJwk));
    expect(verifyDeviceProof(key.publicJwk, signature, payload("127.0.0.1:3107", body))).toBe(true);
    expect(verifyDeviceProof(key.publicJwk, signature, payload("ctox.dev", body))).toBe(false);
    expect(verifyDeviceProof(key.publicJwk, signature, payload("127.0.0.1:3107", body + " "))).toBe(false);
    expect(verifyDeviceProof(key.publicJwk, signature, deviceProofPayload(nonce, "GET", "127.0.0.1:3107", "/api/desktop/discovery", Buffer.alloc(0)))).toBe(false);
  });
});
