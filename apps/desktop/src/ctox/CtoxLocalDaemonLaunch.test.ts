// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import { assert, describe, it } from "@effect/vitest";
import type { CtoxManagedInstance } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as CtoxInstanceRegistry from "./CtoxInstanceRegistry.ts";
import * as CtoxLocalDaemonLaunch from "./CtoxLocalDaemonLaunch.ts";

const NOW = 1_800_000_000_000;
const encoder = new TextEncoder();
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const localDescriptor: CtoxManagedInstance = {
  id: "local:AAAAAAAAAAAAAAAAAAAAAA",
  source: "local_daemon",
  displayName: "Workshop (local)",
  status: "available",
  healthSummary: {
    dataPlane: "rxdb-webrtc",
    dataPlaneReady: false,
    httpDataProxy: false,
    nativePeerObserved: false,
  },
};

function inviteJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "ctox-business-os-invite",
    version: 1,
    display_name: "Workshop Business OS",
    instance_id: "workshop-1",
    sync_room: "ctox-business-os:workshop-room",
    signaling_urls: ["ws://127.0.0.1:4444/signal"],
    signaling_room_password: "raw-local-secret",
    transport: "webrtc",
    expires_at_ms: NOW + 86_400_000,
    data_plane: "rxdb-webrtc",
    session: {
      authenticated: true,
      source: "desktop_invite",
      capability_token: "raw-local-capability",
      capability_expires_at_ms: NOW + 86_400_000,
      user: { id: "private-user-id", display_name: "Private User", role: "chef" },
    },
    ...overrides,
  });
}

function mockHandle(result: { stdout?: string; stderr?: string; code?: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout ?? "")),
    stderr: Stream.make(encoder.encode(result.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function neverFinishingHandle() {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function spawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout?: string; stderr?: string; code?: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      return Effect.succeed(mockHandle(handler(childProcess.command, childProcess.args)));
    }),
  );
}

function registryStub(
  input: { readonly discoveredCount?: number; readonly daemonInstanceId?: string } = {},
) {
  return Layer.succeed(
    CtoxInstanceRegistry.CtoxInstanceRegistry,
    CtoxInstanceRegistry.CtoxInstanceRegistry.of({
      merge: () => Effect.die("unused"),
      importInvite: () => Effect.die("unused"),
      importManualPairing: () => Effect.die("unused"),
      removePairedInstance: () => Effect.die("unused"),
      addSshManagedInstance: () => Effect.die("unused"),
      removeSshManagedInstance: () => Effect.die("unused"),
      resolvePairedLaunch: () => Effect.die("unused"),
      stableIdentityKey: () => Effect.die("unused"),
      resolveLocalDaemonTarget: (instanceId) =>
        instanceId === localDescriptor.id
          ? Effect.succeed({
              descriptor: localDescriptor,
              daemonInstanceId: input.daemonInstanceId ?? "workshop-1",
              discoveredCount: input.discoveredCount ?? 1,
            })
          : Effect.fail(new CtoxInstanceRegistry.CtoxInstanceRegistryError({ code: "not_found" })),
    }),
  );
}

function harness(input: {
  readonly spawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly discoveredCount?: number;
  readonly daemonInstanceId?: string;
}) {
  return CtoxLocalDaemonLaunch.layer({
    env: input.env ?? {},
    nowEpochMs: () => NOW,
  }).pipe(
    Layer.provide(
      Layer.merge(
        input.spawner,
        registryStub({
          ...(input.discoveredCount === undefined
            ? {}
            : { discoveredCount: input.discoveredCount }),
          ...(input.daemonInstanceId === undefined
            ? {}
            : { daemonInstanceId: input.daemonInstanceId }),
        }),
      ),
    ),
  );
}

describe("CtoxLocalDaemonLaunch", () => {
  it.effect("mints a launch config from the daemon's own invite CLI", () => {
    const layer = harness({
      spawner: spawnerLayer((command, args) => {
        assert.equal(command, "ctox");
        assert.deepEqual(args, [
          "business-os",
          "desktop",
          "invite",
          "--format",
          "json",
          "--ttl-hours",
          "24",
        ]);
        return { stdout: inviteJson() };
      }),
    });

    return Effect.gen(function* () {
      const service = yield* CtoxLocalDaemonLaunch.CtoxLocalDaemonLaunch;
      const resolved = yield* service.resolveLaunch(localDescriptor.id);
      assert.deepEqual(resolved.descriptor, localDescriptor);
      assert.deepEqual(resolved.config, {
        transport: "webrtc",
        sync_room: "ctox-business-os:workshop-room",
        signaling_urls: ["ws://127.0.0.1:4444/signal"],
        signaling_room_password: "raw-local-secret",
        http_bridge_available: false,
        desktop_instance: {
          id: localDescriptor.id,
          source: "local_daemon",
          display_name: localDescriptor.displayName,
          domain: "",
        },
        session: {
          authenticated: true,
          source: "desktop_invite",
          capability_token: "raw-local-capability",
          capability_expires_at_ms: NOW + 86_400_000,
          user: {
            id: "private-user-id",
            display_name: "Private User",
            role: "chef",
            is_admin: true,
          },
        },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves the binary through CTOX_BIN before falling back to PATH", () => {
    const layer = harness({
      env: { CTOX_BIN: "/opt/ctox/bin/ctox" },
      spawner: spawnerLayer((command) => {
        assert.equal(command, "/opt/ctox/bin/ctox");
        return { stdout: inviteJson() };
      }),
    });

    return Effect.gen(function* () {
      const service = yield* CtoxLocalDaemonLaunch.CtoxLocalDaemonLaunch;
      const resolved = yield* service.resolveLaunch(localDescriptor.id);
      assert.equal(resolved.config.sync_room, "ctox-business-os:workshop-room");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects malformed, oversized, and expired invites", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["not json at all", "invalid_invite"],
      [JSON.stringify({ type: "ctox-business-os-invite", version: 1 }), "invalid_invite"],
      // An unexpected key means the daemon is not speaking the invite contract.
      [inviteJson({ smuggled_field: "x" }), "invalid_invite"],
      // A non-loopback ws:// signaling URL is refused by the invite decoder.
      [inviteJson({ signaling_urls: ["ws://signal.example.com/room"] }), "invalid_invite"],
      [inviteJson({ expires_at_ms: NOW - 1 }), "invalid_invite"],
      [`${"x".repeat(300_000)}`, "invalid_invite"],
    ];

    return Effect.gen(function* () {
      for (const [stdout, expected] of cases) {
        const layer = harness({ spawner: spawnerLayer(() => ({ stdout })) });
        const error = yield* Effect.gen(function* () {
          const service = yield* CtoxLocalDaemonLaunch.CtoxLocalDaemonLaunch;
          return yield* service.resolveLaunch(localDescriptor.id).pipe(Effect.flip);
        }).pipe(Effect.provide(layer));
        assert.equal(error.reason, expected);
        assert.notInclude(encodeUnknownJson({ ...error }), "raw-local-secret");
      }
    });
  });

  it.effect("classifies a missing binary, a failing CLI, and an unknown instance", () => {
    const failingSpawner = Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "ChildProcess",
            method: "spawn",
            cause: new Error("private executable lookup detail"),
          }),
        ),
      ),
    );

    return Effect.gen(function* () {
      const missing = yield* Effect.gen(function* () {
        const service = yield* CtoxLocalDaemonLaunch.CtoxLocalDaemonLaunch;
        return yield* service.resolveLaunch(localDescriptor.id).pipe(Effect.flip);
      }).pipe(Effect.provide(harness({ spawner: failingSpawner })));
      assert.equal(missing.reason, "cli_unavailable");
      assert.notInclude(missing.message, "private executable lookup detail");

      const failed = yield* Effect.gen(function* () {
        const service = yield* CtoxLocalDaemonLaunch.CtoxLocalDaemonLaunch;
        return yield* service.resolveLaunch(localDescriptor.id).pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          harness({
            spawner: spawnerLayer(() => ({
              code: 1,
              stderr: "ctox: no business-os workspace at /home/user/.local/state/ctox",
            })),
          }),
        ),
      );
      assert.equal(failed.reason, "cli_failed");
      assert.notInclude(encodeUnknownJson({ ...failed }), "/home/user");

      const unknown = yield* Effect.gen(function* () {
        const service = yield* CtoxLocalDaemonLaunch.CtoxLocalDaemonLaunch;
        return yield* service.resolveLaunch("local:BBBBBBBBBBBBBBBBBBBBBB").pipe(Effect.flip);
      }).pipe(Effect.provide(harness({ spawner: spawnerLayer(() => ({ stdout: inviteJson() })) })));
      assert.equal(unknown.reason, "not_found");
    });
  });

  it.effect("refuses an invite that names another daemon on a multi-daemon host", () => {
    const single = harness({
      discoveredCount: 1,
      daemonInstanceId: "warehouse-9",
      spawner: spawnerLayer(() => ({ stdout: inviteJson() })),
    });
    const multiple = harness({
      discoveredCount: 2,
      daemonInstanceId: "warehouse-9",
      spawner: spawnerLayer(() => ({ stdout: inviteJson() })),
    });

    return Effect.gen(function* () {
      // One daemon on the host: the invite can only have come from it.
      const resolved = yield* Effect.gen(function* () {
        const service = yield* CtoxLocalDaemonLaunch.CtoxLocalDaemonLaunch;
        return yield* service.resolveLaunch(localDescriptor.id);
      }).pipe(Effect.provide(single));
      assert.equal(resolved.config.desktop_instance.id, localDescriptor.id);

      const error = yield* Effect.gen(function* () {
        const service = yield* CtoxLocalDaemonLaunch.CtoxLocalDaemonLaunch;
        return yield* service.resolveLaunch(localDescriptor.id).pipe(Effect.flip);
      }).pipe(Effect.provide(multiple));
      assert.equal(error.reason, "identity_mismatch");
    });
  });

  it.effect("times out a wedged daemon through TestClock", () => {
    const layer = Layer.merge(
      TestClock.layer(),
      harness({
        spawner: Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.succeed(neverFinishingHandle())),
        ),
      }),
    );

    return Effect.gen(function* () {
      const service = yield* CtoxLocalDaemonLaunch.CtoxLocalDaemonLaunch;
      const fiber = yield* service
        .resolveLaunch(localDescriptor.id)
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("30 seconds");
      const error = yield* Fiber.join(fiber);
      assert.equal(error.reason, "cli_timeout");
    }).pipe(Effect.provide(layer));
  });
});
