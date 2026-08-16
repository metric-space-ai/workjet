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
import {
  activate,
  importInvite,
  importManualPairing,
  login,
  refresh,
  removePairedInstance,
} from "./ctox.ts";

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
    resolvePairedLaunch: () => Effect.die("unused"),
    ...overrides,
  });
  return Layer.succeed(CtoxInstanceRegistry.CtoxInstanceRegistry, service);
}

function failedRegistry(code: CtoxInstanceRegistry.CtoxInstanceRegistryError["code"]) {
  return Effect.fail(new CtoxInstanceRegistry.CtoxInstanceRegistryError({ code }));
}

function removalCleanupLayer(
  input: {
    readonly deactivateInstance?: CtoxGuestManager.CtoxGuestManager["Service"]["deactivateInstance"];
    readonly clearInstance?: CtoxElectronSessions.CtoxElectronSessions["Service"]["clearInstance"];
  } = {},
) {
  const guests = CtoxGuestManager.CtoxGuestManager.of({
    activate: () => Effect.die("unused"),
    deactivate: Effect.succeed({ _tag: "completed" }),
    deactivateInstance: input.deactivateInstance ?? (() => Effect.succeed({ _tag: "completed" })),
    setBounds: () => Effect.die("unused"),
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
  it.effect("rejects malformed activation input before calling the guest manager", () => {
    const activateGuest = vi.fn(() => Effect.succeed({ _tag: "ready" as const, instanceId: "x" }));
    const guests = CtoxGuestManager.CtoxGuestManager.of({
      activate: activateGuest,
      deactivate: Effect.succeed({ _tag: "completed" }),
      deactivateInstance: () => Effect.succeed({ _tag: "completed" }),
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
