import {
  CtoxGuestBoundsInput,
  CtoxManagedActionResult,
  CtoxManagedActivationInput,
  CtoxManagedDiscoveryResult,
  CtoxManagedGuestResult,
  CtoxManagedLoginResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as CtoxDevAuth from "../../ctox/CtoxDevAuth.ts";
import * as CtoxGuestManager from "../../ctox/CtoxGuestManager.ts";
import * as IpcChannels from "../channels.ts";
import type * as DesktopIpc from "../DesktopIpc.ts";

function encodeSafe<A, I>(schema: Schema.Codec<A, I>, value: A): Effect.Effect<I> {
  return Schema.encodeUnknownEffect(schema)(value).pipe(Effect.orDie);
}

export const refresh: DesktopIpc.DesktopIpcMethod<never, CtoxDevAuth.CtoxDevAuth> = {
  channel: IpcChannels.CTOX_REFRESH_CHANNEL,
  handler: () =>
    Effect.gen(function* () {
      const auth = yield* CtoxDevAuth.CtoxDevAuth;
      const result = yield* auth.refresh.pipe(
        Effect.catch(() => Effect.succeed({ _tag: "failed", code: "network_error" } as const)),
      );
      return yield* encodeSafe(CtoxManagedDiscoveryResult, result);
    }),
};

export const login: DesktopIpc.DesktopIpcMethod<never, CtoxDevAuth.CtoxDevAuth> = {
  channel: IpcChannels.CTOX_LOGIN_CHANNEL,
  handler: () =>
    Effect.gen(function* () {
      const auth = yield* CtoxDevAuth.CtoxDevAuth;
      const loginResult = yield* auth.login.pipe(Effect.option);
      if (loginResult._tag === "None") {
        return yield* encodeSafe(CtoxManagedLoginResult, {
          _tag: "failed",
          code: "authentication_failed",
        });
      }
      if (loginResult.value._tag === "not_completed") {
        return yield* encodeSafe(CtoxManagedLoginResult, {
          _tag: "cancelled",
          reason: loginResult.value.reason,
        });
      }
      const discovery = yield* auth.refresh.pipe(Effect.option);
      if (discovery._tag === "None") {
        return yield* encodeSafe(CtoxManagedLoginResult, {
          _tag: "failed",
          code: "authentication_failed",
        });
      }
      return yield* encodeSafe(CtoxManagedLoginResult, {
        _tag: "completed",
        discovery: discovery.value,
      });
    }),
};

export const logout: DesktopIpc.DesktopIpcMethod<
  never,
  CtoxDevAuth.CtoxDevAuth | CtoxGuestManager.CtoxGuestManager
> = {
  channel: IpcChannels.CTOX_LOGOUT_CHANNEL,
  handler: () =>
    Effect.gen(function* () {
      const auth = yield* CtoxDevAuth.CtoxDevAuth;
      const guests = yield* CtoxGuestManager.CtoxGuestManager;
      yield* guests.deactivate;
      const completed = yield* auth.logout.pipe(
        Effect.as(true),
        Effect.catch(() => Effect.succeed(false)),
      );
      return yield* encodeSafe(
        CtoxManagedActionResult,
        completed ? { _tag: "completed" } : { _tag: "failed", code: "authentication_failed" },
      );
    }),
};

export const activate: DesktopIpc.DesktopIpcMethod<never, CtoxGuestManager.CtoxGuestManager> = {
  channel: IpcChannels.CTOX_ACTIVATE_CHANNEL,
  handler: (raw) =>
    Effect.gen(function* () {
      const guests = yield* CtoxGuestManager.CtoxGuestManager;
      const input = yield* Schema.decodeUnknownEffect(CtoxManagedActivationInput)(raw).pipe(
        Effect.option,
      );
      const result =
        input._tag === "None"
          ? ({ _tag: "failed", code: "invalid_input" } as const)
          : yield* guests.activate(input.value.instanceId, input.value.bounds);
      return yield* encodeSafe(CtoxManagedGuestResult, result);
    }),
};

export const deactivate: DesktopIpc.DesktopIpcMethod<never, CtoxGuestManager.CtoxGuestManager> = {
  channel: IpcChannels.CTOX_DEACTIVATE_CHANNEL,
  handler: () =>
    Effect.gen(function* () {
      const guests = yield* CtoxGuestManager.CtoxGuestManager;
      return yield* guests.deactivate.pipe(
        Effect.flatMap((result) => encodeSafe(CtoxManagedActionResult, result)),
      );
    }),
};

export const setGuestBounds: DesktopIpc.DesktopIpcMethod<never, CtoxGuestManager.CtoxGuestManager> =
  {
    channel: IpcChannels.CTOX_SET_GUEST_BOUNDS_CHANNEL,
    handler: (raw) =>
      Effect.gen(function* () {
        const guests = yield* CtoxGuestManager.CtoxGuestManager;
        const input = yield* Schema.decodeUnknownEffect(CtoxGuestBoundsInput)(raw).pipe(
          Effect.option,
        );
        const result =
          input._tag === "None"
            ? ({ _tag: "failed", code: "invalid_input" } as const)
            : yield* guests.setBounds(input.value.bounds);
        return yield* encodeSafe(CtoxManagedActionResult, result);
      }),
  };

export const methods = [refresh, login, logout, activate, deactivate, setGuestBounds] as const;
