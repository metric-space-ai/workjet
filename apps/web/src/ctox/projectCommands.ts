import type { CtoxWorkjetProjectControlRequest } from "@workjet/contracts";
import { useCtoxCommand } from "./hooks";

type ProjectMutationAction =
  | "project.create"
  | "project.configure"
  | "project.init"
  | "project.chat.create"
  | "project.worker.add"
  | "project.supervisor.bind"
  | "project.supervisor.turn.submit"
  | "project.supervisor.turn.input"
  | "project.supervisor.turn.cancel"
  | "project.kpis.configure"
  | "project.kpis.refresh"
  | "project.gallery.order.set";
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
      const type =
        request.action === "project.create" || request.action === "project.configure"
          ? "ctox.workjet.project.upsert"
          : `ctox.workjet.${request.action}`;
      return controls.command(
        type,
        request,
        "projectId" in request ? { record_id: request.projectId } : undefined,
      );
    },
  };
}
