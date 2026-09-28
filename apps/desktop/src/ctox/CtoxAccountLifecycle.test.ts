import { describe, it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Lifecycle from "./CtoxAccountLifecycle.ts";

describe("account session lifecycle", () => {
  it.effect("requires authority and rejects late results after a completed transition", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.make;
      expect(lifecycle.isCurrent(0)).toBe(false);
      expect(lifecycle.confirmSession(0)).toBe(true);
      yield* lifecycle.transition("account-transition", Effect.void);
      expect(lifecycle.isCurrent(0)).toBe(false);
      expect(lifecycle.isCurrent(1)).toBe(false);
      expect(lifecycle.confirmSession(0)).toBe(false);
      expect(lifecycle.confirmSession(1)).toBe(true);
      expect(lifecycle.isCurrent(1)).toBe(true);
    }),
  );

  it.effect(
    "fences opens before callbacks and waits for cleanup before the account operation",
    () =>
      Effect.gen(function* () {
        const lifecycle = yield* Lifecycle.make;
        lifecycle.confirmSession(0);
        const entered = Promise.withResolvers<void>();
        const cleanup = Promise.withResolvers<void>();
        const events: string[] = [];
        lifecycle.registerInvalidator(async ({ reason, sessionEpoch }) => {
          expect(reason).toBe("account-transition");
          expect(sessionEpoch).toBe(1);
          expect(lifecycle.isCurrent(0)).toBe(false);
          expect(lifecycle.confirmSession(1)).toBe(false);
          expect(() => lifecycle.registerInvalidator(async () => {})).toThrow();
          events.push("invalidate");
          entered.resolve();
          await cleanup.promise;
          events.push("clean");
        });
        const running = yield* Effect.forkChild(
          lifecycle.transition(
            "account-transition",
            Effect.sync(() => {
              events.push("login");
            }),
          ),
        );
        yield* Effect.promise(() => entered.promise);
        expect(events).toEqual(["invalidate"]);
        cleanup.resolve();
        yield* Fiber.join(running);
        expect(events).toEqual(["invalidate", "clean", "login"]);
        expect(lifecycle.isCurrent(1)).toBe(false);
      }),
  );

  it.effect(
    "awaits other consumers after a synchronous callback failure and never opens the login",
    () =>
      Effect.gen(function* () {
        const lifecycle = yield* Lifecycle.make;
        const entered = Promise.withResolvers<void>();
        const cleanup = Promise.withResolvers<void>();
        let loginOpened = false;
        lifecycle.registerInvalidator(() => {
          throw new Error("consumer failed");
        });
        lifecycle.registerInvalidator(async () => {
          entered.resolve();
          await cleanup.promise;
        });
        let settled = false;
        const running = yield* Effect.forkChild(
          Effect.exit(
            lifecycle.transition(
              "account-transition",
              Effect.sync(() => {
                loginOpened = true;
              }),
            ),
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                settled = true;
              }),
            ),
          ),
        );
        yield* Effect.promise(() => entered.promise);
        expect(settled).toBe(false);
        cleanup.resolve();
        expect((yield* Fiber.join(running))._tag).toBe("Failure");
        expect(loginOpened).toBe(false);
        expect(lifecycle.confirmSession(1)).toBe(false);
      }),
  );

  it.effect("serializes login and logout through the complete account operation", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.make;
      const entered = Promise.withResolvers<void>();
      const login = Promise.withResolvers<void>();
      const events: string[] = [];
      lifecycle.registerInvalidator(async ({ reason }) => {
        events.push(reason);
      });
      const first = yield* Effect.forkChild(
        lifecycle.transition(
          "account-transition",
          Effect.promise(async () => {
            entered.resolve();
            await login.promise;
            events.push("login done");
          }),
        ),
      );
      yield* Effect.promise(() => entered.promise);
      const second = yield* Effect.forkChild(
        lifecycle.transition(
          "logout",
          Effect.sync(() => {
            events.push("logout done");
          }),
        ),
      );
      expect(events).toEqual(["account-transition"]);
      login.resolve();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(events).toEqual(["account-transition", "login done", "logout", "logout done"]);
      expect(lifecycle.sessionEpoch()).toBe(2);
      expect(lifecycle.confirmSession(1)).toBe(false);
    }),
  );

  it.effect("does not restore old authority when an account operation fails", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.make;
      lifecycle.confirmSession(0);
      const exit = yield* Effect.exit(
        lifecycle.transition("account-transition", Effect.fail("login failed")),
      );
      expect(exit._tag).toBe("Failure");
      expect(lifecycle.isCurrent(0)).toBe(false);
      expect(lifecycle.confirmSession(1)).toBe(false);
      yield* lifecycle.transition("account-transition", Effect.void);
      expect(lifecycle.confirmSession(2)).toBe(true);
    }),
  );

  it.effect("unregisters a disposed consumer", () =>
    Effect.gen(function* () {
      const lifecycle = yield* Lifecycle.make;
      let calls = 0;
      const unregister = lifecycle.registerInvalidator(async () => {
        calls += 1;
      });
      unregister();
      yield* lifecycle.transition("logout", Effect.void);
      expect(calls).toBe(0);
    }),
  );

  it.effect(
    "does not release an interrupted transition while consumer cleanup is still running",
    () =>
      Effect.gen(function* () {
        const lifecycle = yield* Lifecycle.make;
        const entered = Promise.withResolvers<void>();
        const cleanup = Promise.withResolvers<void>();
        const events: string[] = [];
        lifecycle.registerInvalidator(async ({ sessionEpoch }) => {
          events.push("invalidate " + sessionEpoch);
          if (sessionEpoch === 1) {
            entered.resolve();
            await cleanup.promise;
          }
        });
        const first = yield* Effect.forkChild(
          lifecycle.transition(
            "account-transition",
            Effect.sync(() => {
              events.push("login");
            }),
          ),
        );
        yield* Effect.promise(() => entered.promise);
        const interrupt = yield* Effect.forkChild(Fiber.interrupt(first), {
          startImmediately: true,
        });
        const second = yield* Effect.forkChild(
          lifecycle.transition(
            "logout",
            Effect.sync(() => {
              events.push("logout");
            }),
          ),
        );
        expect(lifecycle.confirmSession(1)).toBe(false);
        expect(events).toEqual(["invalidate 1"]);
        cleanup.resolve();
        yield* Fiber.join(interrupt);
        yield* Fiber.join(second);
        expect(events).toEqual(["invalidate 1", "invalidate 2", "logout"]);
      }),
  );
});
