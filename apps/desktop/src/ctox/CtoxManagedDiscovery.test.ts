// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, describe, it } from "@effect/vitest";

import {
  ctoxManagedSessionPartition,
  discoverCtoxManagedInstances,
  normalizeCtoxDevSessionPackage,
  normalizeCtoxManagedBaseUrl,
  type CtoxManagedDiscoveryFetch,
} from "./CtoxManagedDiscovery.ts";

function response(input: {
  readonly status?: number;
  readonly ok?: boolean;
  readonly payload?: unknown;
  readonly json?: () => Promise<unknown>;
}) {
  const status = input.status ?? 200;
  return {
    status,
    ok: input.ok ?? (status >= 200 && status < 300),
    json: input.json ?? (async () => input.payload),
  };
}

describe("CTOX managed discovery", () => {
  it("normalizes a ctox.dev session package without copying server partitions or secrets", () => {
    const instances = normalizeCtoxDevSessionPackage({
      account: {
        tenants: [
          {
            id: "tenant_skf",
            slug: "skf",
            domain: "acme.ctox.dev",
            businessName: "SKF",
            status: "active",
            healthStatus: "ok",
            tenantRole: "admin",
            launchAllowed: true,
            sessionPartition: "persist:server-controlled",
            accessToken: "must-not-cross-the-boundary",
          },
        ],
      },
    });

    assert.isDefined(instances);
    assert.deepEqual(instances, [
      {
        id: "managed:tenant_skf",
        source: "ctox_dev",
        displayName: "SKF",
        status: "available",
        sessionPartition: ctoxManagedSessionPartition({
          source: "ctox_dev",
          id: "managed:tenant_skf",
        }),
        domain: "acme.ctox.dev",
        tenantId: "tenant_skf",
        role: "admin",
        healthSummary: {
          dataPlane: "rxdb-webrtc",
          dataPlaneReady: true,
          httpDataProxy: false,
          nativePeerObserved: true,
        },
      },
    ]);
    assert.notInclude(JSON.stringify(instances), "must-not-cross-the-boundary");
    assert.notInclude(JSON.stringify(instances), "server-controlled");
  });

  it("maps launch denial to needs_auth and keeps the HTTP bridge disabled", () => {
    const instances = normalizeCtoxDevSessionPackage({
      account: {
        tenants: [
          {
            id: "tenant_revoked",
            businessName: "Revoked",
            launchAllowed: false,
          },
        ],
      },
    });

    assert.equal(instances?.[0]?.status, "needs_auth");
    assert.equal(instances?.[0]?.healthSummary.httpDataProxy, false);
  });

  it("sorts managed instances by display name and then exact stable id", () => {
    const instances = normalizeCtoxDevSessionPackage({
      account: {
        tenants: [
          { id: "tenant_z", businessName: "Zulu" },
          { id: "tenant_b", businessName: "alpha" },
          { id: "tenant_a", businessName: "Alpha" },
        ],
      },
    });

    assert.deepEqual(
      instances?.map(({ id }) => id),
      ["managed:tenant_a", "managed:tenant_b", "managed:tenant_z"],
    );
  });

  it("omits unsafe optional text and falls back without exposing URL credentials", () => {
    const secret = "must-not-cross";
    const instances = normalizeCtoxDevSessionPackage({
      account: {
        tenants: [
          {
            id: "tenant_safe",
            businessName: `Unsafe\u0000${secret}`,
            domain: `https://user:${secret}@tenant.ctox.dev/`,
            businessOsUrl: `https://tenant.ctox.dev/business-os?token=${secret}`,
            slug: "s".repeat(257),
            tenantRole: `${"r".repeat(129)}\u0000${secret}`,
          },
        ],
      },
    });

    assert.deepEqual(instances?.[0], {
      id: "managed:tenant_safe",
      source: "ctox_dev",
      displayName: "tenant_safe",
      status: "available",
      sessionPartition: ctoxManagedSessionPartition({
        source: "ctox_dev",
        id: "managed:tenant_safe",
      }),
      tenantId: "tenant_safe",
      healthSummary: {
        dataPlane: "rxdb-webrtc",
        dataPlaneReady: false,
        httpDataProxy: false,
        nativePeerObserved: false,
      },
    });
    assert.notInclude(JSON.stringify(instances), secret);
  });

  it("extracts only a safe hostname from an HTTPS business OS URL", () => {
    const instances = normalizeCtoxDevSessionPackage({
      account: {
        tenants: [
          {
            id: "tenant_safe",
            businessOsUrl: "https://Tenant.CTOX.dev/business-os/tenant",
          },
        ],
      },
    });

    assert.equal(instances?.[0]?.domain, "tenant.ctox.dev");
    assert.equal(instances?.[0]?.displayName, "tenant.ctox.dev");
  });

  it("derives deterministic, case-sensitive partitions from the complete exact id", () => {
    const lower = ctoxManagedSessionPartition({ source: "ctox_dev", id: "managed:tenant_skf" });
    const upper = ctoxManagedSessionPartition({ source: "ctox_dev", id: "managed:Tenant_SKF" });
    const longPrefix = `managed:${"a".repeat(600)}`;
    const longA = ctoxManagedSessionPartition({ source: "ctox_dev", id: `${longPrefix}A` });
    const longB = ctoxManagedSessionPartition({ source: "ctox_dev", id: `${longPrefix}B` });

    assert.equal(
      lower,
      ctoxManagedSessionPartition({ source: "ctox_dev", id: "managed:tenant_skf" }),
    );
    assert.notEqual(lower, upper);
    assert.notEqual(longA, longB);
    assert.match(lower, /^persist:workjet-ctox-ctox_dev-[a-f0-9]{64}$/);
  });

  it.each([
    ["https://ctox.dev", "https://ctox.dev"],
    ["https://accounts.ctox.dev/", "https://accounts.ctox.dev"],
    ["http://localhost:8765/", "http://localhost:8765"],
    ["http://dev.localhost:8765", "http://dev.localhost:8765"],
    ["http://127.0.0.1:8765/", "http://127.0.0.1:8765"],
    ["http://[::1]:8765/", "http://[::1]:8765"],
  ])("accepts managed base URL %s", (input, expected) => {
    assert.equal(normalizeCtoxManagedBaseUrl(input), expected);
  });

  it.each([
    "http://ctox.dev",
    "https://ctox.dev.evil.example",
    "https://evilctox.dev",
    "https://ctox.dev:444",
    "https://user:password@ctox.dev",
    "https://ctox.dev/#fragment",
    "https://ctox.dev/?query=1",
    "https://ctox.dev/business-os",
    "http://localhost.evil.example:8765",
    "https://localhost",
  ])("rejects unsafe managed base URL %s", (input) => {
    assert.isUndefined(normalizeCtoxManagedBaseUrl(input));
  });

  it("calls the session-package endpoint with credential-safe discovery options", async () => {
    const calls: Array<{ url: string; init: Parameters<CtoxManagedDiscoveryFetch>[1] }> = [];
    const fetchImpl: CtoxManagedDiscoveryFetch = async (url, init) => {
      calls.push({ url, init });
      return response({
        payload: {
          account: {
            tenants: [{ id: "tenant_skf", businessName: "SKF", launchAllowed: true }],
          },
        },
      });
    };

    const result = await discoverCtoxManagedInstances({
      baseUrl: "https://accounts.ctox.dev/",
      fetchImpl,
    });

    assert.equal(result._tag, "ready");
    if (result._tag === "ready") assert.equal(result.instances[0]?.id, "managed:tenant_skf");
    assert.deepEqual(calls, [
      {
        url: "https://accounts.ctox.dev/api/desktop/session-package",
        init: {
          cache: "no-store",
          credentials: "include",
          headers: { "x-ctox-desktop-client": "ctox-business-os-desktop" },
        },
      },
    ]);
  });

  it("returns an explicit signed-out state for 401 without reading a body", async () => {
    let bodyRead = false;
    const result = await discoverCtoxManagedInstances({
      fetchImpl: async () =>
        response({
          status: 401,
          json: async () => {
            bodyRead = true;
            return { token: "secret" };
          },
        }),
    });

    assert.deepEqual(result, { _tag: "signed_out" });
    assert.isFalse(bodyRead);
  });

  it("returns only typed redacted failures for network, HTTP, and invalid payload errors", async () => {
    const secret = "do-not-expose-this-secret";
    const network = await discoverCtoxManagedInstances({
      fetchImpl: async () => {
        throw new Error(secret);
      },
    });
    let httpBodyRead = false;
    const http = await discoverCtoxManagedInstances({
      fetchImpl: async () =>
        response({
          status: 503,
          json: async () => {
            httpBodyRead = true;
            return { accessToken: secret };
          },
        }),
    });
    const invalid = await discoverCtoxManagedInstances({
      fetchImpl: async () =>
        response({ payload: { account: { tenants: "not-an-array" }, secret } }),
    });

    assert.deepEqual(network, { _tag: "failed", code: "network_error" });
    assert.deepEqual(http, { _tag: "failed", code: "http_error", httpStatus: 503 });
    assert.deepEqual(invalid, { _tag: "failed", code: "invalid_response" });
    assert.isFalse(httpBodyRead);
    assert.notInclude(JSON.stringify([network, http, invalid]), secret);
  });

  it("rejects missing, invalid, and duplicate tenant identities", () => {
    for (const tenants of [
      [{}],
      [{ id: "" }],
      [{ id: "tenant/unsafe" }],
      [{ id: "a".repeat(257) }],
      [{ id: "tenant_a" }, { id: " tenant_a " }],
    ]) {
      assert.isUndefined(normalizeCtoxDevSessionPackage({ account: { tenants } }));
    }
  });

  it("rejects an unbounded managed tenant collection", () => {
    const tenants = Array.from({ length: 1_001 }, (_, index) => ({ id: `tenant_${index}` }));
    assert.isUndefined(normalizeCtoxDevSessionPackage({ account: { tenants } }));
  });

  it("returns a redacted base-URL failure before issuing a request", async () => {
    let called = false;
    const result = await discoverCtoxManagedInstances({
      baseUrl: "https://user:secret@ctox.dev",
      fetchImpl: async () => {
        called = true;
        return response({ payload: {} });
      },
    });

    assert.deepEqual(result, { _tag: "failed", code: "invalid_base_url" });
    assert.isFalse(called);
    assert.notInclude(JSON.stringify(result), "secret");
  });
});
