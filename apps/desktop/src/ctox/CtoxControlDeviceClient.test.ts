import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { makeControlDeviceClient } from "./CtoxControlDeviceClient.ts";
import {
  deviceKeyThumbprint,
  deviceProofPayload,
  verifyDeviceProof,
} from "./fixtures/ctox-dev-desktop-device-proof.mjs";

type DevicePublicJwk = { crv: "P-256"; kty: "EC"; x: string; y: string };
const origin = "http://127.0.0.1:3107";
const tenant = "11111111-1111-4111-8111-111111111111";
function fixture() {
  let bytes: Uint8Array | undefined;
  let now = Date.parse("2026-10-11T17:00:00Z");
  let publicKey: DevicePublicJwk | undefined;
  let enrollmentError: string | undefined;
  let failures = 0;
  let revoked = false;
  const nonces = new Set<string>();
  const used = new Set<string>();
  const enrollments: DevicePublicJwk[] = [];
  let challenges = 0;
  let lastProof: { url: string; init: RequestInit } | undefined;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  const fetcher = async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/api/desktop/device-keys") {
      if (init.method !== "POST")
        return json({
          devices: [
            {
              id: "key",
              created_at: DateTime.formatIso(DateTime.makeUnsafe(now)),
              last_used_at: null,
              revoked_at: revoked ? DateTime.formatIso(DateTime.makeUnsafe(now)) : null,
              expired: false,
            },
          ],
        });
      const body = JSON.parse(String(init.body));
      enrollments.push(body.public_jwk);
      if (enrollmentError !== undefined) {
        const error = enrollmentError;
        if (error === "DEVICE_THUMBPRINT_ALREADY_REGISTERED") enrollmentError = undefined;
        return json({ error }, 409);
      }
      publicKey = body.public_jwk;
      return json(
        {
          device: {
            id: "key",
            thumbprint: deviceKeyThumbprint(body.public_jwk),
            created_at: DateTime.formatIso(DateTime.makeUnsafe(now)),
          },
        },
        201,
      );
    }
    if (path === "/api/desktop/device-keys/challenge") {
      challenges++;
      if (revoked) return json({ error: "DEVICE_AUTH_REQUIRED" }, 401);
      if (failures-- > 0) return json({ error: "DEVICE_SERVICE_UNAVAILABLE" }, 503);
      const nonce = Buffer.alloc(32, challenges).toString("base64url");
      nonces.add(nonce);
      return json({ nonce, expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 60_000)) });
    }
    const headers = new Headers(init.headers);
    const nonce = headers.get("x-ctox-device-nonce") ?? "";
    const signature = headers.get("x-ctox-device-signature") ?? "";
    if (
      !publicKey ||
      !nonces.has(nonce) ||
      used.has(nonce) ||
      !verifyDeviceProof(
        publicKey,
        signature,
        deviceProofPayload(
          nonce,
          init.method ?? "GET",
          new URL(origin).host,
          path,
          Buffer.from(String(init.body ?? "")),
        ),
      )
    )
      return json({ error: "DEVICE_AUTH_REQUIRED" }, 401);
    used.add(nonce);
    lastProof = { url, init };
    expect(init.credentials).toBe("omit");
    if (path === "/api/desktop/launch-token")
      return json({ launchConfigUrl: origin + "/api/desktop/launch/token" });
    return json({
      authentication: "device-key",
      account: {
        user: { id: "owner" },
        tenants: [{ id: tenant, businessName: "Fixture tenant", status: "active" }],
      },
    });
  };
  const open = () =>
    makeControlDeviceClient({
      baseUrl: origin,
      now: () => now,
      read: async () => bytes,
      write: async (value) => {
        bytes = value;
      },
      fetch: fetcher,
    });
  return {
    open,
    fetcher,
    enrollments,
    replay: async () => {
      if (lastProof === undefined) throw new Error("No proof");
      return fetcher(lastProof.url, lastProof.init);
    },
    challenges: () => challenges,
    bytes: () => bytes,
    error: (value: string | undefined) => {
      enrollmentError = value;
    },
    revoke: () => {
      revoked = true;
    },
    fail: (value: number) => {
      failures = value;
    },
    advance: (days: number) => {
      now += days * 86_400_000;
    },
  };
}

describe("control-plane device client", () => {
  it("retries enrollment after the upstream table failure without another login, bounded per minute", async () => {
    const f = fixture();
    f.error("relation device_keys missing fixture");
    const client = f.open();
    await client.enroll(f.fetcher);
    expect((await client.status()).state).toBe("not_configured");
    await client.retryEnrollment(f.fetcher);
    const attempts = f.enrollments.length;
    await client.retryEnrollment(f.fetcher);
    expect(f.enrollments).toHaveLength(attempts);
    f.error(undefined);
    f.advance(1 / 1440);
    await client.retryEnrollment(f.fetcher);
    expect((await client.status()).state).toBe("active");
    expect(f.enrollments).toHaveLength(attempts + 1);
    await client.retryEnrollment(f.fetcher);
    expect(f.enrollments).toHaveLength(attempts + 1);
  });
  it("enrolls on fresh login and uses a new key after a duplicate", async () => {
    const f = fixture();
    f.error("DEVICE_THUMBPRINT_ALREADY_REGISTERED");
    const client = f.open();
    await client.enroll(f.fetcher);
    expect(f.enrollments).toHaveLength(2);
    expect(f.enrollments[0]).not.toEqual(f.enrollments[1]);
    expect((await client.status()).state).toBe("active");
    await client.enroll(f.fetcher);
    expect(f.enrollments).toHaveLength(2);
  });
  for (const code of ["DEVICE_KEY_LIMIT_REACHED", "DEVICE_FRESH_LOGIN_REQUIRED"]) {
    it(`reports ${code} without opening a dialog or repeated enrollment`, async () => {
      const f = fixture();
      f.error(code);
      const client = f.open();
      await client.enroll(f.fetcher);
      expect(await client.status()).toEqual({ state: "not_configured", notice: code });
      expect(f.enrollments).toHaveLength(1);
    });
  }
  it("recovers without a cookie and never reuses a nonce, including launch", async () => {
    const f = fixture();
    const client = f.open();
    await client.enroll(f.fetcher);
    const restored = f.open();
    const response = await restored.recoverOnce();
    if (response === undefined) throw new Error("Device recovery did not return a response.");
    expect((await response.clone().json()).authentication).toBe("device-key");
    await restored.request("/api/desktop/launch-token", {
      method: "POST",
      body: JSON.stringify({ tenantId: tenant }),
    });
    expect(f.challenges()).toBe(2);
    expect((await f.replay()).status).toBe(401);
    await restored.recoverOnce();
    expect(f.challenges()).toBe(2);
    await expect(restored.request("/api/me", { method: "GET" })).rejects.toThrow(
      "DEVICE_SCOPE_DENIED",
    );
    // Mock server atomically consumes the nonce, as the upstream SQL fixture does.
    expect((await restored.status()).lastUsedAt).not.toBeNull();
  });
  it("marks revoked credentials invalid, preserves bytes and re-enrolls on login", async () => {
    const f = fixture();
    const client = f.open();
    await client.enroll(f.fetcher);
    f.revoke();
    expect(await f.open().recoverOnce()).toBeUndefined();
    const saved = JSON.parse(new TextDecoder().decode(f.bytes()));
    expect(saved.state).toBe("invalid");
    expect(saved.pkcs8).toBeTruthy();
    await client.enroll(f.fetcher);
    expect(f.enrollments).toHaveLength(2);
  });
  it("does not reuse cached discovery after the key becomes invalid", async () => {
    const f = fixture();
    const client = f.open();
    await client.enroll(f.fetcher);
    expect(await client.recoverOnce()).toBeDefined();
    f.revoke();
    await expect(client.request("/api/desktop/discovery", { method: "GET" })).rejects.toThrow(
      "DEVICE_AUTH_REQUIRED",
    );
    expect(await client.recoverOnce()).toBeUndefined();
  });
  it("bounds startup retries and honors idle expiry", async () => {
    const f = fixture();
    const client = f.open();
    await client.enroll(f.fetcher);
    f.fail(5);
    const restored = f.open();
    await restored.recoverOnce();
    await restored.recoverOnce();
    expect(f.challenges()).toBe(1);
    await restored.recoverOnce("next-generation");
    expect(f.challenges()).toBe(2);
    f.advance(31);
    expect((await client.status()).state).toBe("not_configured");
    await client.enroll(f.fetcher);
    expect(f.enrollments).toHaveLength(2);
  });
  it("enforces hard expiry even when a proof was used recently", async () => {
    const f = fixture();
    const client = f.open();
    await client.enroll(f.fetcher);
    for (let period = 0; period < 6; period++) {
      f.advance(29);
      await client.request("/api/desktop/discovery", { method: "GET" });
    }
    f.advance(7);
    expect((await client.status()).state).toBe("not_configured");
    await client.enroll(f.fetcher);
    expect(f.enrollments).toHaveLength(2);
  });
  it("explicit logout stays signed out across starts until a normal login", async () => {
    const f = fixture();
    const client = f.open();
    await client.enroll(f.fetcher);
    await client.suspend();
    expect(await f.open().recoverOnce()).toBeUndefined();
    expect(f.challenges()).toBe(0);
    await client.enroll(f.fetcher);
    expect((await client.status()).state).toBe("active");
  });
});
