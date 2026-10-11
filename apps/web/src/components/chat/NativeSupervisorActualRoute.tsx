import { WorkjetHarness } from "@workjet/contracts";
import * as Schema from "effect/Schema";
import {
  supervisorActualComputation,
  type SupervisorRouteState,
} from "../../workjetSupervisorRoute";
import { workjetHarnessDisplayLabel } from "../settings/WorkjetWorkerEditor";

export function NativeSupervisorActualRoute({
  state,
}: {
  readonly state: SupervisorRouteState | null;
}) {
  const actual = supervisorActualComputation(state);
  if (actual === null) return null;
  const harness = Schema.is(WorkjetHarness)(actual.harness)
    ? workjetHarnessDisplayLabel(actual.harness)
    : actual.harness;
  return (
    <p
      role="status"
      className="mt-1 text-xs text-muted-foreground"
      title={`Observed ${new Date(actual.published_at_ms).toLocaleString()}`}
    >
      Last execution · {harness} · {actual.model}
    </p>
  );
}
