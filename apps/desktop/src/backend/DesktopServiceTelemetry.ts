import {
  DesktopHostTelemetryMessage,
  type DesktopTelemetryControlMessage,
  WS_METHODS,
} from "@workjet/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/unstable/encoding/Ndjson";
import type { RunBackendProcessOptions } from "./DesktopBackendManager.ts";

export class DesktopServiceTelemetryError extends Schema.TaggedErrorClass<DesktopServiceTelemetryError>()(
  "DesktopServiceTelemetryError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface TelemetrySession {
  readonly initialConfig: Effect.Effect<
    { readonly environment: { readonly runtimeInstanceId?: string } },
    Error
  >;
  readonly closed: Effect.Effect<never, Error>;
  readonly client: {
    readonly [WS_METHODS.subscribeDesktopTelemetryControl]: (input: {
      readonly attachmentId: string;
      readonly runtimeInstanceId: string;
    }) => Stream.Stream<DesktopTelemetryControlMessage, Error>;
    readonly [WS_METHODS.serverPublishDesktopTelemetry]: (input: {
      readonly attachmentId: string;
      readonly runtimeInstanceId: string;
      readonly message: DesktopHostTelemetryMessage;
    }) => Effect.Effect<void, Error>;
  };
}

/** Both pumps belong to the attachment scope; neither owns the server process. */
export const attachDesktopServiceTelemetry = Effect.fn("desktop.serviceTelemetry.attach")(
  function* (session: TelemetrySession, input: RunBackendProcessOptions) {
    const crypto = yield* Crypto.Crypto;
    const attachmentId = yield* crypto.randomUUIDv4;
    const runtimeInstanceId = (yield* session.initialConfig).environment.runtimeInstanceId;
    if (runtimeInstanceId === undefined)
      return yield* new DesktopServiceTelemetryError({
        reason: "Service telemetry requires a current runtime generation.",
      });
    const binding = { attachmentId, runtimeInstanceId };
    const controlsReady = yield* Deferred.make<void, DesktopServiceTelemetryError>();
    const firstSnapshot = yield* Deferred.make<void, DesktopServiceTelemetryError>();
    const closed = yield* Deferred.make<never, DesktopServiceTelemetryError>();
    const failed = (reason: string) => {
      const error = new DesktopServiceTelemetryError({ reason });
      return Effect.all([
        Deferred.fail(controlsReady, error),
        Deferred.fail(firstSnapshot, error),
        Deferred.fail(closed, error),
      ]).pipe(Effect.asVoid);
    };
    yield* session.client[WS_METHODS.subscribeDesktopTelemetryControl](binding).pipe(
      Stream.runForEach((message) =>
        Effect.gen(function* () {
          yield* input.onDesktopTelemetryControl?.(message) ?? Effect.void;
          yield* Deferred.succeed(controlsReady, undefined);
        }),
      ),
      Effect.andThen(failed("Service telemetry control subscription closed.")),
      Effect.catch(() => failed("Service telemetry control subscription failed.")),
      Effect.forkScoped,
    );
    yield* Effect.gen(function* () {
      yield* Deferred.await(controlsReady);
      yield* input.desktopTelemetryStream.pipe(
        Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
        Stream.mapEffect(Schema.decodeUnknownEffect(DesktopHostTelemetryMessage)),
        Stream.runForEach((message) =>
          Effect.gen(function* () {
            yield* session.client[WS_METHODS.serverPublishDesktopTelemetry]({
              ...binding,
              message,
            });
            if (message.type === "desktopTelemetry")
              yield* Deferred.succeed(firstSnapshot, undefined);
          }),
        ),
      );
      yield* failed("Desktop telemetry publisher closed.");
    }).pipe(
      Effect.catch(() => failed("Desktop telemetry publication failed.")),
      Effect.forkScoped,
    );
    yield* Deferred.await(firstSnapshot).pipe(
      Effect.timeout("20 seconds"),
      Effect.mapError(
        () =>
          new DesktopServiceTelemetryError({
            reason: "No authenticated Desktop telemetry snapshot was acknowledged.",
          }),
      ),
    );
    return { closed: Effect.raceFirst(session.closed, Deferred.await(closed)) };
  },
);
