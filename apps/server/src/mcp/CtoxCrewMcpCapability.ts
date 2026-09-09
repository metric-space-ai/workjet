import type { ProviderInstanceId, ThreadId } from "@workjet/contracts";
import type * as Effect from "effect/Effect";
import type { makeCtoxNativeTaskClient } from "../workjet/ctox/CtoxNativeTaskClient.ts";

type NativeCrewClaim = Effect.Success<
  ReturnType<ReturnType<typeof makeCtoxNativeTaskClient>["claimProjectOffer"]>
>;

/** Server-only closures from a verified native claim. Never part of provider config. */
export interface CtoxCrewMcpCapability {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly attemptId: string;
  readonly refreshContext: NativeCrewClaim["refreshContext"];
  readonly updatePlan: NativeCrewClaim["updatePlan"];
  readonly report: NativeCrewClaim["report"];
}
