import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { decodeCtoxCrewClaim } from "./CtoxCrewClaim.ts";
import type { CtoxMcpTarget, makeCtoxMcpTransport } from "./CtoxMcpTransport.ts";
import { CtoxNativeRequestError } from "./CtoxNativeRequests.ts";

export type CtoxCrewResultCandidate =
  | { readonly reply: string; readonly error?: never }
  | { readonly error: string; readonly reply?: never };

const Receipt = Schema.Struct({
  accepted: Schema.Literal(true),
  attempt_id: Schema.String,
  review_status: Schema.Literal("pending"),
});

/** Only a candidate is accepted here; native review still owns completion. */
export const reportCtoxCrewResult = Effect.fn("reportCtoxCrewResult")(function* (
  transport: ReturnType<typeof makeCtoxMcpTransport>,
  target: CtoxMcpTarget,
  claim: Effect.Success<ReturnType<typeof decodeCtoxCrewClaim>>,
  candidate: CtoxCrewResultCandidate,
) {
  const reply = candidate.reply;
  const error = candidate.error;
  // Match the native persisted JSON, including the null field and UTF-8 bytes.
  const encoded = yield* Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        reply: Schema.NullOr(Schema.String),
        error: Schema.NullOr(Schema.String),
      }),
    ),
  )({ reply: reply ?? null, error: error ?? null }).pipe(
    Effect.mapError(() => new CtoxNativeRequestError({ reason: "native-request-conflict" })),
  );
  if (
    (typeof reply === "string" && reply.trim().length > 0 && error === undefined) ===
      (typeof error === "string" && error.trim().length > 0 && reply === undefined) ||
    new TextEncoder().encode(encoded).byteLength > 256 * 1024
  )
    return yield* new CtoxNativeRequestError({ reason: "native-request-conflict" });
  const sessionTarget = { endpoint: target.endpoint, token: Redacted.value(claim.commandSession) };
  const name = "business_os.report_crew_execution";
  yield* transport.probe(sessionTarget, [name]);
  const response = yield* transport.callTool(
    sessionTarget,
    name,
    reply === undefined ? { error } : { reply },
  );
  if (response.isError || response.structuredContent === undefined)
    return yield* new CtoxNativeRequestError({ reason: "ctox-operation-rejected" });
  const receipt = yield* Schema.decodeUnknownEffect(Receipt)(response.structuredContent).pipe(
    Effect.mapError(() => new CtoxNativeRequestError({ reason: "native-response-invalid" })),
  );
  if (receipt.attempt_id !== claim.attemptId)
    return yield* new CtoxNativeRequestError({ reason: "native-response-invalid" });
  return receipt;
});
