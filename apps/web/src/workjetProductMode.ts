import type { WorkjetProductMode } from "@t3tools/contracts/settings";

/**
 * Re-exported so a consumer needs ONE Workjet import instead of two — the
 * type from contracts and the resolver from here were separate lines in
 * shared import blocks that upstream also edits (docs/workjet-plan.md §14).
 */
export type { WorkjetProductMode };

export interface WorkjetProductModeResolutionInput {
  readonly configuredMode: unknown;
  readonly isElectron: boolean;
}

/**
 * CTOX is intentionally limited to the Electron renderer until a guest and its
 * transport exist. Fail closed to Code for browsers, future non-Electron
 * surfaces, and any externally seeded value that escaped settings validation.
 */
export function resolveWorkjetProductMode({
  configuredMode,
  isElectron,
}: WorkjetProductModeResolutionInput): WorkjetProductMode {
  return isElectron && configuredMode === "ctox" ? "ctox" : "code";
}
