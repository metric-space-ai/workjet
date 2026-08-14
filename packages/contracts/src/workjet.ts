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

/** Portable public contract for the server-wide managed Greppy runtime. */
export const GreppyRuntimeAvailability = Schema.Literals([
  "available",
  "unavailable",
  "unsupported",
]);
export type GreppyRuntimeAvailability = typeof GreppyRuntimeAvailability.Type;

export const GreppyRuntimeSource = Schema.Literals(["override", "managed", "path"]);
export type GreppyRuntimeSource = typeof GreppyRuntimeSource.Type;

export const GreppyRuntimeReason = Schema.Literals([
  "unsupported-host",
  "override-invalid",
  "managed-invalid",
  "path-unavailable",
  "binary-unavailable",
  "version-mismatch",
  "surface-mismatch",
  "timeout",
  "process-exit",
  "malformed-response",
  "oversized-response",
  "index-unavailable",
  "install-failed",
]);
export type GreppyRuntimeReason = typeof GreppyRuntimeReason.Type;

const GreppyRuntimeSnapshotBaseFields = {
  version: Schema.Literal("0.3.1"),
} as const;

export const GreppyRuntimeSnapshot = Schema.Union([
  Schema.Struct({
    ...GreppyRuntimeSnapshotBaseFields,
    availability: Schema.Literal("available"),
    source: GreppyRuntimeSource,
    installSupported: Schema.Boolean,
  }),
  Schema.Struct({
    ...GreppyRuntimeSnapshotBaseFields,
    availability: Schema.Literal("unavailable"),
    reason: GreppyRuntimeReason,
    installSupported: Schema.Boolean,
  }),
  Schema.Struct({
    ...GreppyRuntimeSnapshotBaseFields,
    availability: Schema.Literal("unsupported"),
    reason: Schema.Literal("unsupported-host"),
    installSupported: Schema.Literal(false),
  }),
]);
export type GreppyRuntimeSnapshot = typeof GreppyRuntimeSnapshot.Type;

/**
 * Sanitized RPC failure. The wire representation is intentionally limited to
 * a bounded reason and never carries process output, paths, URLs, or arbitrary
 * server messages.
 */
export class WorkjetGreppyOperationError extends Schema.TaggedErrorClass<WorkjetGreppyOperationError>()(
  "WorkjetGreppyOperationError",
  { reason: GreppyRuntimeReason },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported-host":
        return "Managed Greppy is unsupported on this host.";
      case "override-invalid":
        return "The configured Greppy executable override is unusable.";
      case "managed-invalid":
        return "The managed Greppy runtime needs repair.";
      case "path-unavailable":
      case "binary-unavailable":
        return "Greppy is unavailable on this server.";
      case "version-mismatch":
      case "surface-mismatch":
        return "The Greppy runtime is incompatible.";
      case "timeout":
        return "The Greppy runtime operation timed out.";
      case "process-exit":
      case "install-failed":
        return "The Greppy runtime operation failed.";
      case "malformed-response":
      case "oversized-response":
        return "Greppy returned an invalid response.";
      case "index-unavailable":
        return "Greppy indexing is unavailable.";
    }
  }
}

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
