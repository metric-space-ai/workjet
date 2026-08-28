import {
  type WorkjetConnectionId,
  WorkjetDecisionHubConnectionError,
  type WorkjetDecisionHubEscalationInput,
  type WorkjetDecisionHubEscalationResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import { DecisionHubConnectionRegistry } from "./DecisionHubConnectionRegistry.ts";
import { DecisionHubMcpClient } from "./DecisionHubMcpClient.ts";

export interface DecisionHubEscalationServiceShape {
  readonly escalate: (
    invocation: McpInvocationScope,
    connectionId: WorkjetConnectionId,
    input: WorkjetDecisionHubEscalationInput,
  ) => Effect.Effect<WorkjetDecisionHubEscalationResult, WorkjetDecisionHubConnectionError>;
}

export class DecisionHubEscalationService extends Context.Service<
  DecisionHubEscalationService,
  DecisionHubEscalationServiceShape
>()("t3/workjet/decisionHub/DecisionHubEscalationService") {}

const failure = () => new WorkjetDecisionHubConnectionError({ reason: "connection-unavailable" });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const registry = yield* DecisionHubConnectionRegistry;
  const client = yield* DecisionHubMcpClient;

  const escalate: DecisionHubEscalationServiceShape["escalate"] = (
    invocation,
    connectionId,
    input,
  ) =>
    Effect.gen(function* () {
      if (invocation.workjetRole !== "standard" && invocation.workjetRole !== "orchestrator") {
        return yield* new WorkjetDecisionHubConnectionError({ reason: "foreign-environment" });
      }
      const target = yield* registry.resolveReadyTarget(connectionId);
      const expiresAtMillis =
        input.expiresAt === undefined ? undefined : DateTime.toEpochMillis(input.expiresAt);
      const result = yield* client.requestDecision(target, {
        decision_key: input.decisionKey,
        title: input.title,
        question: input.question,
        context: input.context,
        options: input.options,
        ...(input.recommendationOptionId === undefined
          ? {}
          : { recommendation: input.recommendationOptionId }),
        urgency: input.urgency,
        ...(expiresAtMillis === undefined ? {} : { expires_at_ms: expiresAtMillis }),
        source: {
          authority: "workjet",
          environment_id: invocation.environmentId,
          thread_id: invocation.threadId,
          workjet_instance_id: invocation.environmentId,
        },
        correlation: {
          turn_id: invocation.providerSessionId,
          idempotency_key: input.decisionKey,
        },
      });
      const now = yield* Clock.currentTimeMillis;
      yield* sql`
        INSERT INTO workjet_decision_hub_escalations (
          decision_id, connection_id, environment_id, thread_id, decision_key,
          status, selected_option_id, comment, resolution_version,
          next_poll_at_ms, attempt, created_at_ms, updated_at_ms
        ) VALUES (
          ${result.decisionId}, ${connectionId}, ${invocation.environmentId},
          ${invocation.threadId}, ${input.decisionKey}, ${result.status}, NULL, NULL,
          0, ${now}, 0, ${now}, ${now}
        )
        ON CONFLICT(environment_id, thread_id, decision_key) DO UPDATE SET
          decision_id = excluded.decision_id,
          connection_id = excluded.connection_id,
          status = excluded.status,
          updated_at_ms = excluded.updated_at_ms
      `.pipe(Effect.mapError(failure));
      return result;
    });

  return DecisionHubEscalationService.of({ escalate });
});

export const layer = Layer.effect(DecisionHubEscalationService, make);
