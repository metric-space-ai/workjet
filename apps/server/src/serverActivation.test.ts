import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { forkParked, ServerActivation } from "./serverActivation.ts";

it.effect("proves a root is parked before returning and releases it with one gate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const activation = yield* Deferred.make<void>();
      const ran = yield* Deferred.make<void>();

      yield* forkParked(Deferred.succeed(ran, undefined)).pipe(
        Effect.provideService(ServerActivation, Deferred.await(activation)),
      );
      expect(yield* Deferred.isDone(ran)).toBe(false);

      yield* Deferred.succeed(activation, undefined);
      yield* Deferred.await(ran);
      expect(yield* Deferred.isDone(ran)).toBe(true);
    }),
  ),
);

it.effect(
  "receives the first published event when starting a root without an activation gate",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<string>();
        const received = yield* Deferred.make<string>();

        yield* forkParked(
          Stream.runForEach(Stream.fromPubSub(events), (value) =>
            Deferred.succeed(received, value),
          ),
        );
        yield* PubSub.publish(events, "first");
        expect(yield* Deferred.await(received).pipe(Effect.timeout("1 second"))).toBe("first");
      }),
    ),
);
