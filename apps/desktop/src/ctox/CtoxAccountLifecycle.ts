import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export interface AccountInvalidation {
  readonly reason: "account-transition" | "logout";
  readonly sessionEpoch: number;
}

export type AccountInvalidator = (change: AccountInvalidation) => Promise<void>;

export class CtoxAccountInvalidationError extends Schema.TaggedErrorClass<CtoxAccountInvalidationError>()(
  "CtoxAccountInvalidationError",
  {},
) {
  override get message(): string {
    return "Workjet could not finish closing the previous account session. Please try again.";
  }
}

export interface AccountLifecycle {
  readonly registerInvalidator: (invalidate: AccountInvalidator) => () => void;
  readonly sessionEpoch: () => number;
  readonly isCurrent: (sessionEpoch: number) => boolean;
  /** Host-only: call after independently verifying the current native principal. */
  readonly confirmSession: (sessionEpoch: number) => boolean;
  readonly transition: <A, E, R>(
    reason: AccountInvalidation["reason"],
    operation: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | CtoxAccountInvalidationError, R>;
}

export class CtoxAccountLifecycle extends Context.Service<CtoxAccountLifecycle, AccountLifecycle>()(
  "@workjet/desktop/ctox/CtoxAccountLifecycle",
) {}

export const make = Effect.gen(function* () {
  const lock = yield* Semaphore.make(1);
  const invalidators = new Set<AccountInvalidator>();
  let sessionEpoch = 0;
  let phase: "invalidating" | "awaiting-authority" | "ready" = "awaiting-authority";

  return CtoxAccountLifecycle.of({
    registerInvalidator: (invalidate) => {
      // A consumer cannot join halfway through a transition and miss its invalidation.
      if (phase === "invalidating") throw new CtoxAccountInvalidationError();
      invalidators.add(invalidate);
      return () => {
        invalidators.delete(invalidate);
      };
    },
    sessionEpoch: () => sessionEpoch,
    isCurrent: (candidate) => phase === "ready" && candidate === sessionEpoch,
    confirmSession: (candidate) => {
      if (phase === "invalidating" || candidate !== sessionEpoch) return false;
      phase = "ready";
      return true;
    },
    transition: (reason, operation) =>
      lock.withPermit(
        Effect.gen(function* () {
          // Fence both new opens and results from old requests before any asynchronous work.
          phase = "invalidating";
          sessionEpoch += 1;
          const change = { reason, sessionEpoch };
          const callbacks = [...invalidators];
          yield* Effect.tryPromise({
            try: async () => {
              // Wait for every consumer, including when one rejects or throws synchronously.
              const results = await Promise.allSettled(
                callbacks.map((invalidate) => Promise.resolve().then(() => invalidate(change))),
              );
              if (results.some((result) => result.status === "rejected")) {
                throw new CtoxAccountInvalidationError();
              }
            },
            catch: () => new CtoxAccountInvalidationError(),
          }).pipe(Effect.uninterruptible);
          const result = yield* operation;
          // Login success is not native authority. Cancellation also leaves old handles fenced.
          phase = "awaiting-authority";
          return result;
        }),
      ),
  });
});

export const layer = Layer.effect(CtoxAccountLifecycle, make);
