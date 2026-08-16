// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expect, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as CtoxDevAuth from "../../ctox/CtoxDevAuth.ts";
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
  id: "paired:manual_pairing:stable",
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
    removePairedInstance: () => Effect.void,
    ...overrides,
  });
  return Layer.succeed(CtoxInstanceRegistry.CtoxInstanceRegistry, service);
}

function failedRegistry(code: CtoxInstanceRegistry.CtoxInstanceRegistryError["code"]) {
  return Effect.fail(new CtoxInstanceRegistry.CtoxInstanceRegistryError({ code }));
}

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
        registryLayer({
          importInvite: () => failedRegistry("invalid_invite"),
          importManualPairing: () => failedRegistry("unsafe_secret_storage"),
          removePairedInstance: () => failedRegistry("not_found"),
        }),
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
