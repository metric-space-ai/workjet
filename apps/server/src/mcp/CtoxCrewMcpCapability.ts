import type { ProviderInstanceId, ThreadId } from "@workjet/contracts";
import type * as Effect from "effect/Effect";
import type { CtoxCrewContext } from "../workjet/ctox/CtoxCrewClaim.ts";
import type { CtoxCrewResultCandidate } from "../workjet/ctox/CtoxCrewReport.ts";

/** Server-only closures from a verified native claim. Never part of provider config. */
export interface CtoxCrewMcpCapability {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly attemptId: string;
  readonly refreshContext: () => Effect.Effect<typeof CtoxCrewContext.Type, unknown>;
  readonly report: (candidate: CtoxCrewResultCandidate) => Effect.Effect<
    {
      readonly accepted: true;
      readonly attempt_id: string;
      readonly review_status: "pending";
    },
    unknown
  >;
}
