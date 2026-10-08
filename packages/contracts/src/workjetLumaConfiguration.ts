import type { WorkjetConfiguration } from "./workjet.ts";

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
