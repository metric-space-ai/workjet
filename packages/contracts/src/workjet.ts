import * as Schema from "effect/Schema";
import { EnvironmentId, ThreadId } from "./baseSchemas.ts";

export const WorkjetThreadRole = Schema.Literals(["standard", "orchestrator", "worker"]);
export type WorkjetThreadRole = typeof WorkjetThreadRole.Type;

export const WorkjetCapabilityId = Schema.Literals(["greppy", "web-search", "web-stack-browser"]);
export type WorkjetCapabilityId = typeof WorkjetCapabilityId.Type;

export const WorkjetParentThreadReference = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type WorkjetParentThreadReference = typeof WorkjetParentThreadReference.Type;

const WorkjetThreadConfigV1BaseFields = {
  schemaVersion: Schema.Literal(1),
  managedInstructions: Schema.String,
  enabledCapabilityIds: Schema.Array(WorkjetCapabilityId),
} as const;

export const WorkjetThreadConfig = Schema.Union([
  Schema.Struct({
    ...WorkjetThreadConfigV1BaseFields,
    role: Schema.Literals(["standard", "orchestrator"]),
    parent: Schema.Null,
  }),
  Schema.Struct({
    ...WorkjetThreadConfigV1BaseFields,
    role: Schema.Literal("worker"),
    parent: WorkjetParentThreadReference,
  }),
]);
export type WorkjetThreadConfig = typeof WorkjetThreadConfig.Type;

export const DEFAULT_WORKJET_THREAD_CONFIG = {
  schemaVersion: 1,
  role: "standard",
  parent: null,
  managedInstructions: "",
  enabledCapabilityIds: [],
} as const satisfies WorkjetThreadConfig;
