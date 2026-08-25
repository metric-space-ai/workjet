import {
  CtoxAppActionResult,
  CtoxHostThemeInput,
  CtoxDiscoveryResult,
  CtoxDecisionHubDisconnectInput,
  CtoxDecisionHubDisconnectResult,
  CtoxDecisionHubProvisionInput,
  CtoxDecisionHubProvisionResult,
  CtoxGuestBoundsInput,
  CtoxInstanceAppsInput,
  CtoxInstanceAppsResult,
  CtoxManagedActionResult,
  CtoxManagedActivationInput,
  CtoxManagedGuestResult,
  CtoxManagedLoginResult,
  CtoxManualPairingImportInput,
  CtoxOpenAppInput,
  CtoxPairedInstanceImportResult,
  CtoxPairedInstanceRemoveInput,
  CtoxPairedInstanceRemoveResult,
  CtoxPairingInviteImportInput,
  CtoxSetAppDockedInput,
  CtoxSshManagedInstanceAddInput,
  CtoxSshManagedInstanceAddResult,
  CtoxSshManagedInstanceRemoveInput,
  CtoxSshManagedInstanceRemoveResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as CtoxAppRail from "../../ctox/CtoxAppRail.ts";
import * as CtoxDevAuth from "../../ctox/CtoxDevAuth.ts";
import * as CtoxDecisionHubProvisioner from "../../ctox/CtoxDecisionHubProvisioner.ts";
import * as CtoxElectronSessions from "../../ctox/CtoxElectronSessions.ts";
import * as CtoxGuestManager from "../../ctox/CtoxGuestManager.ts";
import * as CtoxInstanceRegistry from "../../ctox/CtoxInstanceRegistry.ts";
import * as IpcChannels from "../channels.ts";
import type * as DesktopIpc from "../DesktopIpc.ts";

function encodeSafe<A, I>(schema: Schema.Codec<A, I>, value: A): Effect.Effect<I> {
  return Schema.encodeUnknownEffect(schema)(value).pipe(Effect.orDie);
}

const RAIL_INSTANCE_KEY_PREFIX = "instance:";

/**
 * The renderer only ever supplies the registry id, which a paired instance
 * loses when it is removed and paired again. Resolve the stable identity of a
 * paired instance in the main process; managed ids are already stable, and an
 * unresolvable id degrades to the rail key it had before.
 */
const railKeyFor = Effect.fn("ctox.railKeyFor")(function* (instanceId: string) {
  const fallback: CtoxAppRail.CtoxRailInstanceKey = {
    identity: `${RAIL_INSTANCE_KEY_PREFIX}${instanceId}`,
    legacyInstanceId: instanceId,
  };
  if (!instanceId.startsWith("paired:")) return fallback;
  const registry = yield* CtoxInstanceRegistry.CtoxInstanceRegistry;
  const identity = yield* registry
    .stableIdentityKey(instanceId)
    .pipe(Effect.orElseSucceed(() => undefined));
  return identity === undefined ? fallback : { identity, legacyInstanceId: instanceId };
});

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
  | CtoxDevAuth.CtoxDevAuth
  | CtoxGuestManager.CtoxGuestManager
  | CtoxDecisionHubProvisioner.CtoxDecisionHubProvisioner
> = {
  channel: IpcChannels.CTOX_LOGOUT_CHANNEL,
  handler: () =>
    Effect.gen(function* () {
      const auth = yield* CtoxDevAuth.CtoxDevAuth;
      const guests = yield* CtoxGuestManager.CtoxGuestManager;
      const decisionHub = yield* CtoxDecisionHubProvisioner.CtoxDecisionHubProvisioner;
      yield* guests.deactivate;
      yield* decisionHub.revokeAll;
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

export const provisionDecisionHub: DesktopIpc.DesktopIpcMethod<
  never,
  CtoxDecisionHubProvisioner.CtoxDecisionHubProvisioner
> = {
  channel: IpcChannels.CTOX_PROVISION_DECISION_HUB_CHANNEL,
  handler: (raw) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(CtoxDecisionHubProvisionInput)(raw, {
        onExcessProperty: "error",
      }).pipe(Effect.option);
      if (input._tag === "None") {
        return yield* encodeSafe(CtoxDecisionHubProvisionResult, {
          _tag: "failed",
          code: "invalid_input",
        });
      }
      const provisioner = yield* CtoxDecisionHubProvisioner.CtoxDecisionHubProvisioner;
      return yield* encodeSafe(
        CtoxDecisionHubProvisionResult,
        yield* provisioner.provision(input.value),
      );
    }),
};

export const disconnectDecisionHub: DesktopIpc.DesktopIpcMethod<
  never,
  CtoxDecisionHubProvisioner.CtoxDecisionHubProvisioner
> = {
  channel: IpcChannels.CTOX_DISCONNECT_DECISION_HUB_CHANNEL,
  handler: (raw) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(CtoxDecisionHubDisconnectInput)(raw, {
        onExcessProperty: "error",
      }).pipe(Effect.option);
      if (input._tag === "None") {
        return yield* encodeSafe(CtoxDecisionHubDisconnectResult, {
          _tag: "failed",
          code: "invalid_input",
        });
      }
      const provisioner = yield* CtoxDecisionHubProvisioner.CtoxDecisionHubProvisioner;
      return yield* encodeSafe(
        CtoxDecisionHubDisconnectResult,
        yield* provisioner.disconnect(input.value),
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
          const deactivation = yield* guests.deactivateInstance(removal.success.descriptor.id);
          if (deactivation._tag !== "completed") return yield* Effect.fail(undefined);
          yield* sessions.clearInstance(removal.success.descriptor);
        }),
      );
      return yield* encodeSafe(
        CtoxPairedInstanceRemoveResult,
        removal.success.secretRecordRemoved && Exit.isSuccess(cleanup)
          ? { _tag: "completed" }
          : { _tag: "failed", code: "persistence_failed" },
      );
    }),
};

export const addSshManagedInstance: DesktopIpc.DesktopIpcMethod<
  never,
  CtoxInstanceRegistry.CtoxInstanceRegistry
> = {
  channel: IpcChannels.CTOX_ADD_SSH_MANAGED_INSTANCE_CHANNEL,
  handler: (raw) =>
    Effect.gen(function* () {
      const registry = yield* CtoxInstanceRegistry.CtoxInstanceRegistry;
      const input = yield* Schema.decodeUnknownEffect(CtoxSshManagedInstanceAddInput)(raw, {
        onExcessProperty: "error",
      }).pipe(Effect.option);
      if (input._tag === "None") {
        return yield* encodeSafe(CtoxSshManagedInstanceAddResult, {
          _tag: "failed",
          code: "invalid_input",
        });
      }
      const result = yield* registry.addSshManagedInstance(input.value).pipe(Effect.result);
      return yield* encodeSafe(
        CtoxSshManagedInstanceAddResult,
        Result.isSuccess(result)
          ? { _tag: "completed", instance: result.success }
          : { _tag: "failed", code: result.failure.code },
      );
    }),
};

export const removeSshManagedInstance: DesktopIpc.DesktopIpcMethod<
  never,
  | CtoxElectronSessions.CtoxElectronSessions
  | CtoxGuestManager.CtoxGuestManager
  | CtoxInstanceRegistry.CtoxInstanceRegistry
> = {
  channel: IpcChannels.CTOX_REMOVE_SSH_MANAGED_INSTANCE_CHANNEL,
  handler: (raw) =>
    Effect.gen(function* () {
      const registry = yield* CtoxInstanceRegistry.CtoxInstanceRegistry;
      const input = yield* Schema.decodeUnknownEffect(CtoxSshManagedInstanceRemoveInput)(raw, {
        onExcessProperty: "error",
      }).pipe(Effect.option);
      if (input._tag === "None") {
        return yield* encodeSafe(CtoxSshManagedInstanceRemoveResult, {
          _tag: "failed",
          code: "invalid_input",
        });
      }
      const removal = yield* registry
        .removeSshManagedInstance(input.value.instanceId)
        .pipe(Effect.result);
      if (Result.isFailure(removal)) {
        return yield* encodeSafe(CtoxSshManagedInstanceRemoveResult, {
          _tag: "failed",
          code: removal.failure.code,
        });
      }
      // An SSH-managed instance is not launchable yet, so no guest can be
      // holding it; deactivation is still attempted for symmetry with the
      // paired path and its failure is not fatal to the removal.
      const guests = yield* CtoxGuestManager.CtoxGuestManager;
      yield* guests.deactivateInstance(removal.success.id).pipe(Effect.ignore);
      return yield* encodeSafe(CtoxSshManagedInstanceRemoveResult, { _tag: "completed" });
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

export const enterBusinessOsMode: DesktopIpc.DesktopIpcMethod<
  never,
  CtoxGuestManager.CtoxGuestManager
> = {
  channel: IpcChannels.CTOX_ENTER_BUSINESS_OS_MODE_CHANNEL,
  handler: () =>
    Effect.gen(function* () {
      const guests = yield* CtoxGuestManager.CtoxGuestManager;
      return yield* guests.enterBusinessOsMode.pipe(
        Effect.flatMap((result) => encodeSafe(CtoxManagedActionResult, result)),
      );
    }),
};

export const exitBusinessOsMode: DesktopIpc.DesktopIpcMethod<
  never,
  CtoxGuestManager.CtoxGuestManager
> = {
  channel: IpcChannels.CTOX_EXIT_BUSINESS_OS_MODE_CHANNEL,
  handler: () =>
    Effect.gen(function* () {
      const guests = yield* CtoxGuestManager.CtoxGuestManager;
      return yield* guests.exitBusinessOsMode.pipe(
        Effect.flatMap((result) => encodeSafe(CtoxManagedActionResult, result)),
      );
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

export const listApps: DesktopIpc.DesktopIpcMethod<
  never,
  | CtoxAppRail.CtoxAppRail
  | CtoxGuestManager.CtoxGuestManager
  | CtoxInstanceRegistry.CtoxInstanceRegistry
> = {
  channel: IpcChannels.CTOX_LIST_APPS_CHANNEL,
  handler: (raw) =>
    Effect.gen(function* () {
      const input = yield* Schema.decodeUnknownEffect(CtoxInstanceAppsInput)(raw, {
        onExcessProperty: "error",
      }).pipe(Effect.option);
      if (input._tag === "None") {
        return yield* encodeSafe(CtoxInstanceAppsResult, {
          _tag: "failed",
          code: "invalid_input",
        });
      }
      const instanceId = input.value.instanceId;
      const rail = yield* CtoxAppRail.CtoxAppRail;
      const guests = yield* CtoxGuestManager.CtoxGuestManager;
      const railKey = yield* railKeyFor(instanceId);
      const nowEpochMs = yield* DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
      const observation = yield* guests.readGuestApps(instanceId);
      if (observation._tag === "completed") {
        // Persist what the live guest reports so a disconnected instance can
        // still render its rail from the last known state.
        yield* rail
          .recordLiveApps(railKey, observation.apps, nowEpochMs, observation.workspaceName)
          .pipe(Effect.orElseSucceed(() => undefined));
      }
      const state = yield* rail
        .stateForInstance(railKey)
        .pipe(
          Effect.orElseSucceed((): CtoxAppRail.CtoxRailInstanceState => ({ docked: [], apps: [] })),
        );
      const apps = CtoxAppRail.mergeRailApps({
        docked: state.docked,
        cached: state.apps,
        ...(observation._tag === "completed"
          ? {
              live: {
                apps: observation.apps,
                activeModuleId: observation.activeModuleId,
                openModuleIds: observation.openModuleIds,
              },
            }
          : {}),
        nowEpochMs,
      });
      const workspaceName =
        observation._tag === "completed" && observation.workspaceName !== undefined
          ? observation.workspaceName
          : state.workspaceName;
      return yield* encodeSafe(CtoxInstanceAppsResult, {
        _tag: "completed",
        instanceId,
        source: observation._tag === "completed" ? "live" : "cache",
        ...(workspaceName === undefined ? {} : { workspaceName }),
        apps,
      });
    }),
};

export const openApp: DesktopIpc.DesktopIpcMethod<never, CtoxGuestManager.CtoxGuestManager> = {
  channel: IpcChannels.CTOX_OPEN_APP_CHANNEL,
  handler: (raw) =>
    Effect.gen(function* () {
      const guests = yield* CtoxGuestManager.CtoxGuestManager;
      const input = yield* Schema.decodeUnknownEffect(CtoxOpenAppInput)(raw, {
        onExcessProperty: "error",
      }).pipe(Effect.option);
      if (input._tag === "None") {
        return yield* encodeSafe(CtoxAppActionResult, { _tag: "failed", code: "invalid_input" });
      }
      const result = yield* guests.openGuestApp(
        input.value.instanceId,
        input.value.moduleId,
        input.value.bounds,
      );
      return yield* encodeSafe(
        CtoxAppActionResult,
        result._tag === "completed"
          ? { _tag: "completed" }
          : {
              _tag: "failed",
              code:
                result.code === "invalid_input" || result.code === "not_active"
                  ? result.code
                  : "guest_failed",
            },
      );
    }),
};

export const setAppDocked: DesktopIpc.DesktopIpcMethod<
  never,
  CtoxAppRail.CtoxAppRail | CtoxInstanceRegistry.CtoxInstanceRegistry
> = {
  channel: IpcChannels.CTOX_SET_APP_DOCKED_CHANNEL,
  handler: (raw) =>
    Effect.gen(function* () {
      const rail = yield* CtoxAppRail.CtoxAppRail;
      const input = yield* Schema.decodeUnknownEffect(CtoxSetAppDockedInput)(raw, {
        onExcessProperty: "error",
      }).pipe(Effect.option);
      if (input._tag === "None") {
        return yield* encodeSafe(CtoxAppActionResult, { _tag: "failed", code: "invalid_input" });
      }
      const railKey = yield* railKeyFor(input.value.instanceId);
      const result = yield* rail
        .setDocked(railKey, input.value.moduleId, input.value.docked)
        .pipe(Effect.result);
      return yield* encodeSafe(
        CtoxAppActionResult,
        Result.isSuccess(result)
          ? { _tag: "completed" }
          : { _tag: "failed", code: "persistence_failed" },
      );
    }),
};

export const setHostTheme: DesktopIpc.DesktopIpcMethod<never, CtoxGuestManager.CtoxGuestManager> = {
  channel: IpcChannels.CTOX_SET_HOST_THEME_CHANNEL,
  handler: (raw) =>
    Effect.gen(function* () {
      const guests = yield* CtoxGuestManager.CtoxGuestManager;
      const input = yield* Schema.decodeUnknownEffect(CtoxHostThemeInput)(raw, {
        onExcessProperty: "error",
      }).pipe(Effect.option);
      if (input._tag === "None") {
        return yield* encodeSafe(CtoxManagedActionResult, {
          _tag: "failed",
          code: "invalid_input",
        });
      }
      return yield* encodeSafe(CtoxManagedActionResult, yield* guests.setHostTheme(input.value));
    }),
};

type CtoxIpcServices =
  | CtoxAppRail.CtoxAppRail
  | CtoxDevAuth.CtoxDevAuth
  | CtoxDecisionHubProvisioner.CtoxDecisionHubProvisioner
  | CtoxElectronSessions.CtoxElectronSessions
  | CtoxGuestManager.CtoxGuestManager
  | CtoxInstanceRegistry.CtoxInstanceRegistry;

export const methods: readonly DesktopIpc.DesktopIpcMethod<never, CtoxIpcServices>[] = [
  refresh,
  login,
  logout,
  provisionDecisionHub,
  disconnectDecisionHub,
  importInvite,
  importManualPairing,
  removePairedInstance,
  addSshManagedInstance,
  removeSshManagedInstance,
  enterBusinessOsMode,
  exitBusinessOsMode,
  activate,
  deactivate,
  setGuestBounds,
  listApps,
  openApp,
  setAppDocked,
  setHostTheme,
];
