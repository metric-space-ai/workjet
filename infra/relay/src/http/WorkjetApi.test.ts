import { describe, expect, it } from "@effect/vitest";

import type { DeviceSessionGrantCandidate } from "../workjet/DeviceSessions.ts";
import { resolveControlIdentityAssertionAuthority } from "./WorkjetApi.ts";

const devicePrincipal: DeviceSessionGrantCandidate = {
  grantId: "grant-1",
  relayUserId: "user-1",
  businessOsInstanceId: "business-os-1",
  deviceId: "mobile-1",
  proofKeyThumbprint: "jkt-1",
  accessGeneration: 1,
};

function resolve(
  overrides: Partial<{
    readonly relayUserId: string;
    readonly currentJkt: string;
    readonly devicePrincipal: DeviceSessionGrantCandidate | null;
    readonly workjetInstallationId: string;
    readonly businessOsInstanceId: string;
  }> = {},
) {
  return resolveControlIdentityAssertionAuthority({
    relayPrincipal: {
      userId: overrides.relayUserId ?? "user-1",
      proofKeyThumbprint: overrides.currentJkt ?? "jkt-1",
    },
    devicePrincipal:
      overrides.devicePrincipal === undefined ? devicePrincipal : overrides.devicePrincipal,
    workjetInstallationId: overrides.workjetInstallationId ?? "mobile-1",
    businessOsInstanceId: overrides.businessOsInstanceId ?? "business-os-1",
  });
}

describe("Workjet control identity assertion authority", () => {
  it("accepts the exact active device-session instance, device, user and current JKT", () => {
    expect(resolve()).toEqual({ relayUserId: "user-1", proofKeyThumbprint: "jkt-1" });
  });

  it("fails closed on instance, device, current-JKT or Relay-user mismatch", () => {
    expect(resolve({ businessOsInstanceId: "business-os-2" })).toBeNull();
    expect(resolve({ workjetInstallationId: "mobile-2" })).toBeNull();
    expect(resolve({ currentJkt: "jkt-2" })).toBeNull();
    expect(resolve({ relayUserId: "user-2" })).toBeNull();
  });

  it("preserves the existing Clerk-derived Relay principal path", () => {
    expect(resolve({ devicePrincipal: null })).toEqual({
      relayUserId: "user-1",
      proofKeyThumbprint: "jkt-1",
    });
  });
});
