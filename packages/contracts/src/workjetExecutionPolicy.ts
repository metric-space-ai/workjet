import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId } from "./baseSchemas.ts";

/**
 * Revision-bound Owner project policy reference, never an execution permit.
 * Absence keeps the existing provider permission behavior. No host, path,
 * credentials or permission bypass can be granted through this payload.
 */
export const WorkjetExecutionPolicy = Schema.Struct({
  mode: Schema.Literal("autonomous-worktree"),
  projectId: ProjectId,
  revision: NonNegativeInt,
});
export type WorkjetExecutionPolicy = typeof WorkjetExecutionPolicy.Type;
