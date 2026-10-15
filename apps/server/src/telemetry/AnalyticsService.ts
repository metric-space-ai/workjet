/**
 * Analytics service without any delivery.
 *
 * Owner rule (Michael, 2026-10-15): Workjet transmits no data anywhere. The
 * service keeps its interface so callers stay unchanged, but `record` and
 * `flush` never buffer, identify, or send anything, regardless of a stored
 * `posthogConsent` or any environment variable. There is no built-in key and
 * no endpoint.
 *
 * @module AnalyticsService
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Accepts an event and drops it; nothing leaves this machine. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;

    /** Nothing is ever queued, so there is nothing to flush. */
    readonly flush: Effect.Effect<void>;
  }
>()("workjet/telemetry/AnalyticsService") {
  /** No-op layer; identical to the production layer. */
  static readonly layerTest = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      record: () => Effect.void,
      flush: Effect.void,
    }),
  );
}

/** Production layer: never sends, even with stored consent. */
export const layer = AnalyticsService.layerTest;

export const layerTest = AnalyticsService.layerTest;
