import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  WORKJET_MANAGED_BACKEND_CONTROL_MAX_TTL_SECONDS,
  WORKJET_MANAGED_BACKEND_CONTROL_RESPONSE_HEADERS,
  WORKJET_MANAGED_BACKEND_CONTROL_RESOLVE_PATH,
  WORKJET_MANAGED_DEVICE_BINDINGS_LIST_PATH,
  WORKJET_MANAGED_DEVICE_INVITES_CREATE_PATH,
  WORKJET_MANAGED_DEVICE_INVITES_REVOKE_PATH,
  WorkjetManagedBackendControlResolveInput,
  WorkjetManagedBackendControlResolveResult,
  WorkjetManagedDeviceInviteCreateInput,
} from "./workjetManagedBackendControl.ts";

const connectionId = "a".repeat(43);
const instanceId = "biz_welsch";

describe("Workjet managed Business OS backend control contract", () => {
  it("uses dedicated managed-control endpoints rather than environment routes", () => {
    expect(WORKJET_MANAGED_BACKEND_CONTROL_RESOLVE_PATH).toBe(
      "/api/workjet/backend-control/connections",
    );
    expect(WORKJET_MANAGED_DEVICE_BINDINGS_LIST_PATH).toBe(
      "/api/workjet/backend-control/device-bindings/list",
    );
    expect(WORKJET_MANAGED_DEVICE_INVITES_CREATE_PATH).toBe(
      "/api/workjet/backend-control/device-invites/create",
    );
    expect(WORKJET_MANAGED_DEVICE_INVITES_REVOKE_PATH).toBe(
      "/api/workjet/backend-control/device-invites/revoke",
    );
    expect(WORKJET_MANAGED_BACKEND_CONTROL_MAX_TTL_SECONDS).toBe(600);
    expect(WORKJET_MANAGED_BACKEND_CONTROL_RESPONSE_HEADERS).toEqual({
      "cache-control": "no-store",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
    });
  });

  it("resolves a short-lived connection for one canonical instance and installation", () => {
    expect(
      Schema.decodeUnknownSync(WorkjetManagedBackendControlResolveInput)({
        businessOsInstanceId: instanceId,
        workjetInstallationId: "desktop-michael",
      }),
    ).toEqual({
      businessOsInstanceId: instanceId,
      workjetInstallationId: "desktop-michael",
    });
    expect(
      Schema.decodeUnknownSync(WorkjetManagedBackendControlResolveResult)({
        backendControlConnectionId: connectionId,
        businessOsInstanceId: instanceId,
        expiresAt: "2026-08-27T04:00:00Z",
      }),
    ).toEqual({
      backendControlConnectionId: connectionId,
      businessOsInstanceId: instanceId,
      expiresAt: "2026-08-27T04:00:00Z",
    });
  });

  it("rejects weak handles and keeps managed invite creation free of routing fallbacks", () => {
    expect(() =>
      Schema.decodeUnknownSync(WorkjetManagedBackendControlResolveResult)({
        backendControlConnectionId: "short",
        businessOsInstanceId: instanceId,
        expiresAt: "2026-08-27T04:00:00Z",
      }),
    ).toThrow();

    const decoded = Schema.decodeUnknownSync(WorkjetManagedDeviceInviteCreateInput)({
      backendControlConnectionId: connectionId,
      businessOsInstanceId: instanceId,
      ttlSeconds: 300,
    });
    expect(Object.keys(decoded).toSorted()).toEqual([
      "backendControlConnectionId",
      "businessOsInstanceId",
      "ttlSeconds",
    ]);
    expect(decoded).not.toHaveProperty("environmentId");
    expect(decoded).not.toHaveProperty("connectionUrl");
    expect(decoded).not.toHaveProperty("invite");
  });
});
