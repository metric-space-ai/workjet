import { describe, expect, it } from "vite-plus/test";

import { CtoxMobileInviteCreateInput, CtoxMobileInviteCreateResult } from "./ctox.ts";
import {
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  EnvironmentResourceNotFoundError,
  EnvironmentScopeRequiredError,
} from "./environmentHttp.ts";
import * as Schema from "effect/Schema";

const traceId = "trace-1";

describe("environment HTTP errors", () => {
  // A client squashes the cause and shows `message`; an empty one becomes a generic
  // "The environment request failed." that names nothing the reader can act on.
  it("each carries a message that names its reason", () => {
    const errors = [
      new EnvironmentRequestInvalidError({
        code: "invalid_request",
        reason: "invalid_command",
        traceId,
      }),
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "missing_credential",
        traceId,
      }),
      new EnvironmentScopeRequiredError({
        code: "insufficient_scope",
        requiredScope: "orchestration:read",
        traceId,
      }),
      new EnvironmentOperationForbiddenError({
        code: "operation_forbidden",
        reason: "current_session_revoke_not_allowed",
        traceId,
      }),
      new EnvironmentResourceNotFoundError({
        code: "not_found",
        reason: "thread_not_found",
        traceId,
      }),
      new EnvironmentInternalError({
        code: "internal_error",
        reason: "orchestration_snapshot_failed",
        traceId,
      }),
    ] as const;
    const details = [
      "invalid_command",
      "missing_credential",
      "orchestration:read",
      "current_session_revoke_not_allowed",
      "thread_not_found",
      "orchestration_snapshot_failed",
    ];
    errors.forEach((error, index) => {
      expect(error.message).toContain(details[index]);
    });
  });
});

describe("Business OS mobile invite HTTP contract", () => {
  it("accepts a bounded short-lived RxDB/WebRTC invite", () => {
    expect(Schema.decodeUnknownSync(CtoxMobileInviteCreateInput)({ ttlSeconds: 300 })).toEqual({
      ttlSeconds: 300,
    });
    expect(() =>
      Schema.decodeUnknownSync(CtoxMobileInviteCreateInput)({ ttlSeconds: 59 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CtoxMobileInviteCreateInput)({ ttlSeconds: 3_601 }),
    ).toThrow();

    const expiresAt = "2099-08-25T12:05:00.000Z";
    const result = Schema.decodeUnknownSync(CtoxMobileInviteCreateResult)({
      inviteId: "opaque-id",
      expiresAt,
      invite: {
        type: "ctox-business-os-invite",
        version: 1,
        display_name: "Operations",
        instance_id: "instance-a",
        sync_room: "ctox-business-os:instance-a",
        native_peer_id: "native-a",
        signaling_urls: ["wss://signaling.ctox.dev/v2"],
        signaling_room_password: "not-a-production-secret",
        transport: "webrtc",
        expires_at: expiresAt,
        data_plane: "rxdb-webrtc",
        http_bridge_available: false,
        session: {
          authenticated: true,
          source: "mobile_invite",
          capability_token: "synthetic-capability",
          capability_expires_at_ms: Date.parse(expiresAt),
          user: {
            id: "workjet-mobile-invite-a",
            display_name: "Workjet Mobile",
            role: "user",
            is_admin: false,
          },
        },
      },
    });
    expect(result.invite.data_plane).toBe("rxdb-webrtc");
    expect(result.invite.http_bridge_available).toBe(false);
  });
});
