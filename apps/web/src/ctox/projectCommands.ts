import type { CtoxWorkjetProjectControlRequest } from "@workjet/contracts";
import { useCtoxCommand } from "./hooks";

export const PROJECT_MUTATION_ACTIONS = [
  "project.create",
  "project.configure",
  "project.init",
  "project.chat.create",
  "project.worker.add",
  "project.supervisor.bind",
  "project.supervisor.turn.submit",
  "project.supervisor.turn.input",
  "project.supervisor.turn.cancel",
  "project.kpis.configure",
  "project.kpis.refresh",
] as const;
type ProjectMutationAction = (typeof PROJECT_MUTATION_ACTIONS)[number];
// project.gallery.order.set is not a command in V4: gallery order is a Workjet field written by
// api.patch (E49.4) and has no route in the Workjet bridge contract (wjb-command-types.json).
export type CtoxProjectMutation = Extract<
  CtoxWorkjetProjectControlRequest,
  { action: ProjectMutationAction }
>;

/** Typed client intent for Workjet App handlers (registry proposal in collections-b).
 * Core owns actor, routing and execution receipts; this does not claim producer activation.
 */
export function useCtoxProjectCommands(instanceId: string | null) {
  const controls = useCtoxCommand(instanceId);
  return {
    ...controls,
    submit: (request: CtoxProjectMutation) => {
      const type = projectCommandType(request.action);
      return controls.command(
        type,
        request,
        "projectId" in request ? { record_id: request.projectId } : undefined,
      );
    },
  };
}

/** Core platform route (E40) for a project mutation; checked against wjb-command-types.json. */
export function projectCommandType(action: ProjectMutationAction): string {
  return action === "project.create" || action === "project.configure"
    ? "ctox.workjet.project.upsert"
    : `ctox.workjet.${action}`;
}
