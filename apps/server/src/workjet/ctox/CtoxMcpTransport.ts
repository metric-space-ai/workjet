import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

export const CTOX_MCP_SERVER_NAME = "ctox-business-os-mcp";
const MAX_RESPONSE_BYTES = 256 * 1_024;
const REQUEST_TIMEOUT = Duration.seconds(10);

export class CtoxMcpTransportError extends Schema.TaggedErrorClass<CtoxMcpTransportError>()(
  "CtoxMcpTransportError",
  {
    reason: Schema.Literals([
      "invalid-endpoint",
      "connection-unavailable",
      "authentication-required",
      "remote-identity-mismatch",
      "remote-tools-missing",
      "remote-response-invalid",
    ]),
  },
) {}

export interface CtoxMcpTarget {
  readonly endpoint: string;
  readonly token: string;
}

const failure = (reason: CtoxMcpTransportError["reason"]) => new CtoxMcpTransportError({ reason });

/** Accept a host/base URL or an already configured local, managed or self-hosted endpoint. */
export const normalizeCtoxMcpEndpoint = (value: string) =>
  Effect.try({
    try: () => {
      const url = new URL(value);
      if (url.username !== "" || url.password !== "" || url.hash !== "") throw new Error();
      const loopback =
        url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
      if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error();
      url.search = "";
      const pathname = url.pathname.replace(/\/+$/, "");
      // Managed routing is /mcp/<instance-id>. Appending /mcp would select a
      // different resource instead of the instance the user configured.
      url.pathname = /\/mcp(?:\/[^/]+)?$/.test(pathname) ? pathname : `${pathname}/mcp`;
      return url.toString();
    },
    catch: () => failure("invalid-endpoint"),
  });

export const isCtoxMcpResponseWithinLimit = (body: string): boolean =>
  new TextEncoder().encode(body).byteLength <= MAX_RESPONSE_BYTES;

const JsonRpcEnvelope = Schema.Struct({
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.Number),
      message: Schema.optional(Schema.String),
      data: Schema.optional(Schema.Struct({ code: Schema.optional(Schema.String) })),
    }),
  ),
});
const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonRpcEnvelope));
const nativeErrorCodes = new Set([
  "not_authenticated",
  "not_authorized",
  "module_not_found",
  "entity_not_found",
  "record_not_found",
  "action_not_allowed",
  "confirmation_required",
  "sync_not_ready",
  "runtime_unavailable",
  "validation_failed",
  "external_effect_blocked",
  "channel_disabled",
  "permission_denied",
  "response_too_large",
  "rate_limited",
  "internal_error",
  "method_not_found",
]);
const nativeWorkerErrors = new Map<string, string>([
  ["source supervisor is not registered natively", "native-supervisor-unregistered"],
  ["native supervisor history missing", "native-supervisor-history-missing"],
  ["source supervisor belongs to another project", "native-project-mismatch"],
  ["native supervisor provenance changed", "native-supervisor-provenance-changed"],
  ["native worker dispatch policy denied", "native-policy-denied"],
  ["source replacement needs exact revision", "source-revision-conflict"],
]);
const safeRemoteFailureReason = (error: NonNullable<typeof JsonRpcEnvelope.Type.error>) => {
  const known = error.message === undefined ? undefined : nativeWorkerErrors.get(error.message);
  if (known !== undefined) return known;
  const code = error.data?.code;
  return code !== undefined && nativeErrorCodes.has(code) ? code : "remote-error";
};
const ServerInfo = Schema.Struct({ serverInfo: Schema.Struct({ name: Schema.String }) });
const ToolList = Schema.Struct({
  tools: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      inputSchema: Schema.optional(Schema.Unknown),
    }),
  ),
});
const ToolInputSchema = Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) });
const StringArgumentSchema = Schema.Struct({ type: Schema.Literal("string") });
const decodeServerInfo = Schema.decodeUnknownEffect(ServerInfo);
const decodeToolList = Schema.decodeUnknownEffect(ToolList);
const isToolInputSchema = Schema.is(ToolInputSchema);
const isStringArgumentSchema = Schema.is(StringArgumentSchema);
export const CtoxMcpToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
});

const decodeToolResult = Schema.decodeUnknownEffect(CtoxMcpToolResult);

/** Server-side transport only. Callers own tool schemas, authorization and run binding. */
export function makeCtoxMcpTransport(httpClient: HttpClient.HttpClient) {
  let requestId = 0;

  const call = (
    target: CtoxMcpTarget,
    method: "initialize" | "tools/list" | "tools/call",
    params?: unknown,
    timeout = REQUEST_TIMEOUT,
  ): Effect.Effect<unknown, CtoxMcpTransportError> =>
    Effect.gen(function* () {
      const request = HttpClientRequest.post(target.endpoint).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          jsonrpc: "2.0",
          id: ++requestId,
          method,
          ...(params === undefined ? {} : { params }),
        }),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(target.token),
      );
      const response = yield* httpClient.execute(request);
      yield* Effect.annotateCurrentSpan({ httpStatus: response.status });
      if (response.status === 401) return yield* failure("authentication-required");
      if (response.status < 200 || response.status >= 300) {
        yield* Effect.annotateCurrentSpan({
          failureReason:
            response.status === 429
              ? "rate-limited"
              : response.status === 403
                ? "permission-denied"
                : "http-unavailable",
        });
        return yield* failure("connection-unavailable");
      }
      const body = yield* response.text;
      if (!isCtoxMcpResponseWithinLimit(body)) return yield* failure("remote-response-invalid");
      const envelope = yield* decodeEnvelope(body).pipe(Effect.option);
      if (
        Option.isNone(envelope) ||
        envelope.value.error !== undefined ||
        envelope.value.result === undefined
      ) {
        if (Option.isSome(envelope) && envelope.value.error !== undefined) {
          yield* Effect.annotateCurrentSpan({
            ...(envelope.value.error.code === undefined
              ? {}
              : { jsonRpcCode: envelope.value.error.code }),
            failureReason: safeRemoteFailureReason(envelope.value.error),
          });
        }
        return yield* failure("remote-response-invalid");
      }
      return envelope.value.result;
    }).pipe(
      Effect.scoped,
      Effect.timeout(timeout),
      Effect.catchTags({
        TimeoutError: () =>
          Effect.annotateCurrentSpan({ failureReason: "request-timeout" }).pipe(
            Effect.andThen(Effect.fail(failure("connection-unavailable"))),
          ),
        HttpClientError: () =>
          Effect.annotateCurrentSpan({ failureReason: "transport-error" }).pipe(
            Effect.andThen(Effect.fail(failure("connection-unavailable"))),
          ),
      }),
      Effect.tapError((error) => Effect.annotateCurrentSpan({ reason: error.reason })),
      Effect.withSpan("CtoxMcpTransport.call", { attributes: { method } }),
    );

  const probe = Effect.fn("CtoxMcpTransport.probe")(
    function* (
      target: CtoxMcpTarget,
      requiredTools: ReadonlyArray<string>,
      requiredStringArguments: Readonly<Record<string, ReadonlyArray<string>>> = {},
    ) {
      yield* Effect.annotateCurrentSpan({ requiredTools: [...requiredTools] });
      const initialized = yield* call(target, "initialize");
      const info = yield* decodeServerInfo(initialized).pipe(Effect.option);
      if (Option.isNone(info) || info.value.serverInfo.name !== CTOX_MCP_SERVER_NAME) {
        return yield* failure("remote-identity-mismatch");
      }
      const listed = yield* call(target, "tools/list", {});
      const tools = yield* decodeToolList(listed).pipe(Effect.option);
      if (Option.isNone(tools)) return yield* failure("remote-response-invalid");
      const names = new Set(tools.value.tools.map(({ name }) => name));
      if (requiredTools.some((tool) => !names.has(tool))) {
        yield* Effect.annotateCurrentSpan({
          missingTools: requiredTools.filter((tool) => !names.has(tool)),
        });
        return yield* failure("remote-tools-missing");
      }
      // Legacy daemons can ignore unknown fields. A retry key is only meaningful
      // when the selected operation advertises the corresponding contract.
      for (const [name, argumentNames] of Object.entries(requiredStringArguments)) {
        const inputSchema = tools.value.tools.find((tool) => tool.name === name)?.inputSchema;
        if (!isToolInputSchema(inputSchema)) return yield* failure("remote-tools-missing");
        if (
          argumentNames.some(
            (argument) => !isStringArgumentSchema(inputSchema.properties[argument]),
          )
        ) {
          return yield* failure("remote-tools-missing");
        }
      }
    },
    Effect.tapError((error) => Effect.annotateCurrentSpan({ reason: error.reason })),
  );

  const callTool = (
    target: CtoxMcpTarget,
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    timeout = REQUEST_TIMEOUT,
  ) =>
    call(target, "tools/call", { name, arguments: arguments_ }, timeout).pipe(
      Effect.flatMap((result) =>
        decodeToolResult(result).pipe(Effect.mapError(() => failure("remote-response-invalid"))),
      ),
    );

  return { probe, callTool };
}
