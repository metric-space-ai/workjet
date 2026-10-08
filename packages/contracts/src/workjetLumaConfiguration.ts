import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { WorkjetConfigurationValue, WorkjetConnectionId, type WorkjetConfiguration } from "./workjet.ts";

export const WorkjetLumaTarget = Schema.Struct({
  connectionId: WorkjetConnectionId,
  instanceId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type WorkjetLumaTarget = typeof WorkjetLumaTarget.Type;

export const WorkjetLumaInstanceConfiguration = Schema.Struct({
  workerProfiles: WorkjetConfigurationValue.fields.workerProfiles,
  llmRoutes: WorkjetConfigurationValue.fields.llmRoutes,
  modelPrompts: WorkjetConfigurationValue.fields.modelPrompts,
  managedSystemPrompt: WorkjetConfigurationValue.fields.managedSystemPrompt,
  managerThreadReference: WorkjetConfigurationValue.fields.managerThreadReference,
  workerGraph: WorkjetConfigurationValue.fields.workerGraph,
  execution: WorkjetConfigurationValue.fields.execution,
  telemetry: WorkjetConfigurationValue.fields.telemetry,
});
const Revision = NonNegativeInt.check(Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER));
export const WorkjetLumaSnapshot = Schema.Struct({
  revision: Revision,
  configuration: Schema.NullOr(WorkjetLumaInstanceConfiguration),
  updatedAtMs: Schema.NullOr(Schema.Number),
});
export type WorkjetLumaSnapshot = typeof WorkjetLumaSnapshot.Type;
export const WorkjetLumaUpdateInput = Schema.Struct({
  target: WorkjetLumaTarget,
  expectedRevision: Revision,
  configuration: WorkjetLumaInstanceConfiguration,
});
export const WorkjetLumaUpdateResult = Schema.Struct({
  status: Schema.Literals(["saved", "conflict"]),
  revision: Revision,
});
export class WorkjetLumaConfigurationError extends Schema.TaggedErrorClass<WorkjetLumaConfigurationError>()(
  "WorkjetLumaConfigurationError", {
    reason: Schema.Literals(["connection-unavailable", "remote-response-invalid"]),
  },
) {}

/**
 * Keys of the Workjet configuration that belong to the CTOX instance. They
 * mirror the allow-list of `business_os.luma_configuration_update` on the CTOX
 * side. `computers` and `selectedComputerId` are machine state and stay in the
 * environment's own settings; `schemaVersion` is local to the stored document.
 */
export const WORKJET_LUMA_INSTANCE_KEYS = [
  "workerProfiles",
  "llmRoutes",
  "modelPrompts",
  "managedSystemPrompt",
  "managerThreadReference",
  "workerGraph",
  "execution",
  "telemetry",
] as const satisfies ReadonlyArray<keyof WorkjetConfiguration>;

export type WorkjetLumaInstanceKey = (typeof WORKJET_LUMA_INSTANCE_KEYS)[number];

export type WorkjetLumaInstanceDocument = Readonly<
  Pick<WorkjetConfiguration, WorkjetLumaInstanceKey>
>;

/** The part of a local configuration the instance document owns. */
export function extractLumaInstanceDocument(
  configuration: WorkjetConfiguration,
): WorkjetLumaInstanceDocument {
  const document: Partial<Record<WorkjetLumaInstanceKey, unknown>> = {};
  for (const key of WORKJET_LUMA_INSTANCE_KEYS) {
    document[key] = configuration[key];
  }
  return document as WorkjetLumaInstanceDocument;
}

/**
 * Revision 0 means the instance holds no Luma document yet. The first
 * computer that opens the settings page then seeds it from its own local
 * configuration, so existing Lumas are not lost in the switch.
 */
export function lumaInstanceNeedsSeed(revision: number): boolean {
  return revision === 0;
}

/**
 * Applies the instance document over a local configuration. Machine state
 * (`computers`, `selectedComputerId`, `schemaVersion`) is always taken from
 * the local side, so one computer's selection never rewrites another's.
 */
export function applyLumaInstanceDocument(
  local: WorkjetConfiguration,
  instance: Readonly<Partial<Record<WorkjetLumaInstanceKey, unknown>>>,
): WorkjetConfiguration {
  const merged: Record<string, unknown> = { ...local };
  for (const key of WORKJET_LUMA_INSTANCE_KEYS) {
    if (instance[key] !== undefined) merged[key] = instance[key];
  }
  return merged as WorkjetConfiguration;
}
