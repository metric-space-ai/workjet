// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  CtoxGuestBounds,
  CtoxManagedActivationInput,
  CtoxManagedDiscoveryResult,
  CtoxManagedGuestResult,
  CtoxManagedInstance,
  CtoxManagedInstanceHealth,
} from "./ctox.ts";

const decodeInstance = Schema.decodeUnknownSync(CtoxManagedInstance);
const decodeHealth = Schema.decodeUnknownSync(CtoxManagedInstanceHealth);
const decodeDiscoveryResult = Schema.decodeUnknownSync(CtoxManagedDiscoveryResult);

const validInstance = {
  id: "managed:tenant_skf",
  source: "ctox_dev",
  displayName: "SKF",
  status: "available",
  domain: "acme.ctox.dev",
  role: "admin",
  healthSummary: {
    dataPlane: "rxdb-webrtc",
    dataPlaneReady: true,
    httpDataProxy: false,
    nativePeerObserved: true,
  },
} as const;

describe("CTOX renderer contracts", () => {
  it("decodes a renderer-safe managed instance and ready discovery result", () => {
    expect(decodeInstance(validInstance)).toEqual(validInstance);
    expect(decodeDiscoveryResult({ _tag: "ready", instances: [validInstance] })).toEqual({
      _tag: "ready",
      instances: [validInstance],
    });
  });

  it.each(["ctox_dev", "local_daemon", "ssh_managed", "pairing_invite"])(
    "accepts source %s",
    (source) => {
      expect(
        decodeInstance({
          ...validInstance,
          source,
        }).source,
      ).toBe(source);
    },
  );

  it.each(["available", "offline", "needs_auth", "pairing_expired", "installing", "error"])(
    "accepts status %s",
    (status) => {
      expect(decodeInstance({ ...validInstance, status }).status).toBe(status);
    },
  );

  it("rejects unsupported source and status values", () => {
    expect(() => decodeInstance({ ...validInstance, source: "remote_harness" })).toThrow();
    expect(() => decodeInstance({ ...validInstance, status: "connected" })).toThrow();
  });

  it("fixes the data plane to RxDB/WebRTC and forbids an HTTP data proxy", () => {
    expect(() => decodeHealth({ ...validInstance.healthSummary, dataPlane: "http" })).toThrow();
    expect(() => decodeHealth({ ...validInstance.healthSummary, httpDataProxy: true })).toThrow();
  });

  it("rejects unbounded, control-bearing, and unsafe optional renderer text", () => {
    expect(() => decodeInstance({ ...validInstance, id: "a".repeat(513) })).toThrow();
    expect(() => decodeInstance({ ...validInstance, id: "bad\u0000id" })).toThrow();
    expect(() => decodeInstance({ ...validInstance, displayName: "bad\u0000name" })).toThrow();
    expect(() => decodeInstance({ ...validInstance, displayName: "a".repeat(257) })).toThrow();
    expect(() => decodeInstance({ ...validInstance, role: "a".repeat(129) })).toThrow();
    expect(() =>
      decodeInstance({ ...validInstance, domain: "https://user:secret@ctox.dev" }),
    ).toThrow();
  });

  it("strips session partitions, tenant launch ids, tokens, URLs, and packed configs", () => {
    const decoded = decodeInstance({
      ...validInstance,
      sessionPartition: "persist:server-controlled",
      tenantId: "tenant_skf",
      token: "secret",
      launchUrl: "https://ctox.dev/?token=secret",
      ctox_config: "packed-secret",
    });

    expect(decoded).toEqual(validInstance);
    expect(JSON.stringify(decoded)).not.toContain("secret");
    expect(JSON.stringify(decoded)).not.toContain("partition");
  });

  it("accepts only finite nonnegative integer guest bounds and stable-id activation", () => {
    const decodeBounds = Schema.decodeUnknownSync(CtoxGuestBounds);
    const decodeActivation = Schema.decodeUnknownSync(CtoxManagedActivationInput);
    const bounds = { x: 1, y: 2, width: 800, height: 600 };
    expect(decodeBounds(bounds)).toEqual(bounds);
    expect(decodeActivation({ instanceId: validInstance.id, bounds })).toEqual({
      instanceId: validInstance.id,
      bounds,
    });
    for (const invalid of [-1, 1.5, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      expect(() => decodeBounds({ ...bounds, width: invalid })).toThrow();
    }
  });

  it("keeps guest activation results free of launch data", () => {
    const decodeGuestResult = Schema.decodeUnknownSync(CtoxManagedGuestResult);
    expect(
      decodeGuestResult({
        _tag: "ready",
        instanceId: validInstance.id,
        launchUrl: "https://ctox.dev/?ctox_config=secret",
        token: "secret",
      }),
    ).toEqual({ _tag: "ready", instanceId: validInstance.id });
  });

  it("decodes only explicit signed-out, ready, and redacted failure states", () => {
    expect(decodeDiscoveryResult({ _tag: "signed_out" })).toEqual({ _tag: "signed_out" });
    expect(decodeDiscoveryResult({ _tag: "failed", code: "http_error", httpStatus: 503 })).toEqual({
      _tag: "failed",
      code: "http_error",
      httpStatus: 503,
    });
    expect(
      decodeDiscoveryResult({
        _tag: "failed",
        code: "http_error",
        httpStatus: 503,
        responseBody: "secret",
      }),
    ).toEqual({ _tag: "failed", code: "http_error", httpStatus: 503 });
  });

  it("bounds the renderer-facing instance collection", () => {
    expect(() =>
      decodeDiscoveryResult({
        _tag: "ready",
        instances: Array.from({ length: 1_001 }, () => validInstance),
      }),
    ).toThrow();
  });
});
