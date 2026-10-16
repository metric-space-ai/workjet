import * as Schema from "effect/Schema";
import {
  WorkjetLumaSnapshot,
  type EnvironmentId,
  type WorkjetLumaTarget,
} from "@workjet/contracts";
import { createCtoxReadAtomFamily } from "./readAtoms";
import { CtoxLocalReadError } from "./projectReadData";
import { verifyCtoxConnectionTarget } from "./crossModeReadData";

type Target = { readonly environmentId: EnvironmentId; readonly input: WorkjetLumaTarget };
const lumas = createCtoxReadAtomFamily<Target, WorkjetLumaSnapshot>({
  collections: [
    "workjet_connections",
    "workjet_luma_state",
    "workjet_worker_profiles",
    "workjet_llm_routes",
    "workjet_model_prompts",
  ],
  read: (api, target) => {
    verifyCtoxConnectionTarget(api, target.input, target.environmentId);
    const metadata = api.get<Record<string, unknown>>("workjet_luma_state", "instance").get();
    if (!metadata || typeof metadata.configured !== "boolean")
      throw new CtoxLocalReadError(
        "not_found",
        "luma_configuration_missing",
        "workjet_luma_state/instance",
      );
    if (!metadata.configured)
      return Schema.decodeUnknownSync(WorkjetLumaSnapshot)({
        revision: metadata.revision,
        updatedAtMs: metadata.updatedAtMs,
        configuration: null,
      });
    for (const name of [
      "managedSystemPrompt",
      "managerThreadReference",
      "workerGraph",
      "execution",
      "telemetry",
    ])
      if (metadata[name] === undefined)
        throw new CtoxLocalReadError(
          "not_found",
          "configuration_field_missing",
          `workjet_luma_state.${name}`,
        );
    const selector = { is_deleted: { $ne: true } };
    return Schema.decodeUnknownSync(WorkjetLumaSnapshot)({
      revision: metadata.revision,
      updatedAtMs: metadata.updatedAtMs,
      configuration: {
        managedSystemPrompt: metadata.managedSystemPrompt,
        managerThreadReference: metadata.managerThreadReference,
        workerGraph: metadata.workerGraph,
        execution: metadata.execution,
        telemetry: metadata.telemetry,
        workerProfiles: api.query("workjet_worker_profiles", { selector }).get(),
        llmRoutes: api.query("workjet_llm_routes", { selector }).get(),
        modelPrompts: api.query("workjet_model_prompts", { selector }).get(),
      },
    });
  },
});
export const ctoxLumaReads = {
  lumaConfiguration: (target: Target) => lumas(JSON.stringify(target)),
};
