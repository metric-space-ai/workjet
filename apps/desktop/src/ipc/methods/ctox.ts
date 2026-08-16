import {
  CtoxDiscoveryResult,
  CtoxGuestBoundsInput,
  CtoxManagedActionResult,
  CtoxManagedActivationInput,
  CtoxManagedGuestResult,
  CtoxManagedLoginResult,
  CtoxManualPairingImportInput,
  CtoxPairedInstanceImportResult,
  CtoxPairedInstanceRemoveInput,
  CtoxPairedInstanceRemoveResult,
  CtoxPairingInviteImportInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as CtoxDevAuth from "../../ctox/CtoxDevAuth.ts";
import * as CtoxElectronSessions from "../../ctox/CtoxElectronSessions.ts";
import * as CtoxGuestManager from "../../ctox/CtoxGuestManager.ts";
import * as CtoxInstanceRegistry from "../../ctox/CtoxInstanceRegistry.ts";
import * as IpcChannels from "../channels.ts";
import type * as DesktopIpc from "../DesktopIpc.ts";

function encodeSafe<A, I>(schema: Schema.Codec<A, I>, value: A): Effect.Effect<I> {
  return Schema.encodeUnknownEffect(schema)(value).pipe(Effect.orDie);
}

export const refresh: DesktopIpc.DesktopIpcMethod<
  never,
  CtoxDevAuth.CtoxDevAuth | CtoxInstanceRegistry.CtoxInstanceRegistry
> = {
  channel: IpcChannels.CTOX_REFRESH_CHANNEL,
  handler: () =>
    Effect.gen(function* () {
      const auth = yield* CtoxDevAuth.CtoxDevAuth;
      const registry = yield* CtoxInstanceRegistry.CtoxInstanceRegistry;
      const managed = yield* auth.refresh.pipe(
        Effect.orElseSucceed(() => ({ _tag: "failed", code: "network_error" }) as const),
      );
      return yield* encodeSafe(CtoxDiscoveryResult, yield* registry.merge(managed));
    }),
};

export const login: DesktopIpc.DesktopIpcMethod<
  never,
  CtoxDevAuth.CtoxDevAuth | CtoxInstanceRegistry.CtoxInstanceRegistry
> = {
  channel: IpcChannels.CTOX_LOGIN_CHANNEL,
  handler: () =>
    Effect.gen(function* () {
      const auth = yield* CtoxDevAuth.CtoxDevAuth;
      const registry = yield* CtoxInstanceRegistry.CtoxInstanceRegistry;
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
      const managed = yield* auth.refresh.pipe(
        Effect.orElseSucceed(() => ({ _tag: "failed", code: "network_error" }) as const),
      );
      return yield* encodeSafe(CtoxManagedLoginResult, {
        _tag: "completed",
        discovery: yield* registry.merge(managed),
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
        Effect.orElseSucceed(() => false),
      );
      return yield* encodeSafe(
        CtoxManagedActionResult,
        completed ? { _tag: "completed" } : { _tag: "failed", code: "authentication_failed" },
      );
    }),
};

export const importInvite: DesktopIpc.DesktopIpcMethod<
  never,
  CtoxInstanceRegistry.CtoxInstanceRegistry
> = {
  channel: IpcChannels.CTOX_IMPORT_INVITE_CHANNEL,
  handler: (raw) =>
    Effect.gen(function* () {
      const registry = yield* CtoxInstanceRegistry.CtoxInstanceRegistry;
      const input = yield* Schema.decodeUnknownEffect(CtoxPairingInviteImportInput)(raw, {
        onExcessProperty: "error",
      }).pipe(Effect.option);
      if (input._tag === "None") {
        return yield* encodeSafe(CtoxPairedInstanceImportResult, {
          _tag: "failed",
          code: "invalid_input",
        });
      }
      const result = yield* registry.importInvite(input.value.invite).pipe(Effect.result);
      return yield* encodeSafe(
        CtoxPairedInstanceImportResult,
        Result.isSuccess(result)
          ? { _tag: "completed", instance: result.success }
          : { _tag: "failed", code: result.failure.code },
      );
    }),
};

export const importManualPairing: DesktopIpc.DesktopIpcMethod<
  never,
  CtoxInstanceRegistry.CtoxInstanceRegistry
> = {
  channel: IpcChannels.CTOX_IMPORT_MANUAL_PAIRING_CHANNEL,
  handler: (raw) =>
    Effect.gen(function* () {
      const registry = yield* CtoxInstanceRegistry.CtoxInstanceRegistry;
      const input = yield* Schema.decodeUnknownEffect(CtoxManualPairingImportInput)(raw, {
        onExcessProperty: "error",
      }).pipe(Effect.option);
      if (input._tag === "None") {
        return yield* encodeSafe(CtoxPairedInstanceImportResult, {
          _tag: "failed",
          code: "invalid_input",
        });
      }
      const result = yield* registry.importManualPairing(input.value).pipe(Effect.result);
      return yield* encodeSafe(
        CtoxPairedInstanceImportResult,
        Result.isSuccess(result)
          ? { _tag: "completed", instance: result.success }
          : { _tag: "failed", code: result.failure.code },
      );
    }),
};

export const removePairedInstance: DesktopIpc.DesktopIpcMethod<
  never,
  | CtoxElectronSessions.CtoxElectronSessions
  | CtoxGuestManager.CtoxGuestManager
  | CtoxInstanceRegistry.CtoxInstanceRegistry
> = {
  channel: IpcChannels.CTOX_REMOVE_PAIRED_INSTANCE_CHANNEL,
  handler: (raw) =>
    Effect.gen(function* () {
      const registry = yield* CtoxInstanceRegistry.CtoxInstanceRegistry;
      const input = yield* Schema.decodeUnknownEffect(CtoxPairedInstanceRemoveInput)(raw, {
        onExcessProperty: "error",
      }).pipe(Effect.option);
      if (input._tag === "None") {
        return yield* encodeSafe(CtoxPairedInstanceRemoveResult, {
          _tag: "failed",
          code: "invalid_input",
        });
      }
      const removal = yield* registry
        .removePairedInstance(input.value.instanceId)
        .pipe(Effect.result);
      if (Result.isFailure(removal)) {
        return yield* encodeSafe(CtoxPairedInstanceRemoveResult, {
          _tag: "failed",
          code: removal.failure.code,
        });
      }

      const guests = yield* CtoxGuestManager.CtoxGuestManager;
      const sessions = yield* CtoxElectronSessions.CtoxElectronSessions;
      const cleanup = yield* Effect.exit(
        Effect.gen(function* () {
          const deactivation = yield* guests.deactivateInstance(removal.success.id);
          if (deactivation._tag !== "completed") return yield* Effect.fail(undefined);
          yield* sessions.clearInstance(removal.success);
        }),
      );
      return yield* encodeSafe(
        CtoxPairedInstanceRemoveResult,
        Exit.isSuccess(cleanup)
          ? { _tag: "completed" }
          : { _tag: "failed", code: "persistence_failed" },
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

type CtoxIpcServices =
  | CtoxDevAuth.CtoxDevAuth
  | CtoxElectronSessions.CtoxElectronSessions
  | CtoxGuestManager.CtoxGuestManager
  | CtoxInstanceRegistry.CtoxInstanceRegistry;

export const methods: readonly DesktopIpc.DesktopIpcMethod<never, CtoxIpcServices>[] = [
  refresh,
  login,
  logout,
  importInvite,
  importManualPairing,
  removePairedInstance,
  activate,
  deactivate,
  setGuestBounds,
];
