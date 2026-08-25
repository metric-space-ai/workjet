import {
  NonNegativeInt,
  WorkjetDecisionHubConnectionError,
  type WorkjetDecisionHubEscalationResult,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

export const DECISION_HUB_REQUEST_TOOL = "decision_hub.request_decision";
export const DECISION_HUB_GET_TOOL = "decision_hub.get_decision";
export const DECISION_HUB_REMOTE_TOOLS = Object.freeze([
  DECISION_HUB_REQUEST_TOOL,
  DECISION_HUB_GET_TOOL,
]);
export const CTOX_MCP_SERVER_NAME = "ctox-business-os-mcp";

const REQUEST_TIMEOUT = Duration.seconds(10);
const MAX_RESPONSE_BYTES = 256 * 1_024;

const JsonRpcEnvelope = Schema.Struct({
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ code: Schema.optional(Schema.Number) })),
});
const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonRpcEnvelope));
const ServerInfo = Schema.Struct({ serverInfo: Schema.Struct({ name: Schema.String }) });
const ToolList = Schema.Struct({
  tools: Schema.Array(Schema.Struct({ name: Schema.String })),
});
const ToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
});
const RequestResult = Schema.Struct({
  decision_id: Schema.String,
  status: Schema.String,
});
const GetResult = Schema.Struct({
  decision_id: Schema.String,
  status: Schema.String,
  resolution: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        option_id: Schema.optional(Schema.String),
        comment: Schema.optional(Schema.String),
      }),
    ),
  ),
  updated_at_ms: Schema.optional(NonNegativeInt),
});

export interface DecisionHubRemoteResolution {
  readonly decisionId: string;
  readonly status: "open" | "resolved" | "expired";
  readonly selectedOptionId: string | null;
  readonly comment: string | null;
  readonly resolutionVersion: number;
}

type ConnectionErrorReason = WorkjetDecisionHubConnectionError["reason"];
const failure = (reason: ConnectionErrorReason) =>
  new WorkjetDecisionHubConnectionError({ reason });

export const isDecisionHubResponseWithinLimit = (body: string): boolean =>
  new TextEncoder().encode(body).byteLength <= MAX_RESPONSE_BYTES;

export const mapRemoteStatus = (status: string): "open" | "resolved" | "expired" | undefined => {
  if (status === "open" || status === "offen") return "open";
  if (status === "resolved" || status === "entschieden") return "resolved";
  if (status === "expired" || status === "abgelaufen") return "expired";
  return undefined;
};

export interface DecisionHubMcpTarget {
  readonly endpoint: string;
  readonly token: string;
}

export interface DecisionHubMcpClientShape {
  readonly probe: (
    target: DecisionHubMcpTarget,
  ) => Effect.Effect<void, WorkjetDecisionHubConnectionError>;
  readonly requestDecision: (
    target: DecisionHubMcpTarget,
    arguments_: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<WorkjetDecisionHubEscalationResult, WorkjetDecisionHubConnectionError>;
  readonly getDecision: (
    target: DecisionHubMcpTarget,
    decisionId: string,
  ) => Effect.Effect<DecisionHubRemoteResolution, WorkjetDecisionHubConnectionError>;
}

export class DecisionHubMcpClient extends Context.Service<
  DecisionHubMcpClient,
  DecisionHubMcpClientShape
>()("t3/workjet/decisionHub/DecisionHubMcpClient") {}

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  let requestId = 0;

  const call = (
    target: DecisionHubMcpTarget,
    method: "initialize" | "tools/list" | "tools/call",
    params?: unknown,
  ): Effect.Effect<unknown, WorkjetDecisionHubConnectionError> =>
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
      if (!isDecisionHubResponseWithinLimit(body)) {
        return yield* failure("remote-response-invalid");
      }
      const envelope = yield* decodeEnvelope(body).pipe(Effect.option);
      if (Option.isNone(envelope) || envelope.value.error !== undefined) {
        return yield* failure("remote-response-invalid");
      }
      if (envelope.value.result === undefined) {
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

  const probe: DecisionHubMcpClientShape["probe"] = (target) =>
    Effect.gen(function* () {
      const initialized = yield* call(target, "initialize");
      const info = yield* Schema.decodeUnknownEffect(ServerInfo)(initialized).pipe(Effect.option);
      if (Option.isNone(info) || info.value.serverInfo.name !== CTOX_MCP_SERVER_NAME) {
        return yield* failure("remote-identity-mismatch");
      }
      const listed = yield* call(target, "tools/list", {});
      const tools = yield* Schema.decodeUnknownEffect(ToolList)(listed).pipe(Effect.option);
      const names = new Set(Option.isSome(tools) ? tools.value.tools.map(({ name }) => name) : []);
      if (DECISION_HUB_REMOTE_TOOLS.some((tool) => !names.has(tool))) {
        return yield* failure("remote-tools-missing");
      }
    });

  const callTool = (
    target: DecisionHubMcpTarget,
    name: (typeof DECISION_HUB_REMOTE_TOOLS)[number],
    arguments_: Readonly<Record<string, unknown>>,
  ) =>
    call(target, "tools/call", { name, arguments: arguments_ }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ToolResult)),
      Effect.mapError(() => failure("remote-response-invalid")),
      Effect.flatMap((result) =>
        result.isError === true || result.structuredContent === undefined
          ? Effect.fail(failure("remote-response-invalid"))
          : Effect.succeed(result.structuredContent),
      ),
    );

  const requestDecision: DecisionHubMcpClientShape["requestDecision"] = (target, arguments_) =>
    callTool(target, DECISION_HUB_REQUEST_TOOL, arguments_).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RequestResult)),
      Effect.mapError(() => failure("remote-response-invalid")),
      Effect.flatMap((result) => {
        const status = mapRemoteStatus(result.status);
        return status === undefined
          ? Effect.fail(failure("remote-response-invalid"))
          : Effect.succeed({ decisionId: result.decision_id, status });
      }),
    );

  const getDecision: DecisionHubMcpClientShape["getDecision"] = (target, decisionId) =>
    callTool(target, DECISION_HUB_GET_TOOL, { decision_id: decisionId }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(GetResult)),
      Effect.mapError(() => failure("remote-response-invalid")),
      Effect.flatMap((result) => {
        const status = mapRemoteStatus(result.status);
        return status === undefined
          ? Effect.fail(failure("remote-response-invalid"))
          : Effect.succeed({
              decisionId: result.decision_id,
              status,
              selectedOptionId: result.resolution?.option_id ?? null,
              comment: result.resolution?.comment ?? null,
              resolutionVersion: result.updated_at_ms ?? 0,
            });
      }),
    );

  return DecisionHubMcpClient.of({ probe, requestDecision, getDecision });
});

export const layer = Layer.effect(DecisionHubMcpClient, make);
