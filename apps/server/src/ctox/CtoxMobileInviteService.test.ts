// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as MobileInvites from "./CtoxMobileInviteService.ts";

const encoder = new TextEncoder();

function inviteResult(overrides: Record<string, unknown> = {}) {
  const expiresAt = "2099-08-25T12:05:00.000Z";
  return {
    inviteId: "opaque-invite-id",
    expiresAt,
    invite: {
      type: "ctox-business-os-invite",
      version: 1,
      display_name: "Operations",
      instance_id: "instance-a",
      sync_room: "ctox-business-os:instance-a",
      native_peer_id: "native-a",
      signaling_urls: ["wss://signaling.ctox.dev/v2"],
      signaling_room_password: "room-secret-canary",
      transport: "webrtc",
      expires_at: expiresAt,
      data_plane: "rxdb-webrtc",
      http_bridge_available: false,
      secret_value_in_payload: true,
      session: {
        authenticated: true,
        source: "mobile_invite",
        capability_token: "capability-secret-canary",
        capability_expires_at_ms: Date.parse(expiresAt),
        user: {
          id: "workjet-mobile-invite-a",
          display_name: "Workjet Mobile",
          role: "user",
          is_admin: false,
        },
      },
    },
    ...overrides,
  };
}

function handle(stdout: string, code = 0) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function harness(
  responder: (args: ReadonlyArray<string>) => { readonly stdout: string; readonly code?: number },
) {
  const spawner = ChildProcessSpawner.make((command) => {
    const child = command as unknown as { readonly args: ReadonlyArray<string> };
    const response = responder(child.args);
    return Effect.succeed(handle(response.stdout, response.code));
  });
  return MobileInvites.layer({
    env: {},
    nowEpochMs: () => Date.parse("2026-08-25T12:00:00.000Z"),
  }).pipe(Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)));
}

describe("CtoxMobileInviteService", () => {
  it.effect("creates and revokes through the bounded native CLI contract", () => {
    const commands: ReadonlyArray<string>[] = [];
    const layer = harness((args) => {
      commands.push(args);
      return {
        stdout: JSON.stringify(args.includes("revoke") ? { revoked: true } : inviteResult()),
      };
    });
    return Effect.gen(function* () {
      const service = yield* MobileInvites.CtoxMobileInviteService;
      const created = yield* service.create(300);
      assert.equal(created.invite.session.user.role, "user");
      assert.equal(created.invite.http_bridge_available, false);
      assert.deepEqual(yield* service.revoke(created.inviteId), { revoked: true });
      assert.deepEqual(commands, [
        ["business-os", "mobile-invite", "create", "--ttl-seconds", "300"],
        ["business-os", "mobile-invite", "revoke", "--invite-id", "opaque-invite-id"],
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails closed for expired native output without echoing secrets", () => {
    const expired = inviteResult({
      expiresAt: "2020-01-01T00:00:00.000Z",
      invite: {
        ...inviteResult().invite,
        expires_at: "2020-01-01T00:00:00.000Z",
        session: {
          ...inviteResult().invite.session,
          capability_expires_at_ms: Date.parse("2020-01-01T00:00:00.000Z"),
        },
      },
    });
    return Effect.gen(function* () {
      const service = yield* MobileInvites.CtoxMobileInviteService;
      const error = yield* Effect.flip(service.create(300));
      assert.equal(error.reason, "invalid_response");
      assert.notInclude(error.message, "room-secret-canary");
      assert.notInclude(error.message, "capability-secret-canary");
    }).pipe(Effect.provide(harness(() => ({ stdout: JSON.stringify(expired) }))));
  });
});
