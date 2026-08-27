// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expect, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as CtoxDevAuth from "../../ctox/CtoxDevAuth.ts";
import * as CtoxElectronSessions from "../../ctox/CtoxElectronSessions.ts";
import * as CtoxGuestManager from "../../ctox/CtoxGuestManager.ts";
import * as CtoxInstanceRegistry from "../../ctox/CtoxInstanceRegistry.ts";
import * as CtoxManagedLaunch from "../../ctox/CtoxManagedLaunch.ts";
import {
  activate,
  importInvite,
  importManualPairing,
  listApps,
  login,
  openApp,
  openSettings,
  refresh,
  resolveInstanceAuthority,
  removePairedInstance,
  addSshManagedInstance,
  removeSshManagedInstance,
  setAppDocked,
} from "./ctox.ts";
import * as CtoxAppRail from "../../ctox/CtoxAppRail.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const pairedInstance = {
  id: "paired:manual_pairing:abcdefghijklmnopqrstuv",
  source: "manual_pairing",
  displayName: "Office Business OS",
  status: "paired",
  role: "admin",
  healthSummary: {
    dataPlane: "rxdb-webrtc",
    dataPlaneReady: false,
    httpDataProxy: false,
    nativePeerObserved: false,
  },
} as const;

function registryLayer(
  overrides: Partial<CtoxInstanceRegistry.CtoxInstanceRegistry["Service"]> = {},
) {
  const service = CtoxInstanceRegistry.CtoxInstanceRegistry.of({
    merge: (managed) => Effect.succeed(managed),
    importInvite: () => Effect.succeed(pairedInstance),
    importManualPairing: () => Effect.succeed(pairedInstance),
    removePairedInstance: () =>
      Effect.succeed({ descriptor: pairedInstance, secretRecordRemoved: true }),
    addSshManagedInstance: () => Effect.die("unused"),
    removeSshManagedInstance: () => Effect.die("unused"),
    resolveSshManagedTarget: () => Effect.die("unused"),
    resolvePairedLaunch: () => Effect.die("unused"),
    resolveLocalDaemonTarget: () => Effect.die("unused"),
    stableIdentityKey: () => failedRegistry("not_found"),
    resolveBusinessOsInstanceId: () => failedRegistry("not_found"),
    ...overrides,
  });
  return Layer.succeed(CtoxInstanceRegistry.CtoxInstanceRegistry, service);
}

function failedRegistry(code: CtoxInstanceRegistry.CtoxInstanceRegistryError["code"]) {
  return Effect.fail(new CtoxInstanceRegistry.CtoxInstanceRegistryError({ code }));
}

function authorityLayers(input: {
  readonly instances: readonly (typeof pairedInstance)[];
  readonly registry?: Partial<CtoxInstanceRegistry.CtoxInstanceRegistry["Service"]>;
  readonly managedAuthorityId?: string;
}) {
  const auth = CtoxDevAuth.CtoxDevAuth.of({
    refresh: Effect.succeed({ _tag: "ready", instances: input.instances }),
    login: Effect.die("unused"),
    logout: Effect.die("unused"),
  });
  const managedLaunch = CtoxManagedLaunch.CtoxManagedLaunch.of({
    launch: () => Effect.die("unused"),
    resolveBusinessOsInstanceId: () =>
      input.managedAuthorityId === undefined
        ? Effect.die("unused")
        : Effect.succeed(input.managedAuthorityId as never),
  });
  return Layer.mergeAll(
    registryLayer(input.registry),
    Layer.succeed(CtoxDevAuth.CtoxDevAuth, auth),
    Layer.succeed(CtoxManagedLaunch.CtoxManagedLaunch, managedLaunch),
  );
}

function removalCleanupLayer(
  input: {
    readonly deactivateInstance?: CtoxGuestManager.CtoxGuestManager["Service"]["deactivateInstance"];
    readonly clearInstance?: CtoxElectronSessions.CtoxElectronSessions["Service"]["clearInstance"];
  } = {},
) {
  const guests = CtoxGuestManager.CtoxGuestManager.of({
    enterBusinessOsMode: Effect.succeed({ _tag: "completed" }),
    exitBusinessOsMode: Effect.succeed({ _tag: "completed" }),
    activate: () => Effect.die("unused"),
    suspend: Effect.succeed({ _tag: "completed" }),
    deactivate: Effect.succeed({ _tag: "completed" }),
    deactivateInstance: input.deactivateInstance ?? (() => Effect.succeed({ _tag: "completed" })),
    setBounds: () => Effect.die("unused"),
    readGuestApps: () => Effect.succeed({ _tag: "failed", code: "not_active" }),
    openGuestApp: () => Effect.die("unused"),
    openGuestSettings: () => Effect.die("unused"),
    setHostTheme: () => Effect.succeed({ _tag: "completed" }),
  });
  const sessions = CtoxElectronSessions.CtoxElectronSessions.of({
    account: Effect.die("unused"),
    instance: () => Effect.die("unused"),
    clearInstance: input.clearInstance ?? (() => Effect.void),
  });
  return Layer.merge(
    Layer.succeed(CtoxGuestManager.CtoxGuestManager, guests),
    Layer.succeed(CtoxElectronSessions.CtoxElectronSessions, sessions),
  );
}

describe("CTOX IPC methods", () => {
  it.effect("resolves only the canonical paired authority id without secret material", () => {
    const resolveBusinessOsInstanceId = vi.fn(() => Effect.succeed("office-1" as never));
    return Effect.gen(function* () {
      assert.deepEqual(yield* resolveInstanceAuthority.handler({ instanceId: pairedInstance.id }), {
        _tag: "completed",
        businessOsInstanceId: "office-1",
      });
      expect(resolveBusinessOsInstanceId).toHaveBeenCalledWith(pairedInstance.id);

      assert.deepEqual(yield* resolveInstanceAuthority.handler({ instanceId: "managed:tenant" }), {
        _tag: "failed",
        code: "not_found",
      });
      assert.deepEqual(
        yield* resolveInstanceAuthority.handler({ instanceId: pairedInstance.id, extra: true }),
        { _tag: "failed", code: "invalid_input" },
      );
    }).pipe(
      Effect.provide(
        authorityLayers({
          instances: [pairedInstance],
          registry: { resolveBusinessOsInstanceId },
        }),
      ),
    );
  });

  it.effect("resolves managed and local authorities through their main-process sources", () => {
    const managed = {
      ...pairedInstance,
      id: "managed:tenant-welsch",
      source: "ctox_dev",
      status: "available",
      displayName: "WELSCH",
    } as const;
    const local = {
      ...pairedInstance,
      id: "local:daemon-welsch",
      source: "local_daemon",
      status: "available",
      displayName: "WELSCH local",
    } as const;
    const ssh = {
      ...pairedInstance,
      id: "ssh:gpu3",
      source: "ssh_managed",
      status: "available",
      displayName: "gpu3",
    } as const;
    const localResolver = vi.fn(() => Effect.succeed("welsch-local-authority" as never));

    return Effect.gen(function* () {
      assert.deepEqual(yield* resolveInstanceAuthority.handler({ instanceId: managed.id }), {
        _tag: "completed",
        businessOsInstanceId: "welsch-managed-authority",
      });
      assert.deepEqual(yield* resolveInstanceAuthority.handler({ instanceId: local.id }), {
        _tag: "completed",
        businessOsInstanceId: "welsch-local-authority",
      });
      assert.deepEqual(yield* resolveInstanceAuthority.handler({ instanceId: ssh.id }), {
        _tag: "failed",
        code: "not_pairable",
      });
      expect(localResolver).toHaveBeenCalledWith(local.id);
    }).pipe(
      Effect.provide(
        authorityLayers({
          instances: [managed, local, ssh] as never,
          registry: { resolveBusinessOsInstanceId: localResolver },
          managedAuthorityId: "welsch-managed-authority",
        }),
      ),
    );
  });
  it.effect("rejects malformed activation input before calling the guest manager", () => {
    const activateGuest = vi.fn(() => Effect.succeed({ _tag: "ready" as const, instanceId: "x" }));
    const guests = CtoxGuestManager.CtoxGuestManager.of({
      enterBusinessOsMode: Effect.succeed({ _tag: "completed" }),
      exitBusinessOsMode: Effect.succeed({ _tag: "completed" }),
      activate: activateGuest,
      suspend: Effect.succeed({ _tag: "completed" }),
      deactivate: Effect.succeed({ _tag: "completed" }),
      deactivateInstance: () => Effect.succeed({ _tag: "completed" }),
      setBounds: () => Effect.succeed({ _tag: "completed" }),
      readGuestApps: () => Effect.succeed({ _tag: "failed", code: "not_active" }),
      openGuestApp: () => Effect.die("unused"),
      openGuestSettings: () => Effect.die("unused"),
      setHostTheme: () => Effect.succeed({ _tag: "completed" }),
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

  it.effect("merges paired entries when account refresh fails", () => {
    const auth = CtoxDevAuth.CtoxDevAuth.of({
      refresh: Effect.fail(
        new CtoxDevAuth.CtoxDevAuthOperationError({ operation: "account-session" }),
      ),
      login: Effect.die("unused"),
      logout: Effect.void,
    });
    const merge = vi.fn(() =>
      Effect.succeed({
        _tag: "ready" as const,
        instances: [pairedInstance],
        managedState: "failed" as const,
        managedFailureCode: "network_error" as const,
      }),
    );

    return Effect.gen(function* () {
      const result = yield* refresh.handler(undefined);
      assert.deepEqual(result, {
        _tag: "ready",
        instances: [pairedInstance],
        managedState: "failed",
        managedFailureCode: "network_error",
      });
      expect(merge).toHaveBeenCalledWith({ _tag: "failed", code: "network_error" });
      assert.notInclude(encodeUnknownJson(result), "secret");
    }).pipe(
      Effect.provide(
        Layer.merge(Layer.succeed(CtoxDevAuth.CtoxDevAuth, auth), registryLayer({ merge })),
      ),
    );
  });

  it.effect("merges paired entries after login even when managed refresh fails", () => {
    const auth = CtoxDevAuth.CtoxDevAuth.of({
      refresh: Effect.fail(
        new CtoxDevAuth.CtoxDevAuthOperationError({ operation: "account-session" }),
      ),
      login: Effect.succeed({ _tag: "completed", via: "url" }),
      logout: Effect.void,
    });

    return Effect.gen(function* () {
      const result = yield* login.handler(undefined);
      assert.deepEqual(result, {
        _tag: "completed",
        discovery: {
          _tag: "ready",
          instances: [pairedInstance],
          managedState: "failed",
          managedFailureCode: "network_error",
        },
      });
    }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.succeed(CtoxDevAuth.CtoxDevAuth, auth),
          registryLayer({
            merge: () =>
              Effect.succeed({
                _tag: "ready",
                instances: [pairedInstance],
                managedState: "failed",
                managedFailureCode: "network_error",
              }),
          }),
        ),
      ),
    );
  });

  it.effect("rejects malformed pairing payloads before calling the registry", () => {
    const importInviteCall = vi.fn(() => Effect.succeed(pairedInstance));
    const importManualCall = vi.fn(() => Effect.succeed(pairedInstance));

    return Effect.gen(function* () {
      assert.deepEqual(yield* importInvite.handler({ invite: "{}", extra: true }), {
        _tag: "failed",
        code: "invalid_input",
      });
      assert.deepEqual(
        yield* importManualPairing.handler({
          displayName: "Office",
          syncRoom: "ctox-business-os:office",
          signalingUrls: ["wss://signal.example.com"],
          roomSecret: "secret",
          httpBridgeAvailable: true,
        }),
        { _tag: "failed", code: "invalid_input" },
      );
      expect(importInviteCall).not.toHaveBeenCalled();
      expect(importManualCall).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        registryLayer({
          importInvite: importInviteCall,
          importManualPairing: importManualCall,
        }),
      ),
    );
  });

  it.effect("round-trips exact registry failure codes", () => {
    return Effect.gen(function* () {
      assert.deepEqual(yield* importInvite.handler({ invite: "{}" }), {
        _tag: "failed",
        code: "invalid_invite",
      });
      assert.deepEqual(
        yield* importManualPairing.handler({
          displayName: "Office",
          instanceId: "office",
          syncRoom: "ctox-business-os:office",
          signalingUrls: ["wss://signal.example.com"],
          roomSecret: "secret",
        }),
        { _tag: "failed", code: "unsafe_secret_storage" },
      );
      assert.deepEqual(
        yield* removePairedInstance.handler({ instanceId: "paired:manual_pairing:missing" }),
        { _tag: "failed", code: "not_found" },
      );
    }).pipe(
      Effect.provide(
        Layer.merge(
          registryLayer({
            importInvite: () => failedRegistry("invalid_invite"),
            importManualPairing: () => failedRegistry("unsafe_secret_storage"),
            removePairedInstance: () => failedRegistry("not_found"),
          }),
          removalCleanupLayer(),
        ),
      ),
    );
  });

  it.effect(
    "removes, detaches, and clears in order using only the authoritative stored descriptor",
    () => {
      const calls: string[] = [];
      const authoritative = { ...pairedInstance, displayName: "Authoritative Stored Office" };
      const remove = vi.fn((instanceId: string) =>
        Effect.sync(() => {
          calls.push(`registry:${instanceId}`);
          return { descriptor: authoritative, secretRecordRemoved: true };
        }),
      );
      const resolvePairedLaunch = vi.fn(() => Effect.die("must not decrypt removal secrets"));
      const deactivateInstance = vi.fn((instanceId: string) =>
        Effect.sync(() => {
          calls.push(`guest:${instanceId}`);
          return { _tag: "completed" as const };
        }),
      );
      const clearInstance = vi.fn(
        (
          descriptor: Parameters<
            CtoxElectronSessions.CtoxElectronSessions["Service"]["clearInstance"]
          >[0],
        ) =>
          Effect.sync(() => {
            calls.push(`session:${descriptor.displayName}`);
          }),
      );

      return Effect.gen(function* () {
        const result = yield* removePairedInstance.handler({ instanceId: pairedInstance.id });
        assert.deepEqual(result, { _tag: "completed" });
        assert.deepEqual(calls, [
          `registry:${pairedInstance.id}`,
          `guest:${authoritative.id}`,
          "session:Authoritative Stored Office",
        ]);
        expect(remove).toHaveBeenCalledExactlyOnceWith(pairedInstance.id);
        expect(deactivateInstance).toHaveBeenCalledExactlyOnceWith(authoritative.id);
        expect(clearInstance).toHaveBeenCalledOnce();
        expect(clearInstance.mock.calls[0]?.[0]).toBe(authoritative);
        expect(resolvePairedLaunch).not.toHaveBeenCalled();
      }).pipe(
        Effect.provide(
          Layer.merge(
            registryLayer({ removePairedInstance: remove, resolvePairedLaunch }),
            removalCleanupLayer({ deactivateInstance, clearInstance }),
          ),
        ),
      );
    },
  );

  it.effect("does no guest or session cleanup when removal input or registry work fails", () => {
    const remove = vi.fn(() => failedRegistry("not_found"));
    const deactivateInstance = vi.fn(() => Effect.succeed({ _tag: "completed" as const }));
    const clearInstance = vi.fn(() => Effect.void);
    const layer = Layer.merge(
      registryLayer({ removePairedInstance: remove }),
      removalCleanupLayer({ deactivateInstance, clearInstance }),
    );

    return Effect.gen(function* () {
      assert.deepEqual(
        yield* removePairedInstance.handler({
          instanceId: pairedInstance.id,
          partition: "persist:renderer-forged",
        }),
        { _tag: "failed", code: "invalid_input" },
      );
      expect(remove).not.toHaveBeenCalled();

      assert.deepEqual(yield* removePairedInstance.handler({ instanceId: pairedInstance.id }), {
        _tag: "failed",
        code: "not_found",
      });
      expect(remove).toHaveBeenCalledOnce();
      expect(deactivateInstance).not.toHaveBeenCalled();
      expect(clearInstance).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps guest and session cleanup failures to the fixed persistence failure code", () => {
    const guestClear = vi.fn(() =>
      Effect.succeed({ _tag: "failed" as const, code: "guest_failed" as const }),
    );
    const skippedSessionClear = vi.fn(() => Effect.void);
    const sessionClear = vi.fn(() => Effect.die("session-secret-cause"));

    const guestFailure = removePairedInstance.handler({ instanceId: pairedInstance.id }).pipe(
      Effect.provide(
        Layer.merge(
          registryLayer(),
          removalCleanupLayer({
            deactivateInstance: guestClear,
            clearInstance: skippedSessionClear,
          }),
        ),
      ),
    );
    const sessionFailure = removePairedInstance
      .handler({ instanceId: pairedInstance.id })
      .pipe(
        Effect.provide(
          Layer.merge(registryLayer(), removalCleanupLayer({ clearInstance: sessionClear })),
        ),
      );

    return Effect.gen(function* () {
      const guestResult = yield* guestFailure;
      assert.deepEqual(guestResult, { _tag: "failed", code: "persistence_failed" });
      expect(guestClear).toHaveBeenCalledExactlyOnceWith(pairedInstance.id);
      expect(skippedSessionClear).not.toHaveBeenCalled();
      assert.notInclude(encodeUnknownJson(guestResult), "guest_failed");

      const sessionResult = yield* sessionFailure;
      assert.deepEqual(sessionResult, { _tag: "failed", code: "persistence_failed" });
      expect(sessionClear).toHaveBeenCalledExactlyOnceWith(pairedInstance);
      assert.notInclude(encodeUnknownJson(sessionResult), "session-secret-cause");
    });
  });

  it.effect("still detaches and clears after a partial registry removal", () => {
    const deactivateInstance = vi.fn(() => Effect.succeed({ _tag: "completed" as const }));
    const clearInstance = vi.fn(() => Effect.void);

    return Effect.gen(function* () {
      const result = yield* removePairedInstance.handler({ instanceId: pairedInstance.id });
      assert.deepEqual(result, { _tag: "failed", code: "persistence_failed" });
      expect(deactivateInstance).toHaveBeenCalledExactlyOnceWith(pairedInstance.id);
      expect(clearInstance).toHaveBeenCalledExactlyOnceWith(pairedInstance);
    }).pipe(
      Effect.provide(
        Layer.merge(
          registryLayer({
            removePairedInstance: () =>
              Effect.succeed({ descriptor: pairedInstance, secretRecordRemoved: false }),
          }),
          removalCleanupLayer({ deactivateInstance, clearInstance }),
        ),
      ),
    );
  });

  it.effect("returns only renderer-safe import descriptors", () => {
    const unsafeInstance = {
      ...pairedInstance,
      roomSecret: "raw-room-secret",
      capabilityToken: "raw-capability-token",
      signalingUrls: ["wss://signal.example.com/?token=raw"],
      userDisplayName: "Private User",
    };
    return Effect.gen(function* () {
      const result = yield* importInvite.handler({ invite: "{}" });
      assert.deepEqual(result, { _tag: "completed", instance: pairedInstance });
      const encoded = encodeUnknownJson(result);
      assert.notInclude(encoded, "raw-room-secret");
      assert.notInclude(encoded, "raw-capability-token");
      assert.notInclude(encoded, "Private User");
    }).pipe(
      Effect.provide(
        registryLayer({
          importInvite: () => Effect.succeed(unsafeInstance),
        }),
      ),
    );
  });
});

describe("CTOX app rail IPC methods", () => {
  const NOW_APPS = 1_800_000_000_000;

  function guestsWithApps(overrides: Partial<CtoxGuestManager.CtoxGuestManager["Service"]> = {}) {
    return CtoxGuestManager.CtoxGuestManager.of({
      enterBusinessOsMode: Effect.succeed({ _tag: "completed" }),
      exitBusinessOsMode: Effect.succeed({ _tag: "completed" }),
      activate: () => Effect.die("unused"),
      suspend: Effect.succeed({ _tag: "completed" }),
      deactivate: Effect.succeed({ _tag: "completed" }),
      deactivateInstance: () => Effect.succeed({ _tag: "completed" }),
      setBounds: () => Effect.die("unused"),
      readGuestApps: () => Effect.succeed({ _tag: "failed", code: "not_active" }),
      openGuestApp: () => Effect.die("unused"),
      openGuestSettings: () => Effect.die("unused"),
      setHostTheme: () => Effect.succeed({ _tag: "completed" }),
      ...overrides,
    });
  }

  function railLayer(overrides: Partial<CtoxAppRail.CtoxAppRail["Service"]> = {}) {
    return Layer.succeed(
      CtoxAppRail.CtoxAppRail,
      CtoxAppRail.CtoxAppRail.of({
        stateForInstance: () => Effect.succeed({ docked: [], apps: [] }),
        setDocked: () => Effect.void,
        recordLiveApps: () => Effect.void,
        removeInstance: () => Effect.void,
        ...overrides,
      }),
    );
  }

  it.effect("merges docked and open apps from a live guest and refreshes the cache", () => {
    const recordLiveApps = vi.fn(() => Effect.void);
    const guests = guestsWithApps({
      readGuestApps: () =>
        Effect.succeed({
          _tag: "completed",
          apps: [
            { id: "crm", title: "CRM" },
            { id: "notes", title: "Notes" },
          ],
          activeModuleId: "notes",
          openModuleIds: ["notes"],
        }),
    });
    return Effect.gen(function* () {
      const result = yield* listApps.handler({ instanceId: "inst-a" });
      const decoded = result as {
        readonly _tag: string;
        readonly source?: string;
        readonly apps?: readonly {
          readonly id: string;
          readonly docked: boolean;
          readonly open: boolean;
        }[];
      };
      assert.equal(decoded._tag, "completed");
      assert.equal(decoded.source, "live");
      assert.deepEqual(
        decoded.apps?.map((app) => [app.id, app.docked, app.open]),
        [
          ["crm", true, false],
          ["notes", false, true],
        ],
      );
      expect(recordLiveApps).toHaveBeenCalledWith(
        { identity: "instance:inst-a", legacyInstanceId: "inst-a" },
        [
          { id: "crm", title: "CRM" },
          { id: "notes", title: "Notes" },
        ],
        expect.any(Number),
        undefined,
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(CtoxGuestManager.CtoxGuestManager, guests),
          railLayer({
            recordLiveApps,
            stateForInstance: () =>
              Effect.succeed({
                docked: ["crm"],
                apps: [{ id: "crm", title: "CRM", lastSeenAt: NOW_APPS }],
              }),
          }),
          registryLayer(),
        ),
      ),
    );
  });

  it.effect("carries guest categories through and keeps cached ones for silent apps", () => {
    const guests = guestsWithApps({
      readGuestApps: () =>
        Effect.succeed({
          _tag: "completed",
          apps: [
            { id: "crm", title: "CRM" },
            { id: "notes", title: "Notes", category: "Knowledge" },
          ],
          activeModuleId: null,
          openModuleIds: [],
        }),
    });
    return Effect.gen(function* () {
      const result = yield* listApps.handler({ instanceId: "inst-a" });
      const decoded = result as {
        readonly apps?: readonly { readonly id: string; readonly category?: string }[];
      };
      assert.deepEqual(
        decoded.apps?.map((app) => [app.id, app.category]),
        [
          ["crm", "Operations"],
          ["notes", "Knowledge"],
        ],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(CtoxGuestManager.CtoxGuestManager, guests),
          railLayer({
            stateForInstance: () =>
              Effect.succeed({
                docked: ["crm"],
                apps: [{ id: "crm", title: "CRM", category: "Operations", lastSeenAt: NOW_APPS }],
              }),
          }),
          registryLayer(),
        ),
      ),
    );
  });

  it.effect("serves the cached rail when the guest is not active", () =>
    Effect.gen(function* () {
      const result = yield* listApps.handler({ instanceId: "inst-a" });
      const decoded = result as {
        readonly _tag: string;
        readonly source?: string;
        readonly apps?: readonly { readonly id: string; readonly open: boolean }[];
      };
      assert.equal(decoded._tag, "completed");
      assert.equal(decoded.source, "cache");
      assert.deepEqual(
        decoded.apps?.map((app) => [app.id, app.open]),
        [["crm", false]],
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(CtoxGuestManager.CtoxGuestManager, guestsWithApps()),
          railLayer({
            stateForInstance: () =>
              Effect.succeed({
                docked: ["crm"],
                apps: [{ id: "crm", title: "CRM", lastSeenAt: NOW_APPS }],
              }),
          }),
          registryLayer(),
        ),
      ),
    ),
  );

  it.effect("rejects malformed open-app input before touching the guest", () => {
    const openGuestApp = vi.fn(() => Effect.succeed({ _tag: "completed" as const }));
    return Effect.gen(function* () {
      const result = yield* openApp.handler({
        instanceId: "inst-a",
        moduleId: "../escape",
        bounds: { x: 0, y: 0, width: 100, height: 100 },
      });
      assert.deepEqual(result, { _tag: "failed", code: "invalid_input" });
      expect(openGuestApp).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        Layer.succeed(CtoxGuestManager.CtoxGuestManager, guestsWithApps({ openGuestApp })),
      ),
    );
  });

  it.effect("maps guest activation failures onto the app action result", () =>
    Effect.gen(function* () {
      const result = yield* openApp.handler({
        instanceId: "inst-a",
        moduleId: "crm",
        bounds: { x: 0, y: 0, width: 100, height: 100 },
      });
      assert.deepEqual(result, { _tag: "failed", code: "guest_failed" });
    }).pipe(
      Effect.provide(
        Layer.succeed(
          CtoxGuestManager.CtoxGuestManager,
          guestsWithApps({
            openGuestApp: () => Effect.succeed({ _tag: "failed", code: "launch_failed" }),
          }),
        ),
      ),
    ),
  );

  it.effect("opens settings only through the active guest manager", () => {
    const openGuestSettings = vi.fn(() => Effect.succeed({ _tag: "completed" as const }));
    return Effect.gen(function* () {
      assert.deepEqual(yield* openSettings.handler({ instanceId: "" }), {
        _tag: "failed",
        code: "invalid_input",
      });
      expect(openGuestSettings).not.toHaveBeenCalled();

      assert.deepEqual(yield* openSettings.handler({ instanceId: "managed:alpha" }), {
        _tag: "completed",
      });
      expect(openGuestSettings).toHaveBeenCalledExactlyOnceWith("managed:alpha");
    }).pipe(
      Effect.provide(
        Layer.succeed(CtoxGuestManager.CtoxGuestManager, guestsWithApps({ openGuestSettings })),
      ),
    );
  });

  it.effect("persists dock toggles and reports persistence failures", () => {
    const setDocked = vi.fn(() => Effect.void);
    return Effect.gen(function* () {
      const ok = yield* setAppDocked.handler({
        instanceId: "inst-a",
        moduleId: "crm",
        docked: true,
      });
      assert.deepEqual(ok, { _tag: "completed" });
      expect(setDocked).toHaveBeenCalledWith(
        { identity: "instance:inst-a", legacyInstanceId: "inst-a" },
        "crm",
        true,
      );
    }).pipe(Effect.provide(Layer.merge(railLayer({ setDocked }), registryLayer())));
  });

  it.effect("keys the rail on the stable identity of a paired instance", () => {
    const setDocked = vi.fn(() => Effect.void);
    const stableIdentityKey = vi.fn(() => Effect.succeed("ctox:stable-office"));
    const firstPairing = "paired:manual_pairing:abcdefghijklmnopqrstuv";
    const rePaired = "paired:pairing_invite:bcdefghijklmnopqrstuvw";

    return Effect.gen(function* () {
      assert.deepEqual(
        yield* setAppDocked.handler({ instanceId: firstPairing, moduleId: "crm", docked: true }),
        { _tag: "completed" },
      );
      // The same CTOX instance keeps its rail record after remove and re-pair.
      assert.deepEqual(
        yield* setAppDocked.handler({ instanceId: rePaired, moduleId: "ledger", docked: true }),
        { _tag: "completed" },
      );
      expect(setDocked).toHaveBeenNthCalledWith(
        1,
        { identity: "ctox:stable-office", legacyInstanceId: firstPairing },
        "crm",
        true,
      );
      expect(setDocked).toHaveBeenNthCalledWith(
        2,
        { identity: "ctox:stable-office", legacyInstanceId: rePaired },
        "ledger",
        true,
      );
      expect(stableIdentityKey).toHaveBeenCalledTimes(2);
    }).pipe(
      Effect.provide(Layer.merge(railLayer({ setDocked }), registryLayer({ stableIdentityKey }))),
    );
  });

  it.effect("falls back to the registry id when the stable identity is unresolvable", () => {
    const setDocked = vi.fn(() => Effect.void);
    const unresolvable = "paired:manual_pairing:abcdefghijklmnopqrstuv";

    return Effect.gen(function* () {
      assert.deepEqual(
        yield* setAppDocked.handler({ instanceId: unresolvable, moduleId: "crm", docked: true }),
        { _tag: "completed" },
      );
      expect(setDocked).toHaveBeenCalledWith(
        { identity: `instance:${unresolvable}`, legacyInstanceId: unresolvable },
        "crm",
        true,
      );
    }).pipe(Effect.provide(Layer.merge(railLayer({ setDocked }), registryLayer())));
  });

  it.effect("reports persistence failures from the rail store", () =>
    Effect.gen(function* () {
      const result = yield* setAppDocked.handler({
        instanceId: "inst-a",
        moduleId: "crm",
        docked: false,
      });
      assert.deepEqual(result, { _tag: "failed", code: "persistence_failed" });
    }).pipe(
      Effect.provide(
        Layer.merge(
          railLayer({
            setDocked: () =>
              Effect.fail(new CtoxAppRail.CtoxAppRailError({ code: "persistence_failed" })),
          }),
          registryLayer(),
        ),
      ),
    ),
  );
});

describe("CTOX SSH-managed IPC methods", () => {
  const sshInstance = {
    id: "ssh:AAAAAAAAAAAAAAAAAAAAAA",
    source: "ssh_managed",
    displayName: "Build Box",
    status: "offline",
    healthSummary: {
      dataPlane: "rxdb-webrtc",
      dataPlaneReady: false,
      httpDataProxy: false,
      nativePeerObserved: false,
    },
  } as const;

  it.effect("rejects malformed SSH input before touching the registry", () => {
    const add = vi.fn(() => Effect.succeed(sshInstance));
    const layer = registryLayer({ addSshManagedInstance: add });
    return Effect.gen(function* () {
      for (const raw of [
        { host: "build box" },
        { host: "build-box", stateRoot: "relative" },
        { host: "build-box", unexpected: "field" },
        { host: "build-box", displayName: "\u0007bell" },
        {},
      ]) {
        assert.deepEqual(yield* addSshManagedInstance.handler(raw), {
          _tag: "failed",
          code: "invalid_input",
        });
      }
      expect(add).not.toHaveBeenCalled();
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes a bounded SSH configuration through and returns only the descriptor", () => {
    const add = vi.fn(() => Effect.succeed(sshInstance));
    const layer = registryLayer({ addSshManagedInstance: add });
    return Effect.gen(function* () {
      const result = yield* addSshManagedInstance.handler({
        host: "build-box",
        displayName: "Build Box",
        stateRoot: "/srv/ctox",
      });
      assert.deepEqual(result, { _tag: "completed", instance: sshInstance });
      expect(add).toHaveBeenCalledExactlyOnceWith({
        host: "build-box",
        displayName: "Build Box",
        stateRoot: "/srv/ctox",
      });
      // The renderer never learns the destination behind the row.
      assert.notInclude(encodeUnknownJson(result), "build-box");
      assert.notInclude(encodeUnknownJson(result), "/srv/ctox");
    }).pipe(Effect.provide(layer));
  });

  it.effect("surfaces the registry failure code when an SSH removal fails", () => {
    const layer = registryLayer({
      removeSshManagedInstance: () => failedRegistry("not_found"),
    });
    return Effect.gen(function* () {
      assert.deepEqual(
        yield* removeSshManagedInstance.handler({ instanceId: "ssh:AAAAAAAAAAAAAAAAAAAAAA" }),
        { _tag: "failed", code: "not_found" },
      );
    }).pipe(Effect.provide(Layer.merge(layer, removalCleanupLayer())));
  });

  it.effect("removes a configured SSH instance and releases any guest holding it", () => {
    const deactivateInstance = vi.fn(() => Effect.succeed({ _tag: "completed" as const }));
    const layer = registryLayer({
      removeSshManagedInstance: () => Effect.succeed(sshInstance),
    });
    return Effect.gen(function* () {
      assert.deepEqual(yield* removeSshManagedInstance.handler({ instanceId: sshInstance.id }), {
        _tag: "completed",
      });
      expect(deactivateInstance).toHaveBeenCalledExactlyOnceWith(sshInstance.id);
    }).pipe(Effect.provide(Layer.merge(layer, removalCleanupLayer({ deactivateInstance }))));
  });
});
