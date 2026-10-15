import {
  CommandId,
  WorkjetSupervisorRouteResponse,
  isWorkjetSupervisorRouteReceiptForRequest,
  type SupervisorRouteDisplay,
  type SupervisorRouteDisplayV2,
  type ActualSupervisorComputationV2,
} from "@workjet/contracts";
import * as Schema from "effect/Schema";
import type { NativeSupervisorScope } from "./nativeSupervisorComposer";
import {
  requestWorkjetProjectControl,
  type WorkjetProjectControlPort,
} from "./workjetProjectControl";
import { randomUUID } from "./lib/utils";

export type SupervisorRouteState =
  | { readonly phase: "ready"; readonly route: SupervisorRouteDisplay | SupervisorRouteDisplayV2 }
  | { readonly phase: "unavailable"; readonly code: string };
const decode = Schema.decodeUnknownSync(WorkjetSupervisorRouteResponse, {
  onExcessProperty: "error",
});
/** Read-only, additive capability negotiation; never infers execution from a Code thread. */
export async function readSupervisorRoute(
  scope: NativeSupervisorScope,
  signal: AbortSignal,
  port?: WorkjetProjectControlPort,
): Promise<SupervisorRouteState> {
  for (const actions of [
    ["project.supervisor.route.capabilities.v2", "project.supervisor.route.read.v2"],
    ["project.supervisor.route.capabilities.v1", "project.supervisor.route.read.v1"],
  ] as const) {
    for (const action of actions) {
      if (signal.aborted) return { phase: "unavailable", code: "canceled" };
      const request = {
        action,
        commandId: CommandId.make(`supervisor-route-${randomUUID()}`),
        projectId: scope.projectId,
        threadId: scope.threadId,
      };
      const result = await requestWorkjetProjectControl(scope.instanceId, request, port);
      if (signal.aborted) return { phase: "unavailable", code: "canceled" };
      if (result._tag !== "completed") {
        if (action === "project.supervisor.route.capabilities.v2" && result.code === "unsupported")
          break;
        return { phase: "unavailable", code: result.code };
      }
      let reply: WorkjetSupervisorRouteResponse;
      try {
        reply = decode(result.response);
      } catch {
        return { phase: "unavailable", code: "guest_failed" };
      }
      if (!isWorkjetSupervisorRouteReceiptForRequest(request, reply))
        return { phase: "unavailable", code: "guest_failed" };
      if (
        reply.action === "project.supervisor.route.read.v1" ||
        reply.action === "project.supervisor.route.read.v2"
      )
        return { phase: "ready", route: reply.route };
    }
  }
  return { phase: "unavailable", code: "unsupported" };
}
export function supervisorActualComputation(
  state: SupervisorRouteState | null,
): ActualSupervisorComputationV2 | null {
  return state?.phase === "ready" &&
    state.route.schema === "ctox.workjet.supervisor.route-display.v2"
    ? (state.route.actual ?? null)
    : null;
}
export function supervisorRouteLabel(state: SupervisorRouteState | null): {
  readonly model: string;
  readonly computer: string;
  readonly title: string;
} {
  const configured = state?.phase === "ready" ? state.route.configured : null;
  return configured
    ? {
        model: `Configured · ${configured.harness} · ${configured.model}`,
        computer: configured.computer_id,
        title: supervisorActualComputation(state)
          ? "Configured instance Luma for the next turn. The last verified execution is shown separately."
          : "Configured instance Luma. No verified execution receipt is available.",
      }
    : {
        model: "Instance model",
        computer: "Project instance",
        title:
          state?.phase === "unavailable"
            ? `Route details unavailable (${state.code}). Execution remains managed by the project instance.`
            : "Execution and model are managed by the project's instance.",
      };
}
