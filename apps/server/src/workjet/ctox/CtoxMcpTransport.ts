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
      url.pathname = url.pathname.replace(/\/+$/, "");
      // Managed routing is /mcp/<instance-id>. Appending /mcp would select a
      // different resource instead of the instance the user configured.
      if (!/\/mcp(?:\/[^/]+)?$/.test(url.pathname)) {
        url.pathname = `${url.pathname}/mcp`;
      }
      return url.toString();
    },
    catch: () => failure("invalid-endpoint"),
  });

export const isCtoxMcpResponseWithinLimit = (body: string): boolean =>
  new TextEncoder().encode(body).byteLength <= MAX_RESPONSE_BYTES;

const JsonRpcEnvelope = Schema.Struct({
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ code: Schema.optional(Schema.Number) })),
});
const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonRpcEnvelope));
const ServerInfo = Schema.Struct({ serverInfo: Schema.Struct({ name: Schema.String }) });
const ToolList = Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) });
export const CtoxMcpToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
});

/** Server-side transport only. Callers own tool schemas, authorization and run binding. */
export function makeCtoxMcpTransport(httpClient: HttpClient.HttpClient) {
  let requestId = 0;

  const call = (
    target: CtoxMcpTarget,
    method: "initialize" | "tools/list" | "tools/call",
    params?: unknown,
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
      if (response.status < 200 || response.status >= 300) {
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
        return yield* failure("remote-response-invalid");
      }
      return envelope.value.result;
    }).pipe(
      Effect.scoped,
      Effect.timeout(REQUEST_TIMEOUT),
      Effect.catchTags({
        TimeoutError: () => Effect.fail(failure("connection-unavailable")),
        HttpClientError: () => Effect.fail(failure("connection-unavailable")),
      }),
    );

  const probe = Effect.fn("CtoxMcpTransport.probe")(function* (
    target: CtoxMcpTarget,
    requiredTools: ReadonlyArray<string>,
  ) {
    const initialized = yield* call(target, "initialize");
    const info = yield* Schema.decodeUnknownEffect(ServerInfo)(initialized).pipe(Effect.option);
    if (Option.isNone(info) || info.value.serverInfo.name !== CTOX_MCP_SERVER_NAME) {
      return yield* failure("remote-identity-mismatch");
    }
    const listed = yield* call(target, "tools/list", {});
    const tools = yield* Schema.decodeUnknownEffect(ToolList)(listed).pipe(Effect.option);
    if (Option.isNone(tools)) return yield* failure("remote-response-invalid");
    const names = new Set(tools.value.tools.map(({ name }) => name));
    if (requiredTools.some((tool) => !names.has(tool))) {
      return yield* failure("remote-tools-missing");
    }
  });

  const callTool = (
    target: CtoxMcpTarget,
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
  ) =>
    call(target, "tools/call", { name, arguments: arguments_ }).pipe(
      Effect.flatMap((result) =>
        Schema.decodeUnknownEffect(CtoxMcpToolResult)(result).pipe(
          Effect.mapError(() => failure("remote-response-invalid")),
        ),
      ),
    );

  return { probe, callTool };
}
