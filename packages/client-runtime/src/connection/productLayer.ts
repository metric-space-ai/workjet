import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ConnectionDriver from "./driver.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as ProductResolver from "./productResolver.ts";
import * as PlatformConnectionSource from "../platform/source.ts";
import * as RpcSession from "../rpc/session.ts";

const driverLayer = ConnectionDriver.layer.pipe(
  Layer.provide(Layer.mergeAll(ProductResolver.layer, RpcSession.layer)),
);
const registryLayer = EnvironmentRegistry.layer.pipe(Layer.provide(driverLayer));

const startupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const platformSource = yield* PlatformConnectionSource.PlatformConnectionSource;
    const registrations = yield* platformSource.registrations.pipe(
      Stream.broadcast({ capacity: 1, strategy: "sliding", replay: 1 }),
    );
    const initial = yield* Stream.runHead(registrations);
    if (Option.isSome(initial)) {
      yield* registry.reconcilePlatform(initial.value);
    }
    yield* registry.start;
    yield* registrations.pipe(Stream.runForEach(registry.reconcilePlatform), Effect.forkScoped);
  }).pipe(Effect.withSpan("clientRuntime.connection.product.start")),
);

export const productLayer = startupLayer.pipe(Layer.provideMerge(registryLayer));
