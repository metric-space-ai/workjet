import type { DesktopSshEnvironmentTarget } from "@workjet/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import type { SshAuthOptions } from "./auth.ts";
import { SshTunnelError } from "./errors.ts";
import {
  isValidTcpPort,
  spawnSshLocalForwardProcess,
  sshLocalForwardExitFailure,
} from "./localForward.ts";

/** The source Node service owns this scope. The registered target service must
 * allocate remotePort and verify the pinned source worker channel through it;
 * a successful SSH spawn alone is never considered an authenticated connection. */
export const openSshReverseForward = Effect.fn("ssh.openSshReverseForward")(function* (
  target: DesktopSshEnvironmentTarget,
  ports: { readonly localPort: number; readonly remotePort: number },
  options: {
    readonly authOptions?: SshAuthOptions;
    readonly probe: () => Effect.Effect<boolean>;
  },
) {
  if (!isValidTcpPort(ports.localPort) || !isValidTcpPort(ports.remotePort))
    return yield* new SshTunnelError({
      reason: "invalid_port",
      message: "Invalid worker forward port.",
    });
  const scope = yield* Scope.make("sequential");
  const close = Scope.close(scope, Exit.void).pipe(Effect.ignore);
  yield* Effect.addFinalizer(() => close);
  const spawned = yield* spawnSshLocalForwardProcess({
    target,
    ...ports,
    direction: "reverse",
    ...(options.authOptions ? { authOptions: options.authOptions } : {}),
  }).pipe(
    Effect.provideService(Scope.Scope, scope),
    Effect.mapError(
      (cause) =>
        new SshTunnelError({
          reason: "spawn_failed",
          message: "Worker reverse forward failed.",
          cause,
        }),
    ),
    Effect.onError(() => close),
  );
  yield* Scope.addFinalizer(
    scope,
    spawned.child.kill({ killSignal: "SIGTERM", forceKillAfter: 2000 }).pipe(Effect.ignore),
  );
  const timeout = new SshTunnelError({
    reason: "startup_timeout",
    message: "Worker reverse forward verification timed out.",
  });
  const ready = Effect.suspend(options.probe).pipe(
    Effect.flatMap((valid) => (valid ? Effect.void : Effect.fail(timeout))),
    Effect.retry(Schedule.spaced("100 millis").pipe(Schedule.upTo({ times: 20 }))),
    Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(timeout) }),
  );
  const lost = sshLocalForwardExitFailure({ ...spawned, target }).pipe(
    Effect.mapError(
      (cause) =>
        new SshTunnelError({
          reason: "process_exited",
          message: "Worker reverse forward disconnected.",
          cause,
        }),
    ),
  );
  yield* Effect.raceFirst(ready, lost).pipe(Effect.onError(() => close));
  // Consumers race operations against this signal. Reconnection must repeat
  // registered identity verification; never reconnect via a caller-supplied URL.
  return { ...ports, close, disconnected: lost };
});
