import * as NodeNet from "node:net";

import type { DesktopSshEnvironmentTarget } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { buildSshChildEnvironment, type SshAuthOptions } from "./auth.ts";
import {
  baseSshArgs,
  buildSshHostSpecEffect,
  collectProcessOutput,
  resolveSshCommand,
} from "./command.ts";
import { SshCommandError, SshInvalidTargetError, SshTunnelError } from "./errors.ts";

/**
 * The server-agnostic `ssh -L` local forward.
 *
 * `startSshTunnel` in `./tunnel.ts` used to be the only forward in the repo,
 * but it is a *T3 server* forward: it takes an HTTP base URL, gates readiness
 * on an HTTP probe, and lives inside `SshEnvironmentManager`'s tunnel registry.
 * Anything else that needs a remote loopback port — a CTOX daemon's signaling
 * socket, for one — needs the forward without the T3 opinions.
 *
 * So the spawn and the exit-monitor are extracted here and shared: `tunnel.ts`
 * imports `spawnSshLocalForwardProcess` and `sshLocalForwardExitFailure` rather
 * than keeping a second copy, and this module adds only what differs — an
 * ephemeral local port, a TCP connect readiness probe, and a scoped handle.
 *
 * Security properties are inherited, not restated:
 *  - The argument vector is built by `baseSshArgs`, exactly as `runSshCommand`
 *    builds it. `StrictHostKeyChecking` is never passed, so OpenSSH's own
 *    `known_hosts` policy decides; an unknown or changed key aborts.
 *  - `BatchMode` defaults to `yes`, so a host wanting a password fails fast
 *    instead of blocking on a prompt no one can answer.
 *  - `ExitOnForwardFailure=yes` means a refused forward is a dead child, not a
 *    silently unbound port the caller would mistake for a working tunnel.
 *  - Nothing here reads, stores, or logs a secret; ports and aliases only.
 */

/** A forward is either up in a second or wrong; a wedged one must not hang a launch. */
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const READY_PROBE_INTERVAL_MS = 50;
const READY_PROBE_CONNECT_TIMEOUT_MS = 500;
const FORWARD_SHUTDOWN_TIMEOUT_MS = 2_000;
const LOOPBACK_HOST = "127.0.0.1";
const MIN_PORT = 1;
const MAX_PORT = 65_535;

export function isValidTcpPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= MIN_PORT && (value as number) <= MAX_PORT;
}

function normalizeSshErrorMessage(stderr: string, fallbackMessage: string): string {
  const cleaned = stderr.trim();
  return cleaned.length > 0 ? cleaned : fallbackMessage;
}

function sshTargetLogFields(target: DesktopSshEnvironmentTarget) {
  return {
    alias: target.alias,
    hostname: target.hostname,
    username: target.username,
    port: target.port,
  };
}

export interface SshLocalForwardSpawnInput {
  readonly target: DesktopSshEnvironmentTarget;
  readonly localPort: number;
  readonly remotePort: number;
  readonly authOptions?: SshAuthOptions;
}

export interface SshLocalForwardProcess {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  /** The full argv, for diagnostics. It carries no secret. */
  readonly command: readonly string[];
}

/**
 * Spawns `ssh -N -L <local>:127.0.0.1:<remote>` into the ambient scope. Both
 * the T3 tunnel and the generic forward go through here so the two can never
 * drift apart on host-key handling, keep-alives, or control-socket policy.
 */
export const spawnSshLocalForwardProcess = Effect.fn(
  "ssh/localForward.spawnSshLocalForwardProcess",
)(function* (
  input: SshLocalForwardSpawnInput,
): Effect.fn.Return<
  SshLocalForwardProcess,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const authOptions = input.authOptions ?? {};
  const hostSpec = yield* buildSshHostSpecEffect(input.target);
  const childEnvironment = yield* buildSshChildEnvironment({
    ...(authOptions.authSecret === undefined ? {} : { authSecret: authOptions.authSecret }),
    ...(authOptions.interactiveAuth === undefined
      ? {}
      : { interactiveAuth: authOptions.interactiveAuth }),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["ssh"],
          exitCode: null,
          stderr: "",
          message: "Failed to prepare SSH authentication helpers.",
          cause,
        }),
    ),
  );
  const args = [
    ...baseSshArgs(input.target, {
      batchMode: authOptions.batchMode ?? (authOptions.interactiveAuth === true ? "no" : "yes"),
    }),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-n",
    "-N",
    "-L",
    `${input.localPort}:${LOOPBACK_HOST}:${input.remotePort}`,
    hostSpec,
  ];
  const sshCommand = yield* resolveSshCommand;
  const command = [sshCommand, ...args];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* Effect.logDebug("ssh.localForward.spawn.start", {
    ...sshTargetLogFields(input.target),
    command,
    localPort: input.localPort,
    remotePort: input.remotePort,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(sshCommand, args, {
        env: childEnvironment,
        extendEnv: true,
        stdin: { stream: Stream.empty, endOnDone: true },
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new SshCommandError({
            command,
            exitCode: null,
            stderr: "",
            message:
              cause instanceof Error
                ? cause.message
                : `Failed to spawn SSH local forward for ${input.target.alias}.`,
            cause,
          }),
      ),
    );
  yield* Effect.logDebug("ssh.localForward.spawn.succeeded", {
    ...sshTargetLogFields(input.target),
    command,
    pid: child.pid,
    localPort: input.localPort,
    remotePort: input.remotePort,
  });
  return { child, command };
});

/**
 * Fails as soon as the forward child exits. Raced against readiness so a
 * refused forward or a rejected host key surfaces its stderr immediately
 * instead of waiting out the startup timeout.
 */
export const sshLocalForwardExitFailure = (input: {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly command: readonly string[];
  readonly target: DesktopSshEnvironmentTarget;
  readonly fallbackMessage?: string;
}): Effect.Effect<never, SshCommandError> =>
  Effect.all(
    [collectProcessOutput(input.child.stderr), input.child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: input.command,
          exitCode: null,
          stderr: "",
          message:
            cause instanceof Error
              ? cause.message
              : `Failed to monitor SSH local forward for ${input.target.alias}.`,
          cause,
        }),
    ),
    Effect.flatMap(([stderr, exitCode]) =>
      Effect.logWarning("ssh.localForward.process.exited", {
        ...sshTargetLogFields(input.target),
        command: input.command,
        pid: input.child.pid,
        exitCode,
        stderr,
      }).pipe(
        Effect.andThen(
          Effect.fail(
            new SshCommandError({
              command: input.command,
              exitCode,
              stderr,
              message: normalizeSshErrorMessage(
                stderr,
                input.fallbackMessage ??
                  `SSH local forward exited unexpectedly for ${input.target.alias} (exit ${exitCode}).`,
              ),
            }),
          ),
        ),
      ),
    ),
  );

/**
 * One TCP connect against the forwarded loopback port. HTTP is deliberately not
 * spoken: the thing on the far side may be a WebSocket signaling socket, a
 * database, or anything else, and the only question here is whether `ssh` has
 * bound the local end yet.
 */
export type SshLocalForwardProbe = (port: number) => Effect.Effect<boolean>;

export const tcpConnectProbe: SshLocalForwardProbe = (port) =>
  Effect.callback<boolean>((resume) => {
    const socket = NodeNet.createConnection({ host: LOOPBACK_HOST, port });
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(Effect.succeed(value));
    };
    socket.unref();
    socket.setTimeout(READY_PROBE_CONNECT_TIMEOUT_MS);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
    return Effect.sync(() => {
      socket.destroy();
    });
  });

export interface SshLocalForwardOptions {
  readonly authOptions?: SshAuthOptions;
  /** Bounded wait for `ssh` to bind the local end. Default 10s. */
  readonly startupTimeoutMs?: number;
  /** Overridable so tests need neither a real `ssh` nor a real listener. */
  readonly probe?: SshLocalForwardProbe;
}

/** A live forward. `close` is idempotent and never fails. */
export interface SshLocalForward {
  readonly localPort: number;
  readonly remotePort: number;
  readonly close: Effect.Effect<void>;
}

/**
 * Opens a scoped `ssh -L` forward from an ephemeral loopback port to
 * `127.0.0.1:<remotePort>` on the target host, and resolves only once the local
 * end actually accepts a TCP connection.
 *
 * The forward is bound to the ambient `Scope`: closing that scope tears the
 * child down, and `close` does the same eagerly for callers whose lifetime is
 * not a scope (an Electron guest view, say). Every failure — a bad port, an
 * unreservable local port, a spawn failure, a dead child, a startup timeout —
 * arrives as one bounded `SshTunnelError` reason, and the child is always
 * killed before the failure escapes.
 */
export const openSshLocalForward = Effect.fn("ssh/localForward.openSshLocalForward")(function* (
  target: DesktopSshEnvironmentTarget,
  remotePort: number,
  options: SshLocalForwardOptions = {},
): Effect.fn.Return<
  SshLocalForward,
  SshTunnelError,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | NetService.NetService
  | Scope.Scope
> {
  if (!isValidTcpPort(remotePort)) {
    return yield* new SshTunnelError({
      reason: "invalid_port",
      message: "The remote forward port is not a valid TCP port.",
    });
  }

  const net = yield* NetService.NetService;
  const localPort = yield* net.reserveLoopbackPort(LOOPBACK_HOST).pipe(
    Effect.mapError(
      (cause) =>
        new SshTunnelError({
          reason: "local_port_unavailable",
          message: "No local loopback port could be reserved for the SSH forward.",
          cause,
        }),
    ),
  );

  // The forward gets its own scope so `close` can tear it down on its own,
  // while the ambient scope still guarantees cleanup if the caller never does.
  const forwardScope = yield* Scope.make("sequential");
  const close = Scope.close(forwardScope, Exit.void).pipe(Effect.ignore);
  yield* Effect.addFinalizer(() => close);

  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const probe = options.probe ?? tcpConnectProbe;

  const spawned = yield* spawnSshLocalForwardProcess({
    target,
    localPort,
    remotePort,
    ...(options.authOptions === undefined ? {} : { authOptions: options.authOptions }),
  }).pipe(
    Effect.provideService(Scope.Scope, forwardScope),
    Effect.mapError(
      (cause) =>
        new SshTunnelError({
          reason: cause._tag === "SshInvalidTargetError" ? "invalid_target" : "spawn_failed",
          message: "The SSH local forward could not be started.",
          cause,
        }),
    ),
  );

  // Spawning into a scope is not by itself a kill: the tunnel manager has
  // always had to kill its child explicitly, so the forward owns the same
  // finalizer. It runs before the spawner's own, and `close` is the only path
  // that reaches it — from the caller, from the ambient scope, or from a
  // failed readiness gate below.
  yield* Scope.addFinalizer(
    forwardScope,
    spawned.child
      .kill({ killSignal: "SIGTERM", forceKillAfter: FORWARD_SHUTDOWN_TIMEOUT_MS })
      .pipe(Effect.ignore),
  );

  const startupTimeout = new SshTunnelError({
    reason: "startup_timeout",
    message: `The SSH local forward did not accept connections within ${startupTimeoutMs}ms.`,
  });
  // Bounded by attempt count rather than a wall clock: each probe is itself
  // bounded by its connect timeout, so the loop cannot outlive the budget.
  const readyPolicy = Schedule.spaced(Duration.millis(READY_PROBE_INTERVAL_MS)).pipe(
    Schedule.upTo({ times: Math.max(0, Math.ceil(startupTimeoutMs / READY_PROBE_INTERVAL_MS)) }),
  );
  const waitForLocalPort = probe(localPort).pipe(
    Effect.flatMap(
      (ready): Effect.Effect<void, SshTunnelError> =>
        ready ? Effect.void : Effect.fail(startupTimeout),
    ),
    Effect.retry(readyPolicy),
  );

  const exitFailure = sshLocalForwardExitFailure({
    child: spawned.child,
    command: spawned.command,
    target,
    fallbackMessage: `SSH local forward exited before it was ready for ${target.alias}.`,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SshTunnelError({
          reason: "process_exited",
          message: "The SSH local forward exited before it was ready.",
          cause,
        }),
    ),
  );

  yield* Effect.raceFirst(waitForLocalPort, exitFailure).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.logInfo("ssh.localForward.ready", {
            ...sshTargetLogFields(target),
            pid: spawned.child.pid,
            localPort,
            remotePort,
          })
        : close,
    ),
  );

  return { localPort, remotePort, close };
});
