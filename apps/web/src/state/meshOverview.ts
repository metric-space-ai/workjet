/**
 * Multi-computer mesh overview state.
 *
 * Every connected environment answers `workjet.mesh.overview` for itself: its
 * own mesh address plus the peer machines it has exchanged mailbox envelopes
 * with, as it LAST KNEW them. Nothing is merged across environments — a peer
 * row belongs to the machine that observed it, and pretending otherwise would
 * invent contact this client never saw.
 *
 * Deliberately absent: any notion of a machine being online. The server has no
 * liveness signal (the CTOX daemon's loopback surface is publish / pending /
 * consumed, with no presence route), so neither does this module.
 *
 * @module state/meshOverview
 */
import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, type WorkjetMeshOverview } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentMeshOverviewStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly overview: WorkjetMeshOverview | null;
}

const meshOverviewAtom = Atom.make((get): readonly EnvironmentMeshOverviewStatus[] => {
  const presentations = get(environmentPresentations.presentationsAtom);

  const statuses: EnvironmentMeshOverviewStatus[] = [];
  for (const [environmentId, presentation] of presentations) {
    const result = get(serverEnvironment.workjetMeshOverview({ environmentId, input: {} }));
    statuses.push({
      environmentId,
      label: presentation.entry.target.label,
      isPending: result.waiting,
      error:
        result._tag === "Failure" ? "This environment could not report its mesh overview." : null,
      overview: Option.getOrNull(AsyncResult.value(result)),
    });
  }
  return statuses;
}).pipe(Atom.withLabel("web-workjet:mesh:overview"));

export interface MeshOverviewView {
  readonly environments: readonly EnvironmentMeshOverviewStatus[];
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export function useMeshOverview(): MeshOverviewView {
  const environments = useAtomValue(meshOverviewAtom);

  // Refreshing only the derived atom would re-read each environment's query
  // inside its stale window and change nothing, exactly as in `state/usage`.
  const refresh = useCallback(() => {
    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.workjetMeshOverview({
          environmentId: environment.environmentId,
          input: {},
        }),
      );
    }
  }, [environments]);

  const answered = environments.filter(
    (environment) => environment.overview !== null || environment.error !== null,
  ).length;

  return {
    environments,
    isPending: environments.length > 0 && answered === 0,
    refresh,
  };
}
