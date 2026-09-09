import {
  NonNegativeInt,
  WorkjetDecisionHubConnectionError,
  type WorkjetDecisionHubEscalationResult,
} from "@workjet/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import { makeCtoxMcpTransport, type CtoxMcpTarget } from "../ctox/CtoxMcpTransport.ts";

export {
  CTOX_MCP_SERVER_NAME,
  isCtoxMcpResponseWithinLimit as isDecisionHubResponseWithinLimit,
} from "../ctox/CtoxMcpTransport.ts";

export const DECISION_HUB_REQUEST_TOOL = "decision_hub.request_decision";
export const DECISION_HUB_GET_TOOL = "decision_hub.get_decision";
export const DECISION_HUB_REMOTE_TOOLS = Object.freeze([
  DECISION_HUB_REQUEST_TOOL,
  DECISION_HUB_GET_TOOL,
]);

const RequestResult = Schema.Struct({ decision_id: Schema.String, status: Schema.String });
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

export const mapRemoteStatus = (status: string): "open" | "resolved" | "expired" | undefined => {
  if (status === "open" || status === "offen") return "open";
  if (status === "resolved" || status === "entschieden") return "resolved";
  if (status === "expired" || status === "abgelaufen") return "expired";
  return undefined;
};

export type DecisionHubMcpTarget = CtoxMcpTarget;

export interface DecisionHubMcpClientShape {
  readonly probe: (
    target: DecisionHubMcpTarget,
    requiredTools?: ReadonlyArray<string>,
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
>()("workjet/workjet/decisionHub/DecisionHubMcpClient") {}

const make = Effect.gen(function* () {
  const transport = makeCtoxMcpTransport(yield* HttpClient.HttpClient);
  const probe: DecisionHubMcpClientShape["probe"] = (
    target,
    requiredTools = DECISION_HUB_REMOTE_TOOLS,
  ) =>
    transport.probe(target, requiredTools).pipe(Effect.mapError((error) => failure(error.reason)));

  const callTool = (
    target: DecisionHubMcpTarget,
    name: (typeof DECISION_HUB_REMOTE_TOOLS)[number],
    arguments_: Readonly<Record<string, unknown>>,
  ) =>
    transport.callTool(target, name, arguments_).pipe(
      Effect.mapError((error) => failure(error.reason)),
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
