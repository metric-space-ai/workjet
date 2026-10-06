import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import type { WebContents } from "electron";
import { vi } from "vite-plus/test";

import * as DesktopIpc from "./DesktopIpc.ts";

const invokeMethod: DesktopIpc.DesktopIpcMethod<never, never> = {
  channel: "desktop.test.invoke",
  handler: () => Effect.void,
};

const syncMethod: DesktopIpc.DesktopSyncIpcMethod<never, never> = {
  channel: "desktop.test.sync",
  handler: () => Effect.void,
};

function makeIpcMain(
  overrides: Partial<DesktopIpc.DesktopIpcMain> = {},
): DesktopIpc.DesktopIpcMain {
  return {
    removeHandler: vi.fn(),
    handle: vi.fn(),
    removeAllListeners: vi.fn(),
    on: vi.fn(),
    ...overrides,
  };
}

describe("DesktopIpc", () => {
  it.effect(
    "preserves native invocation identity across concurrent handlers without trusting payload identity",
    () =>
      Effect.gen(function* () {
        let listener: DesktopIpc.DesktopIpcHandleListener | undefined;
        const ipc = DesktopIpc.make(
          makeIpcMain({
            handle: (_channel, value) => {
              listener = value;
            },
          }),
        );
        const entered = yield* Deferred.make<void>();
        const proceed = yield* Deferred.make<void>();
        const senderA = {} as WebContents;
        const senderB = {} as WebContents;
        const eventA = { sender: senderA };
        const eventB = { sender: senderB };
        yield* ipc.handle({
          channel: "test.identity",
          handler: (raw) =>
            Effect.gen(function* () {
              const before = yield* DesktopIpc.DesktopIpcInvocation;
              if (raw === "wait") {
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(proceed);
              }
              return { before, after: yield* DesktopIpc.DesktopIpcInvocation };
            }),
        });
        assert.isDefined(listener);
        const invoke = listener;
        const first = yield* Effect.promise(() => Promise.resolve(invoke(eventA, "wait"))).pipe(
          Effect.forkChild,
        );
        yield* Deferred.await(entered);
        assert.deepEqual(
          yield* Effect.promise(() => Promise.resolve(invoke(eventB, { sender: senderA }))),
          { before: eventB, after: eventB },
        );
        yield* Deferred.succeed(proceed, undefined);
        assert.deepEqual(yield* Fiber.join(first), { before: eventA, after: eventA });
        assert.isUndefined(yield* DesktopIpc.DesktopIpcInvocation);
      }).pipe(Effect.scoped),
  );

  it.effect("provides native identity to synchronous methods only for that invocation", () =>
    Effect.gen(function* () {
      let listener: DesktopIpc.DesktopIpcSyncListener | undefined;
      const ipc = DesktopIpc.make(
        makeIpcMain({
          on: (_channel, value) => {
            listener = value;
          },
        }),
      );
      yield* ipc.handleSync({
        channel: "test.syncIdentity",
        handler: () => DesktopIpc.DesktopIpcInvocation,
      });
      const event: DesktopIpc.DesktopIpcSyncEvent = {
        sender: {} as WebContents,
        returnValue: undefined,
      };
      assert.isDefined(listener);
      listener(event);
      assert.strictEqual(event.returnValue, event);
      assert.isUndefined(yield* DesktopIpc.DesktopIpcInvocation);
    }).pipe(Effect.scoped),
  );

  it.effect("preserves invoke registration context and cause", () =>
    Effect.gen(function* () {
      const cause = new Error("invoke registration failed");
      const ipcMain = makeIpcMain({
        handle: () => {
          throw cause;
        },
      });
      const ipc = DesktopIpc.make(ipcMain);

      const error = yield* Effect.flip(Effect.scoped(ipc.handle(invokeMethod)));

      assert.instanceOf(error, DesktopIpc.DesktopIpcRegistrationError);
      assert.isTrue(DesktopIpc.isDesktopIpcError(error));
      assert.strictEqual(error.handlerKind, "invoke");
      assert.strictEqual(error.channel, invokeMethod.channel);
      assert.strictEqual(error.cause, cause);
      assert.include(error.message, "invoke");
      assert.include(error.message, invokeMethod.channel);
      assert.notInclude(error.message, cause.message);
    }),
  );

  it.effect("preserves sync unregistration context and cause in the finalizer defect", () =>
    Effect.gen(function* () {
      const cause = new Error("sync unregistration failed");
      let removeCount = 0;
      const ipcMain = makeIpcMain({
        removeAllListeners: () => {
          removeCount += 1;
          if (removeCount === 2) throw cause;
        },
      });
      const ipc = DesktopIpc.make(ipcMain);

      const exit = yield* Effect.exit(Effect.scoped(ipc.handleSync(syncMethod)));

      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Success") return;
      const error = Cause.squash(exit.cause);
      assert.instanceOf(error, DesktopIpc.DesktopIpcUnregistrationError);
      assert.isTrue(DesktopIpc.isDesktopIpcError(error));
      assert.strictEqual(error.handlerKind, "sync");
      assert.strictEqual(error.channel, syncMethod.channel);
      assert.strictEqual(error.cause, cause);
      assert.notInclude(error.message, cause.message);
    }),
  );
});
