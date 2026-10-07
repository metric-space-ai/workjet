// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { DesktopSshEnvironmentTarget } from "@workjet/contracts";
import type { SshAuthOptions } from "@workjet/ssh/auth";
import { openSshReverseForward } from "@workjet/ssh/reverseForward";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import {
  openWorkerSourceChannel,
  type WorkerSourceIdentity,
  type WorkerSourceRoute,
  type WorkerSourceOperation,
} from "./RemoteWorkerSourceChannel.ts";

export class WorkerSourceReconnectRequired extends Schema.TaggedErrorClass<WorkerSourceReconnectRequired>()(
  "WorkerSourceReconnectRequired",
  { requestId: Schema.String },
) {}

export interface RegisteredWorkerTarget {
  readonly target: DesktopSshEnvironmentTarget;
  /** Allocated by the registered target service, not from worker task input. */
  readonly remotePort: number;
  readonly authOptions?: SshAuthOptions;
  /** Verify source identity via the target's registered authenticated RPC. */
  readonly verifyRoute: (route: WorkerSourceRoute) => Effect.Effect<boolean>;
}

/** Acquire in the source Node service scope. Root's resolver rechecks registered
 * SSH profile, current native assignment and remote environment identity. It
 * never resolves from task-supplied hostnames, URLs or provider credentials.
 * A dropped channel revokes this capability and returns a typed reconnect need;
 * its owner must re-resolve current registration before opening another channel. */
export const openManagedWorkerSourceConnection = Effect.fn(
  "workjet.openManagedWorkerSourceConnection",
)(function* (
  input: WorkerSourceIdentity & { readonly expiresAtMs: number },
  dependencies: {
    readonly resolveRegisteredTarget: Effect.Effect<
      RegisteredWorkerTarget,
      WorkerSourceReconnectRequired
    >;
    readonly invoke: (
      operation: WorkerSourceOperation,
      payload: unknown,
      signal: AbortSignal,
    ) => Promise<unknown>;
    /** Bootstrap publishes a pending route before target proof can arrive. */
    readonly onRoute?: (route: WorkerSourceRoute) => Effect.Effect<void>;
  },
) {
  const registered = yield* dependencies.resolveRegisteredTarget;
  const listener = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: openWorkerSourceChannel,
      catch: () => new WorkerSourceReconnectRequired({ requestId: input.requestId }),
    }),
    (channel) => Effect.promise(channel.close),
  );
  const retired = yield* Deferred.make<void>();
  const local = yield* Effect.try({
    try: () =>
      listener.issue({
        ...input,
        invoke: dependencies.invoke,
        onRetired: () => {
          Effect.runSync(Deferred.succeed(retired, undefined));
        },
      }),
    catch: () => new WorkerSourceReconnectRequired({ requestId: input.requestId }),
  });
  const route: WorkerSourceRoute = { ...local, port: registered.remotePort };
  if (dependencies.onRoute) yield* dependencies.onRoute(route);
  const forward = yield* openSshReverseForward(
    registered.target,
    {
      localPort: listener.port,
      remotePort: registered.remotePort,
    },
    {
      ...(registered.authOptions ? { authOptions: registered.authOptions } : {}),
      probe: () => registered.verifyRoute(route),
    },
  ).pipe(
    Effect.mapError(() => new WorkerSourceReconnectRequired({ requestId: input.requestId })),
    Effect.onError(() => Effect.promise(listener.close)),
  );
  const ended = yield* Deferred.make<void, WorkerSourceReconnectRequired>();
  const disconnected = Effect.raceFirst(forward.disconnected, Deferred.await(retired)).pipe(
    Effect.onExit(() =>
      Effect.promise(async () => {
        listener.revoke(input.requestId);
        await listener.close();
      }).pipe(Effect.andThen(forward.close)),
    ),
    Effect.mapError(() => new WorkerSourceReconnectRequired({ requestId: input.requestId })),
  );
  yield* disconnected.pipe(
    Effect.andThen(Deferred.succeed(ended, undefined)),
    Effect.catch((error) => Deferred.fail(ended, error)),
    Effect.forkScoped,
  );
  return {
    route,
    disconnected: Deferred.await(ended),
    /** Idempotent, and aborts source native/provider work still in flight. */
    close: Effect.promise(async () => {
      listener.revoke(input.requestId);
      await listener.close();
    }).pipe(Effect.andThen(forward.close)),
  };
});
