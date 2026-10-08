import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import { makeCtoxMcpTransport, type CtoxMcpTarget } from "./CtoxMcpTransport.ts";

export const CTOX_LUMA_READ_TOOL = "business_os.luma_configuration_read";
export const CTOX_LUMA_UPDATE_TOOL = "business_os.luma_configuration_update";

export class CtoxLumaConfigurationError extends Schema.TaggedErrorClass<CtoxLumaConfigurationError>()(
  "CtoxLumaConfigurationError",
  {
    reason: Schema.Literals(["connection-unavailable", "remote-response-invalid"]),
  },
) {}

export interface CtoxLumaConfigurationDocument {
  readonly revision: number;
  readonly configuration: Readonly<Record<string, unknown>> | null;
  readonly updatedAtMs: number | null;
}

export type CtoxLumaConfigurationSaveResult =
  | { readonly status: "saved"; readonly revision: number }
  | { readonly status: "conflict"; readonly revision: number };

const Revision = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const ReadResult = Schema.Struct({
  ok: Schema.Literal(true),
  revision: Revision,
  configuration: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  updated_at_ms: Schema.NullOr(Schema.Number),
});

const SaveResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), revision: Revision }),
  Schema.Struct({
    ok: Schema.Literal(false),
    conflict: Schema.Literal(true),
    revision: Revision,
  }),
]);

/**
 * Reads and writes the instance-wide Luma configuration held by the CTOX
 * daemon. Callers own the target and the revision they read; a write whose
 * `expectedRevision` is stale comes back as `conflict` and changes nothing.
 */
export function makeCtoxLumaConfigurationClient(httpClient: HttpClient.HttpClient) {
  const transport = makeCtoxMcpTransport(httpClient);

  const structured = (
    target: CtoxMcpTarget,
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
  ) =>
    transport.callTool(target, name, arguments_).pipe(
      Effect.mapError(
        (error) =>
          new CtoxLumaConfigurationError({
            reason:
              error.reason === "connection-unavailable"
                ? "connection-unavailable"
                : "remote-response-invalid",
          }),
      ),
      Effect.flatMap((result) =>
        result.isError === true || result.structuredContent === undefined
          ? Effect.fail(new CtoxLumaConfigurationError({ reason: "remote-response-invalid" }))
          : Effect.succeed(result.structuredContent),
      ),
    );

  const read = Effect.fn("CtoxLumaConfigurationClient.read")(function* (target: CtoxMcpTarget) {
    const raw = yield* structured(target, CTOX_LUMA_READ_TOOL, {});
    const result = yield* Schema.decodeUnknownEffect(ReadResult)(raw).pipe(
      Effect.mapError(() => new CtoxLumaConfigurationError({ reason: "remote-response-invalid" })),
    );
    const document: CtoxLumaConfigurationDocument = {
      revision: result.revision,
      configuration: result.configuration,
      updatedAtMs: result.updated_at_ms,
    };
    return document;
  });

  const save = Effect.fn("CtoxLumaConfigurationClient.save")(function* (
    target: CtoxMcpTarget,
    expectedRevision: number,
    configuration: Readonly<Record<string, unknown>>,
  ) {
    if (new TextEncoder().encode(JSON.stringify(configuration)).byteLength > 1_024 * 1_024) {
      return yield* new CtoxLumaConfigurationError({ reason: "remote-response-invalid" });
    }
    const raw = yield* structured(target, CTOX_LUMA_UPDATE_TOOL, {
      expected_revision: expectedRevision,
      configuration,
    });
    const result = yield* Schema.decodeUnknownEffect(SaveResult)(raw).pipe(
      Effect.mapError(() => new CtoxLumaConfigurationError({ reason: "remote-response-invalid" })),
    );
    const outcome: CtoxLumaConfigurationSaveResult =
      result.ok === true
        ? { status: "saved", revision: result.revision }
        : { status: "conflict", revision: result.revision };
    return outcome;
  });

  return { read, save };
}
