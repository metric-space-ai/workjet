// SPDX-License-Identifier: MIT OR AGPL-3.0-only
/**
 * Workjet-owned composer surfaces, behind ONE import — same reasoning as
 * `components/workjetSurfaces.ts`: keep Workjet additions out of the shared
 * import block that upstream also edits (docs/workjet-plan.md §14).
 *
 * Re-exports only.
 */
export { GREPPY_CAPABILITY_ID, WorkjetCapabilityMenu } from "./WorkjetCapabilityMenu";
export { WorkjetRoleControl, type WorkjetSelectableRole } from "./WorkjetRoleControl";
export {
  COMPOSER_COMPUTER_LOCKED_REASON,
  ComposerComputerControl,
  ComposerManualTargetControls,
  ComposerSystemPromptControl,
  ComposerWorkjetCompactMenuContent,
  gatewayModelsForRoute,
  harnessForProviderInstanceId,
} from "./ComposerWorkjetTargetControls";
