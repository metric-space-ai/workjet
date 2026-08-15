// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import type { CtoxManagedInstance } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type { Session } from "electron";
import { session } from "electron";

import { ctoxManagedSessionPartition } from "./CtoxManagedDiscovery.ts";

export const CTOX_CONTROL_PLANE_PARTITION = "persist:workjet-ctox-control-plane";

const ALLOWED_INSTANCE_PERMISSIONS: ReadonlySet<string> = new Set([
  "notifications",
  "clipboard-sanitized-write",
]);

const CtoxElectronSessionOperation = Schema.Literals([
  "resolve-account",
  "resolve-instance",
  "clear-instance-storage",
  "clear-instance-cache",
]);

export class CtoxElectronSessionDescriptorError extends Schema.TaggedErrorClass<CtoxElectronSessionDescriptorError>()(
  "CtoxElectronSessionDescriptorError",
  {},
) {
  override get message(): string {
    return "The CTOX instance session descriptor is invalid.";
  }
}

export class CtoxElectronSessionOperationError extends Schema.TaggedErrorClass<CtoxElectronSessionOperationError>()(
  "CtoxElectronSessionOperationError",
  {
    operation: CtoxElectronSessionOperation,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "The CTOX Electron session operation failed.";
  }
}

export const CtoxElectronSessionsError = Schema.Union([
  CtoxElectronSessionDescriptorError,
  CtoxElectronSessionOperationError,
]);
export type CtoxElectronSessionsError = typeof CtoxElectronSessionsError.Type;
export const isCtoxElectronSessionsError = Schema.is(CtoxElectronSessionsError);

export class CtoxElectronSessions extends Context.Service<
  CtoxElectronSessions,
  {
    readonly account: Effect.Effect<Session, CtoxElectronSessionOperationError>;
    readonly instance: (
      descriptor: CtoxManagedInstance,
    ) => Effect.Effect<Session, CtoxElectronSessionsError>;
    readonly clearInstance: (
      descriptor: CtoxManagedInstance,
    ) => Effect.Effect<void, CtoxElectronSessionsError>;
  }
>()("@t3tools/desktop/ctox/CtoxElectronSessions") {}

function installPermissionPolicy(browserSession: Session, account: boolean): void {
  browserSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(!account && ALLOWED_INSTANCE_PERMISSIONS.has(permission));
  });
  browserSession.setPermissionCheckHandler(
    (_webContents, permission) => !account && ALLOWED_INSTANCE_PERMISSIONS.has(permission),
  );
}

export const make = Effect.gen(function* () {
  const sessionsRef = yield* SynchronizedRef.make<ReadonlyMap<string, Session>>(new Map());

  const resolve = (
    partition: string,
    account: boolean,
    operation: "resolve-account" | "resolve-instance",
  ) =>
    SynchronizedRef.modifyEffect(sessionsRef, (sessions) => {
      const existing = sessions.get(partition);
      if (existing !== undefined) return Effect.succeed([existing, sessions] as const);

      return Effect.try({
        try: () => {
          const browserSession = session.fromPartition(partition);
          installPermissionPolicy(browserSession, account);
          const next = new Map(sessions);
          next.set(partition, browserSession);
          return [browserSession, next] as const;
        },
        catch: (cause) => new CtoxElectronSessionOperationError({ operation, cause }),
      });
    });

  const account = resolve(CTOX_CONTROL_PLANE_PARTITION, true, "resolve-account");

  const validateInstance = (
    descriptor: CtoxManagedInstance,
  ): Effect.Effect<string, CtoxElectronSessionDescriptorError> => {
    const expectedPartition = ctoxManagedSessionPartition({
      source: descriptor.source,
      id: descriptor.id,
    });
    if (
      descriptor.sessionPartition !== expectedPartition ||
      expectedPartition === CTOX_CONTROL_PLANE_PARTITION
    ) {
      return Effect.fail(new CtoxElectronSessionDescriptorError());
    }
    return Effect.succeed(expectedPartition);
  };

  const instance = Effect.fn("CtoxElectronSessions.instance")(function* (
    descriptor: CtoxManagedInstance,
  ) {
    const partition = yield* validateInstance(descriptor);
    return yield* resolve(partition, false, "resolve-instance");
  });

  return CtoxElectronSessions.of({
    account,
    instance,
    clearInstance: Effect.fn("CtoxElectronSessions.clearInstance")(function* (
      descriptor: CtoxManagedInstance,
    ) {
      const browserSession = yield* instance(descriptor);
      yield* Effect.all(
        [
          Effect.tryPromise({
            try: () =>
              browserSession.clearStorageData({
                storages: ["cookies", "localstorage", "indexdb", "cachestorage", "serviceworkers"],
              }),
            catch: (cause) =>
              new CtoxElectronSessionOperationError({
                operation: "clear-instance-storage",
                cause,
              }),
          }),
          Effect.tryPromise({
            try: () => browserSession.clearCache(),
            catch: (cause) =>
              new CtoxElectronSessionOperationError({
                operation: "clear-instance-cache",
                cause,
              }),
          }),
        ],
        { concurrency: "unbounded", discard: true },
      );
    }),
  });
}).pipe(Effect.withSpan("CtoxElectronSessions.make"));

export const layer = Layer.effect(CtoxElectronSessions, make);
