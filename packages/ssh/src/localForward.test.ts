import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { openSshLocalForward } from "./localForward.ts";

const target = {
  alias: "devbox",
  hostname: "devbox.example.com",
  username: "julius",
  port: 2222,
} as const;

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(4242),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeExitedProcess = (stderr: string, exitCode: number) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(4243),
    stdout: Stream.empty,
    stderr: Stream.make(new TextEncoder().encode(stderr)),
    all: Stream.empty,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

const netLayer = (port: number) =>
  Layer.succeed(
    NetService.NetService,
    NetService.NetService.of({
      canListenOnHost: () => Effect.succeed(true),
      isPortAvailableOnLoopback: () => Effect.succeed(true),
      reserveLoopbackPort: () => Effect.succeed(port),
      findAvailablePort: (preferred) => Effect.succeed(preferred),
    }),
  );

const baseLayer = (input: {
  readonly port: number;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}) =>
  Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.spawner),
    netLayer(input.port),
  );

/** A loopback listener standing in for the far end of a real `-L` forward. */
const withLoopbackServer = <A, E, R>(
  use: (port: number) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer((socket) => socket.end());
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      return use(port);
    },
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

describe("openSshLocalForward", () => {
  it.live("becomes ready once the local port accepts a TCP connection", () =>
    withLoopbackServer((port) => {
      const spawnedCommands: Array<ReadonlyArray<string>> = [];
      let killCount = 0;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          spawnedCommands.push(commandArgs(command));
          return makeRunningProcess(() => {
            killCount += 1;
          });
        }),
      );

      return Effect.gen(function* () {
        // No probe override: the real TCP connect probe reaches the real
        // loopback server standing in for the forwarded remote port.
        const forward = yield* openSshLocalForward(target, 3_773);
        assert.equal(forward.localPort, port);
        assert.equal(forward.remotePort, 3_773);

        const args = spawnedCommands[0];
        assert.isDefined(args);
        assert.include(args, "-N");
        assert.include(args, "-n");
        assert.include(args, "-L");
        assert.include(args, `${port}:127.0.0.1:3773`);
        assert.include(args, "ExitOnForwardFailure=yes");
        assert.include(args, "ControlMaster=no");
        assert.include(args, "BatchMode=yes");
        assert.include(args, "julius@devbox");
        // Host-key policy stays OpenSSH's own; nothing may weaken it.
        assert.isFalse(args.some((entry) => entry.includes("StrictHostKeyChecking")));
        assert.isFalse(args.some((entry) => entry.includes("UserKnownHostsFile")));

        assert.equal(killCount, 0);
        yield* forward.close;
        assert.equal(killCount, 1);
      }).pipe(Effect.scoped, Effect.provide(baseLayer({ port, spawner })));
    }),
  );

  it.live("closing the surrounding scope tears the forward down", () => {
    let killCount = 0;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.sync(() =>
        makeRunningProcess(() => {
          killCount += 1;
        }),
      ),
    );
    return Effect.gen(function* () {
      const forward = yield* Effect.scoped(
        openSshLocalForward(target, 3_773, { probe: () => Effect.succeed(true) }),
      );
      assert.isAbove(forward.localPort, 0);
      assert.equal(killCount, 1);
      // `close` after the scope already released it stays a no-op.
      yield* forward.close;
      assert.equal(killCount, 1);
    }).pipe(Effect.provide(baseLayer({ port: 41_773, spawner })));
  });

  it.live("fails with startup_timeout and kills the child when the port never opens", () => {
    let killCount = 0;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.sync(() =>
        makeRunningProcess(() => {
          killCount += 1;
        }),
      ),
    );
    return Effect.gen(function* () {
      const error = yield* openSshLocalForward(target, 3_773, {
        probe: () => Effect.succeed(false),
        startupTimeoutMs: 20,
      }).pipe(Effect.flip);
      assert.equal(error._tag, "SshTunnelError");
      assert.equal(error.reason, "startup_timeout");
      assert.equal(killCount, 1);
    }).pipe(Effect.scoped, Effect.provide(baseLayer({ port: 41_773, spawner })));
  });

  it.live("fails with process_exited when the ssh child dies before readiness", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.sync(() => makeExitedProcess("bind [127.0.0.1]:41773: Address already in use\n", 255)),
    );
    return Effect.gen(function* () {
      const error = yield* openSshLocalForward(target, 3_773, {
        probe: () => Effect.succeed(false),
        startupTimeoutMs: 5_000,
      }).pipe(Effect.flip);
      assert.equal(error._tag, "SshTunnelError");
      assert.equal(error.reason, "process_exited");
    }).pipe(Effect.scoped, Effect.provide(baseLayer({ port: 41_773, spawner })));
  });

  it.live("rejects a remote port outside the TCP range without spawning ssh", () => {
    let spawnCount = 0;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        spawnCount += 1;
        return makeRunningProcess(() => undefined);
      }),
    );
    return Effect.gen(function* () {
      for (const invalid of [0, -1, 65_536, 1.5, Number.NaN]) {
        const error = yield* openSshLocalForward(target, invalid, {
          probe: () => Effect.succeed(true),
        }).pipe(Effect.flip);
        assert.equal(error.reason, "invalid_port");
      }
      assert.equal(spawnCount, 0);
    }).pipe(Effect.scoped, Effect.provide(baseLayer({ port: 41_773, spawner })));
  });

  it.live("fails with local_port_unavailable when no loopback port can be reserved", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.sync(() => makeRunningProcess(() => undefined)),
    );
    const failingNet = Layer.succeed(
      NetService.NetService,
      NetService.NetService.of({
        canListenOnHost: () => Effect.succeed(false),
        isPortAvailableOnLoopback: () => Effect.succeed(false),
        reserveLoopbackPort: () =>
          Effect.fail(new NetService.NetError({ message: "no port available" })),
        findAvailablePort: () =>
          Effect.fail(new NetService.NetError({ message: "no port available" })),
      }),
    );
    return Effect.gen(function* () {
      const error = yield* openSshLocalForward(target, 3_773, {
        probe: () => Effect.succeed(true),
      }).pipe(Effect.flip);
      assert.equal(error.reason, "local_port_unavailable");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          failingNet,
        ),
      ),
    );
  });
});
