// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expect, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as CtoxDevAuth from "../../ctox/CtoxDevAuth.ts";
import * as CtoxGuestManager from "../../ctox/CtoxGuestManager.ts";
import { activate, refresh } from "./ctox.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

describe("CTOX IPC methods", () => {
  it.effect("rejects malformed activation input before calling the guest manager", () => {
    const activateGuest = vi.fn(() => Effect.succeed({ _tag: "ready" as const, instanceId: "x" }));
    const guests = CtoxGuestManager.CtoxGuestManager.of({
      activate: activateGuest,
      deactivate: Effect.succeed({ _tag: "completed" }),
      setBounds: () => Effect.succeed({ _tag: "completed" }),
    });

    return Effect.gen(function* () {
      const result = yield* activate.handler({
        instanceId: "managed:tenant",
        bounds: { x: -1, y: 0, width: 800, height: 600 },
        launchUrl: "https://ctox.dev/?ctox_config=secret",
      });
      assert.deepEqual(result, { _tag: "failed", code: "invalid_input" });
      expect(activateGuest).not.toHaveBeenCalled();
      assert.notInclude(encodeUnknownJson(result), "secret");
    }).pipe(Effect.provide(Layer.succeed(CtoxGuestManager.CtoxGuestManager, guests)));
  });

  it.effect("returns only the redacted discovery failure when account refresh fails", () => {
    const auth = CtoxDevAuth.CtoxDevAuth.of({
      refresh: Effect.fail(
        new CtoxDevAuth.CtoxDevAuthOperationError({ operation: "account-session" }),
      ),
      login: Effect.die("unused"),
      logout: Effect.void,
    });

    return Effect.gen(function* () {
      const result = yield* refresh.handler(undefined);
      assert.deepEqual(result, { _tag: "failed", code: "network_error" });
      assert.notInclude(encodeUnknownJson(result), "secret");
    }).pipe(Effect.provide(Layer.succeed(CtoxDevAuth.CtoxDevAuth, auth)));
  });
});
