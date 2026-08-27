import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  WORKJET_MANAGED_BACKEND_CONTROL_MAX_TTL_SECONDS,
  WORKJET_MANAGED_BACKEND_CONTROL_RESPONSE_HEADERS,
  WORKJET_MANAGED_BACKEND_CONTROL_RESOLVE_PATH,
  WORKJET_MANAGED_DEVICE_CONTROL_CSRF_PATH,
  WORKJET_MANAGED_DEVICE_CONTROL_RESOLVE_PATH,
  WORKJET_MANAGED_DEVICE_BINDINGS_LIST_PATH,
  WORKJET_MANAGED_DEVICE_BINDINGS_REVOKE_PATH,
  WORKJET_MANAGED_DEVICE_INVITES_CREATE_PATH,
  WORKJET_MANAGED_DEVICE_INVITES_REDEEM_PATH,
  WORKJET_MANAGED_DEVICE_INVITES_REVOKE_PATH,
  WORKJET_RELAY_CONTROL_IDENTITY_ASSERTION_PATH,
  WORKJET_DEVICE_SESSION_BOOTSTRAP_EXCHANGE_PATH,
  WORKJET_DEVICE_SESSION_MEMBERSHIP_READ_PATH,
  WORKJET_DEVICE_SESSION_RENEW_PATH,
  WorkjetManagedBackendControlResolveInput,
  WorkjetManagedBackendControlResolveResult,
  WorkjetManagedControlCsrfResult,
  WorkjetManagedDeviceControlCsrfHeaders,
  WorkjetManagedDeviceControlCsrfInput,
  WorkjetManagedDeviceControlResolveHeaders,
  WorkjetManagedDeviceControlResolveInput,
  WorkjetManagedCtoxSyncInviteIssueInput,
  WorkjetManagedDeviceBindingRecordV1,
  WorkjetManagedDeviceInviteCreateInput,
  WorkjetManagedDeviceSessionIssueInput,
  WorkjetManagedDeviceSessionIssueResult,
  WorkjetRelayControlIdentityAssertionIssueInput,
  WorkjetRelayControlIdentityAssertionIssueResult,
  WorkjetDeviceSessionBootstrapExchangeInput,
  WorkjetDeviceSessionBootstrapExchangeResult,
  WorkjetDeviceSessionRenewInput,
  WorkjetDeviceSessionRenewResult,
  WorkjetDeviceInviteV2,
  WorkjetDeviceSessionMembershipReadResult,
} from "./workjetManagedBackendControl.ts";

const connectionId = "a".repeat(43);
const instanceId = "biz_welsch";
const relayIdentityAssertion = `${"a".repeat(43)}.${"b".repeat(43)}.${"c".repeat(43)}`;

describe("Workjet managed Business OS backend control contract", () => {
  it("uses dedicated managed-control endpoints rather than environment routes", () => {
    expect(WORKJET_MANAGED_BACKEND_CONTROL_RESOLVE_PATH).toBe(
      "/api/workjet/backend-control/connections",
    );
    expect(WORKJET_MANAGED_DEVICE_CONTROL_RESOLVE_PATH).toBe(
      "/api/workjet/backend-control/device-connections",
    );
    expect(WORKJET_MANAGED_DEVICE_CONTROL_CSRF_PATH).toBe(
      "/api/workjet/backend-control/device-csrf",
    );
    expect(WORKJET_MANAGED_DEVICE_BINDINGS_LIST_PATH).toBe(
      "/api/workjet/backend-control/device-bindings/list",
    );
    expect(WORKJET_MANAGED_DEVICE_BINDINGS_REVOKE_PATH).toBe(
      "/api/workjet/backend-control/device-bindings/revoke",
    );
    expect(WORKJET_MANAGED_DEVICE_INVITES_CREATE_PATH).toBe(
      "/api/workjet/backend-control/device-invites/create",
    );
    expect(WORKJET_MANAGED_DEVICE_INVITES_REVOKE_PATH).toBe(
      "/api/workjet/backend-control/device-invites/revoke",
    );
    expect(WORKJET_MANAGED_DEVICE_INVITES_REDEEM_PATH).toBe("/api/workjet/device-invites/redeem");
    expect(WORKJET_DEVICE_SESSION_BOOTSTRAP_EXCHANGE_PATH).toBe(
      "/api/workjet/device-session/exchange",
    );
    expect(WORKJET_DEVICE_SESSION_RENEW_PATH).toBe("/api/workjet/device-session/renew");
    expect(WORKJET_DEVICE_SESSION_MEMBERSHIP_READ_PATH).toBe(
      "/api/workjet/device-session/business-os/computers",
    );
    expect(WORKJET_RELAY_CONTROL_IDENTITY_ASSERTION_PATH).toBe(
      "/api/workjet/device-session/control-assertion",
    );
    expect(WORKJET_MANAGED_BACKEND_CONTROL_MAX_TTL_SECONDS).toBe(600);
    expect(WORKJET_MANAGED_BACKEND_CONTROL_RESPONSE_HEADERS).toEqual({
      "cache-control": "no-store",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
    });
  });

  it("defines cookie-free device control with DPoP and handle-bound CSRF", () => {
    const resolveInput = {
      businessOsInstanceId: instanceId,
      workjetInstallationId: "fold-8",
      relayIdentityAssertion,
    };
    expect(Schema.decodeUnknownSync(WorkjetManagedDeviceControlResolveInput)(resolveInput)).toEqual(
      resolveInput,
    );
    expect(
      Schema.decodeUnknownSync(WorkjetManagedDeviceControlResolveHeaders)({
        dpop: "proof",
      }),
    ).toEqual({ dpop: "proof" });
    expect(
      Schema.decodeUnknownSync(WorkjetManagedDeviceControlCsrfInput)({
        backendControlConnectionId: connectionId,
        businessOsInstanceId: instanceId,
      }),
    ).toEqual({
      backendControlConnectionId: connectionId,
      businessOsInstanceId: instanceId,
    });
    expect(
      Schema.decodeUnknownSync(WorkjetManagedDeviceControlCsrfHeaders)({ dpop: "proof" }),
    ).toEqual({ dpop: "proof" });
    expect(
      Schema.decodeUnknownSync(WorkjetManagedControlCsrfResult)({
        ok: true,
        csrfToken: "v1.payload.signature",
        expiresAt: "2026-08-27T04:00:00Z",
      }),
    ).toEqual({
      ok: true,
      csrfToken: "v1.payload.signature",
      expiresAt: "2026-08-27T04:00:00Z",
    });
  });

  it("resolves a short-lived connection for one canonical instance and installation", () => {
    expect(
      Schema.decodeUnknownSync(WorkjetManagedBackendControlResolveInput)({
        businessOsInstanceId: instanceId,
        workjetInstallationId: "desktop-michael",
        relayIdentityAssertion,
      }),
    ).toEqual({
      businessOsInstanceId: instanceId,
      workjetInstallationId: "desktop-michael",
      relayIdentityAssertion,
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

  it("requires a short Relay-signed identity assertion for control resolution", () => {
    expect(
      Schema.decodeUnknownSync(WorkjetRelayControlIdentityAssertionIssueInput)({
        audience: "ctox.dev",
        workjetInstallationId: "desktop-michael",
        businessOsInstanceId: instanceId,
      }),
    ).toEqual({
      audience: "ctox.dev",
      workjetInstallationId: "desktop-michael",
      businessOsInstanceId: instanceId,
    });
    expect(
      Schema.decodeUnknownSync(WorkjetRelayControlIdentityAssertionIssueResult)({
        assertion: relayIdentityAssertion,
        expiresAt: "2026-08-27T04:00:00Z",
      }),
    ).toEqual({ assertion: relayIdentityAssertion, expiresAt: "2026-08-27T04:00:00Z" });
    expect(() =>
      Schema.decodeUnknownSync(WorkjetManagedBackendControlResolveInput)({
        businessOsInstanceId: instanceId,
        workjetInstallationId: "desktop-michael",
        relayIdentityAssertion: "client-asserted-user-id",
      }),
    ).toThrow();
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

  it("provisions one instance session plus CTOX sync without choosing a Code computer", () => {
    const provisioningInput = {
      businessOsInstanceId: instanceId,
      devicePairingId: "pairing-1",
      deviceId: "fold-8",
      proofKeyThumbprint: "c".repeat(43),
      ttlSeconds: 300,
    };
    expect(
      Schema.decodeUnknownSync(WorkjetManagedDeviceSessionIssueInput)(provisioningInput),
    ).toEqual(provisioningInput);
    expect(
      Schema.decodeUnknownSync(WorkjetManagedCtoxSyncInviteIssueInput)(provisioningInput),
    ).toEqual(provisioningInput);
    expect(provisioningInput).not.toHaveProperty("environmentId");
  });

  it("accepts only a trusted issuer origin", () => {
    const validResult = {
      grantId: "d".repeat(43),
      businessOsInstanceId: instanceId,
      deviceId: "fold-8",
      proofKeyThumbprint: "c".repeat(43),
      issuer: "https://control.ctox.dev",
      bootstrapCredential: "f".repeat(43),
      expiresAt: "2026-08-27T04:00:00Z",
    };
    expect(Schema.decodeUnknownSync(WorkjetManagedDeviceSessionIssueResult)(validResult)).toEqual(
      validResult,
    );
    expect(
      Schema.decodeUnknownSync(WorkjetManagedDeviceSessionIssueResult)({
        ...validResult,
        issuer: "http://127.0.0.1:13773",
      }).issuer,
    ).toBe("http://127.0.0.1:13773");

    for (const issuer of [
      "http://ctox.dev",
      "https://user:pass@ctox.dev",
      "https://ctox.dev/path",
      "https://ctox.dev?tenant=welsch",
      "https://ctox.dev#fragment",
      "not-a-url",
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(WorkjetManagedDeviceSessionIssueResult)({
          ...validResult,
          issuer,
        }),
      ).toThrow();
    }
  });

  it("defines a one-time DPoP-bound bootstrap exchange instead of a bearer credential", () => {
    expect(
      Schema.decodeUnknownSync(WorkjetDeviceSessionBootstrapExchangeInput)({
        bootstrapCredential: "f".repeat(43),
        deviceId: "fold-8",
        businessOsInstanceId: instanceId,
      }),
    ).toEqual({
      bootstrapCredential: "f".repeat(43),
      deviceId: "fold-8",
      businessOsInstanceId: instanceId,
    });
    expect(
      Schema.decodeUnknownSync(WorkjetDeviceSessionBootstrapExchangeResult)({
        tokenType: "DPoP",
        accessToken: "g".repeat(43),
        refreshGrant: "h".repeat(43),
        relayIssuer: "https://relay.ctox.dev",
        relayScopes: ["environment:connect", "environment:status"],
        businessOsInstanceId: instanceId,
        deviceId: "fold-8",
        expiresAt: "2026-08-27T04:00:00Z",
        refreshExpiresAt: "2026-09-26T04:00:00Z",
      }),
    ).toEqual({
      tokenType: "DPoP",
      accessToken: "g".repeat(43),
      refreshGrant: "h".repeat(43),
      relayIssuer: "https://relay.ctox.dev",
      relayScopes: ["environment:connect", "environment:status"],
      businessOsInstanceId: instanceId,
      deviceId: "fold-8",
      expiresAt: "2026-08-27T04:00:00Z",
      refreshExpiresAt: "2026-09-26T04:00:00Z",
    });
    expect(() =>
      Schema.decodeUnknownSync(WorkjetDeviceSessionBootstrapExchangeResult)({
        tokenType: "DPoP",
        accessToken: "g".repeat(43),
        refreshGrant: "h".repeat(43),
        relayIssuer: "https://relay.ctox.dev",
        relayScopes: ["environment:status"],
        businessOsInstanceId: instanceId,
        deviceId: "fold-8",
        expiresAt: "2026-08-27T04:00:00Z",
        refreshExpiresAt: "2026-09-26T04:00:00Z",
      }),
    ).toThrow();
  });

  it("rotates a DPoP-bound refresh grant without repeating pairing", () => {
    expect(
      Schema.decodeUnknownSync(WorkjetDeviceSessionRenewInput)({
        refreshGrant: "h".repeat(43),
        deviceId: "fold-8",
        businessOsInstanceId: instanceId,
      }),
    ).toEqual({
      refreshGrant: "h".repeat(43),
      deviceId: "fold-8",
      businessOsInstanceId: instanceId,
    });
    const renewed = Schema.decodeUnknownSync(WorkjetDeviceSessionRenewResult)({
      tokenType: "DPoP",
      accessToken: "i".repeat(43),
      refreshGrant: "j".repeat(43),
      relayIssuer: "https://relay.ctox.dev",
      relayScopes: ["environment:connect", "environment:status"],
      businessOsInstanceId: instanceId,
      deviceId: "fold-8",
      expiresAt: "2026-08-27T05:00:00Z",
      refreshExpiresAt: "2026-09-26T05:00:00Z",
    });
    expect(renewed.refreshGrant).not.toBe("h".repeat(43));
    expect(renewed).not.toHaveProperty("bootstrapCredential");
  });

  it("returns an instance-scoped v2 session and resolves current membership separately", () => {
    const invite = Schema.decodeUnknownSync(WorkjetDeviceInviteV2)({
      type: "workjet-device-invite",
      version: 2,
      device_pairing_id: "pairing-1",
      business_os_instance_id: instanceId,
      workjet_session: {
        issuer: "https://ctox.dev",
        bootstrap_credential: "f".repeat(43),
        expires_at: "2026-08-27T04:00:00Z",
      },
      business_os: {
        type: "ctox-business-os-invite",
        version: 1,
        display_name: "WELSCH",
        instance_id: instanceId,
        sync_room: "ctox-business-os:biz_welsch",
        native_peer_id: "native-welsch",
        signaling_urls: ["wss://signaling.ctox.dev/v2"],
        signaling_room_password: "room-secret",
        transport: "webrtc",
        expires_at: "2026-08-27T04:00:00Z",
        data_plane: "rxdb-webrtc",
        http_bridge_available: false,
        session: {
          authenticated: true,
          source: "mobile_invite",
          capability_token: "capability-secret",
          capability_expires_at_ms: Date.parse("2026-08-27T04:00:00Z"),
          user: {
            id: "workjet-fold-8",
            display_name: "Fold 8",
            role: "user",
            is_admin: false,
          },
        },
      },
    });
    expect(invite).not.toHaveProperty("environment");
    expect(invite).not.toHaveProperty("code_environments");

    expect(
      Schema.decodeUnknownSync(WorkjetDeviceSessionMembershipReadResult)({
        businessOsInstanceId: instanceId,
        membershipVersion: 7,
        environmentIds: ["macbook", "gpu3"],
      }),
    ).toEqual({
      businessOsInstanceId: instanceId,
      membershipVersion: 7,
      environmentIds: ["macbook", "gpu3"],
    });
  });

  it("persists only revocable grant ids and no returned secrets", () => {
    const edge = Schema.decodeUnknownSync(WorkjetManagedDeviceBindingRecordV1)({
      type: "workjet-managed-device-binding",
      version: 1,
      devicePairingId: "pairing-1",
      deviceId: "fold-8",
      proofKeyThumbprint: "c".repeat(43),
      businessOsInstanceId: instanceId,
      deviceSessionGrantId: "d".repeat(43),
      ctoxGrantId: "e".repeat(43),
      state: "active",
      createdAt: "2026-08-27T04:00:00Z",
      revokedAt: null,
    });
    expect(edge).not.toHaveProperty("bootstrapCredential");
    expect(edge).not.toHaveProperty("invite");
    expect(edge).not.toHaveProperty("roomSecret");
  });
});
