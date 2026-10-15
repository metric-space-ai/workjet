// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import * as Schema from "effect/Schema";
import { CommandId, ProjectId } from "./baseSchemas.ts";
import { WorkjetSupervisorThreadId } from "./workjetSupervisor.ts";
import {
  SupervisorRouteCapabilities,
  SupervisorRouteDisplay,
} from "./workjetSupervisorRoute.generated.ts";
export * from "./workjetSupervisorRoute.generated.ts";
import {
  SupervisorRouteCapabilitiesV2,
  SupervisorRouteDisplayV2,
} from "./workjetSupervisorRouteV2.ts";
export * from "./workjetSupervisorRouteV2.ts";
const scope = { commandId: CommandId, projectId: ProjectId, threadId: WorkjetSupervisorThreadId };
export const WorkjetSupervisorRouteRequests = [
  Schema.Struct({ ...scope, action: Schema.Literal("project.supervisor.route.capabilities.v2") }),
  Schema.Struct({ ...scope, action: Schema.Literal("project.supervisor.route.read.v2") }),
  Schema.Struct({ ...scope, action: Schema.Literal("project.supervisor.route.capabilities.v1") }),
  Schema.Struct({ ...scope, action: Schema.Literal("project.supervisor.route.read.v1") }),
] as const;
export const WorkjetSupervisorRouteResponses = [
  Schema.Struct({
    ...scope,
    action: Schema.Literal("project.supervisor.route.capabilities.v2"),
    contract: Schema.Literal("ctox.workjet.supervisor.route-capabilities.v2"),
    capabilities: SupervisorRouteCapabilitiesV2,
  }),
  Schema.Struct({
    ...scope,
    action: Schema.Literal("project.supervisor.route.read.v2"),
    contract: Schema.Literal("ctox.workjet.supervisor.route-display.v2"),
    route: SupervisorRouteDisplayV2,
  }),
  Schema.Struct({
    ...scope,
    action: Schema.Literal("project.supervisor.route.capabilities.v1"),
    contract: Schema.Literal("ctox.workjet.supervisor.route-capabilities.v1"),
    capabilities: SupervisorRouteCapabilities,
  }),
  Schema.Struct({
    ...scope,
    action: Schema.Literal("project.supervisor.route.read.v1"),
    contract: Schema.Literal("ctox.workjet.supervisor.route-display.v1"),
    route: SupervisorRouteDisplay,
  }).check(
    Schema.makeFilter(
      (reply) => reply.route.actual === null || "This route contract has no verified producer.",
    ),
  ),
] as const;
export const WorkjetSupervisorRouteResponse = Schema.Union(WorkjetSupervisorRouteResponses);
export type WorkjetSupervisorRouteResponse = typeof WorkjetSupervisorRouteResponse.Type;
export function isWorkjetSupervisorRouteReceiptForRequest(
  request: (typeof WorkjetSupervisorRouteRequests)[number]["Type"],
  reply: WorkjetSupervisorRouteResponse,
): boolean {
  const dto =
    reply.action === "project.supervisor.route.capabilities.v1" ||
    reply.action === "project.supervisor.route.capabilities.v2"
      ? reply.capabilities
      : reply.route;
  return (
    reply.action === request.action &&
    reply.commandId === request.commandId &&
    reply.projectId === request.projectId &&
    reply.threadId === request.threadId &&
    dto.project_id === request.projectId &&
    dto.supervisor_thread_id === request.threadId
  );
}
