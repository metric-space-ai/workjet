// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import type { CtoxManagedInstance } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect, vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as Account from "./CtoxAccountLifecycle.ts";
import { CtoxInstanceRegistry } from "./CtoxInstanceRegistry.ts";
import * as Native from "./CtoxNativeIdentityResolver.ts";

const LOCAL = "local:AAAAAAAAAAAAAAAAAAAAAA";
const SSH = "ssh:AAAAAAAAAAAAAAAAAAAAAA";
const KEY = "ed25519:" + "ab".repeat(32);
const ROOT = "/fixture/instances/chosen";
const encoder = new TextEncoder();
const descriptor: CtoxManagedInstance = {
  id: LOCAL,
  source: "local_daemon",
  displayName: "Fixture",
  status: "available",
  healthSummary: {
    dataPlane: "rxdb-webrtc",
    dataPlaneReady: false,
    nativePeerObserved: false,
    httpDataProxy: false,
  },
};

function handle(output: string, code = 0, pending = false) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: pending ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(pending),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: pending ? Stream.never : Stream.make(encoder.encode(output)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function registry(
  options: { root?: string | null; nativeInstance?: string | null; windowsSsh?: boolean } = {},
) {
  return CtoxInstanceRegistry.of({
    merge: () => Effect.die("unused"),
    importInvite: () => Effect.die("must not import an invite"),
    importManualPairing: () => Effect.die("unused"),
    removePairedInstance: () => Effect.die("unused"),
    addSshManagedInstance: () => Effect.die("unused"),
    removeSshManagedInstance: () => Effect.die("unused"),
    resolvePairedLaunch: () => Effect.die("must not decrypt pairing credentials"),
    stableIdentityKey: () => Effect.die("unused"),
    resolveBusinessOsInstanceId: () => Effect.die("unused"),
    resolveLocalDaemonTarget: () =>
      Effect.succeed({
        descriptor,
        daemonInstanceId: "chosen-native-instance",
        ...(options.root === null ? {} : { stateRoot: options.root ?? ROOT }),
        discoveredCount: 3,
      }),
    resolveSshManagedTarget: () =>
      Effect.succeed({
        descriptor: { ...descriptor, id: SSH, source: "ssh_managed" as const },
        host: "fixture-host",
        username: "fixture-user",
        port: 2222,
        stateRoot: "/srv/fixture",
        platform: options.windowsSsh ? ("windows" as const) : ("linux" as const),
        knownHostsLine: "fixture-host ssh-ed25519 fixture-known-host",
        ...(options.nativeInstance === null
          ? {}
          : { daemonInstanceId: options.nativeInstance ?? "remote-native-instance" }),
      }),
  });
}

function makeResolver(
  account: Account.AccountLifecycle,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  options: Native.CtoxNativeIdentityResolverOptions = {},
  targets = registry(),
) {
  return Native.make({
    env: { CTOX_BIN: "/fixture/bin/ctox" },
    platform: "linux",
    ...options,
  }).pipe(
    Effect.provideService(CtoxInstanceRegistry, targets),
    Effect.provideService(Account.CtoxAccountLifecycle, account),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provide(NodeServices.layer),
  );
}

describe("native identity resolution through existing trusted host paths", () => {
  it.effect(
    "reads the selected local root before authority is ready without minting credentials",
    () =>
      Effect.gen(function* () {
        const account = yield* Account.make;
        const calls: unknown[] = [];
        const spawner = ChildProcessSpawner.make((command) => {
          calls.push(command);
          return Effect.succeed(handle(JSON.stringify({ identity: KEY })));
        });
        const resolver = yield* makeResolver(account, spawner);
        const identity = yield* resolver.resolve(LOCAL);
        expect(identity).toEqual({
          targetId: LOCAL,
          instanceId: "chosen-native-instance",
          publicIdentity: KEY,
          sessionEpoch: 0,
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          command: "/fixture/bin/ctox",
          args: ["sync", "identity", "--root", ROOT],
        });
        expect(account.isCurrent(0)).toBe(false);
        yield* account.transition("logout", Effect.void);
        expect(account.sessionEpoch()).toBe(1);
      }),
  );

  it.effect("does not guess missing or relative local roots or bypass the Windows trust gap", () =>
    Effect.gen(function* () {
      const account = yield* Account.make;
      let calls = 0;
      const spawner = ChildProcessSpawner.make(() => {
        calls++;
        return Effect.succeed(handle(JSON.stringify({ identity: KEY })));
      });
      for (const root of [null, "relative/root"]) {
        const resolver = yield* makeResolver(account, spawner, {}, registry({ root }));
        expect((yield* Effect.exit(resolver.resolve(LOCAL)))._tag).toBe("Failure");
      }
      const windows = yield* makeResolver(account, spawner, { platform: "win32" });
      expect((yield* Effect.exit(windows.resolve(LOCAL)))._tag).toBe("Failure");
      expect(calls).toBe(0);
    }),
  );

  it.effect("rejects malformed, excessive or secret-bearing CLI output and nonzero exit", () =>
    Effect.gen(function* () {
      const account = yield* Account.make;
      for (const output of [
        JSON.stringify({ identity: KEY, pkcs8: "must-not-leak" }),
        JSON.stringify({ identity: "wrong-format" }),
        JSON.stringify({ identity: KEY }) + "second document",
        "x".repeat(4097),
      ]) {
        const resolver = yield* makeResolver(
          account,
          ChildProcessSpawner.make(() => Effect.succeed(handle(output))),
        );
        const error = yield* resolver.resolve(LOCAL).pipe(Effect.flip);
        expect(error.message).toBe("The selected instance could not be verified.");
        expect(JSON.stringify(error)).not.toContain("must-not-leak");
      }
      const failed = yield* makeResolver(
        account,
        ChildProcessSpawner.make(() =>
          Effect.succeed(handle(JSON.stringify({ identity: KEY }), 1)),
        ),
      );
      expect((yield* Effect.exit(failed.resolve(LOCAL)))._tag).toBe("Failure");
    }),
  );

  it.effect("awaits actual pending child cleanup before completing an account transition", () =>
    Effect.gen(function* () {
      const account = yield* Account.make;
      const started = Promise.withResolvers<void>();
      const cleanupStarted = Promise.withResolvers<void>();
      const cleanup = Promise.withResolvers<void>();
      let cleaned = false;
      let accountChanged = false;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.promise(async () => {
              cleanupStarted.resolve();
              await cleanup.promise;
              cleaned = true;
            }),
          );
          started.resolve();
          return handle("", 0, true);
        }),
      );
      const resolver = yield* makeResolver(account, spawner);
      const reading = yield* Effect.forkChild(Effect.exit(resolver.resolve(LOCAL)));
      yield* Effect.promise(() => started.promise);
      const transition = yield* Effect.forkChild(
        account.transition(
          "account-transition",
          Effect.sync(() => {
            accountChanged = true;
          }),
        ),
      );
      yield* Effect.promise(() => cleanupStarted.promise);
      try {
        expect(cleaned).toBe(false);
        expect(accountChanged).toBe(false);
        expect(account.sessionEpoch()).toBe(1);
      } finally {
        cleanup.resolve();
      }
      expect((yield* Fiber.join(reading))._tag).toBe("Failure");
      yield* Fiber.join(transition);
      expect(cleaned).toBe(true);
      expect(accountChanged).toBe(true);
      expect(account.isCurrent(1)).toBe(false);
    }),
  );

  it.effect("refuses a new read while account invalidation is already pending", () =>
    Effect.gen(function* () {
      const account = yield* Account.make;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      account.registerInvalidator(async () => {
        entered.resolve();
        await release.promise;
      });
      const transition = yield* Effect.forkChild(account.transition("logout", Effect.void));
      yield* Effect.promise(() => entered.promise);
      let calls = 0;
      const resolver = yield* makeResolver(
        account,
        ChildProcessSpawner.make(() => {
          calls++;
          return Effect.succeed(handle(JSON.stringify({ identity: KEY })));
        }),
      );
      try {
        expect((yield* Effect.exit(resolver.resolve(LOCAL)))._tag).toBe("Failure");
        expect(calls).toBe(0);
      } finally {
        release.resolve();
      }
      yield* Fiber.join(transition);
    }),
  );

  it.effect(
    "uses the existing pinned SSH executor and preserves the selected native instance",
    () =>
      Effect.gen(function* () {
        const account = yield* Account.make;
        const calls: unknown[] = [];
        const resolver = yield* makeResolver(
          account,
          ChildProcessSpawner.make(() => Effect.die("local exec forbidden")),
          {
            sshExec: (input) => {
              calls.push(input);
              return Effect.succeed({ stdout: JSON.stringify({ identity: KEY }) });
            },
          },
        );
        expect(yield* resolver.resolve(SSH)).toEqual({
          targetId: SSH,
          instanceId: "remote-native-instance",
          publicIdentity: KEY,
          sessionEpoch: 0,
        });
        expect(calls).toEqual([
          {
            host: "fixture-host",
            username: "fixture-user",
            port: 2222,
            knownHostsLine: "fixture-host ssh-ed25519 fixture-known-host",
            argv: Native.buildCtoxSshIdentityCommand("/srv/fixture"),
            timeoutMs: 20_000,
          },
        ]);
        expect(account.isCurrent(0)).toBe(false);
      }),
  );

  it.effect(
    "refuses failed SSH reads, unknown native instances and unprovisioned enrollment sources",
    () =>
      Effect.gen(function* () {
        const account = yield* Account.make;
        const noLocal = ChildProcessSpawner.make(() => Effect.die("local exec forbidden"));
        const failed = yield* makeResolver(account, noLocal, {
          sshExec: () =>
            Effect.succeed({
              stdout: JSON.stringify({ identity: KEY }),
              stderr: "__workjet_native_identity_failed__",
            }),
        });
        expect((yield* Effect.exit(failed.resolve(SSH)))._tag).toBe("Failure");
        let calls = 0;
        const unavailable = yield* makeResolver(
          account,
          noLocal,
          {
            sshExec: () => {
              calls++;
              return Effect.succeed({ stdout: JSON.stringify({ identity: KEY }) });
            },
          },
          registry({ nativeInstance: null }),
        );
        expect((yield* Effect.exit(unavailable.resolve(SSH)))._tag).toBe("Failure");
        expect((yield* Effect.exit(unavailable.resolve("paired:fixture")))._tag).toBe("Failure");
        expect(calls).toBe(0);
      }),
  );

  it("quotes a remote root as one shell value and never runs key initialization", () => {
    const command = Native.buildCtoxSshIdentityCommand("/srv/a'b");
    expect(command.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(command[2]).toContain("CTOX_ROOT='/srv/a'\\''b'");
    expect(command[2]).toContain('sync identity --root "$CTOX_ROOT"');
    expect(command[2]).not.toContain("sync init");
    expect(command[2]).not.toContain("desktop invite");
    expect(command[2]).toContain("head -c 4097");
  });
});
