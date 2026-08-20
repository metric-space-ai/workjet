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
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type WorkjetMeshOverview,
  type WorkjetMeshWorkspaceId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

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

/** One peer identified for revocation. Ids only; no key material exists here. */
export interface MeshPeerRevocationTarget {
  /** The OBSERVING machine — the one whose pin table is being written. */
  readonly environmentId: EnvironmentId;
  readonly peerWorkspaceId: WorkjetMeshWorkspaceId;
  readonly peerEnvironmentId: EnvironmentId;
}

export interface MeshOverviewView {
  readonly environments: readonly EnvironmentMeshOverviewStatus[];
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  readonly refresh: () => void;
  /**
   * DESTROY one peer's pinned mesh keys. The next envelope that verifies from
   * that address establishes a fresh pin, and the destroyed keys are refused
   * forever after.
   *
   * The confirmation lives in the component, not here: this function performs
   * the revocation the moment it is called, so a caller that skipped the dialog
   * would destroy a trust binding on a single click.
   */
  readonly revokePeer: (target: MeshPeerRevocationTarget) => void;
  /** The peer address currently being revoked, or null. */
  readonly revoking: string | null;
}

export function useMeshOverview(): MeshOverviewView {
  const environments = useAtomValue(meshOverviewAtom);
  const revoke = useAtomCommand(serverEnvironment.revokeWorkjetMeshPeer, {
    reportFailure: false,
  });
  const [revoking, setRevoking] = useState<string | null>(null);

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

  const revokePeer = useCallback(
    (target: MeshPeerRevocationTarget) => {
      if (revoking !== null) return;
      setRevoking(target.peerEnvironmentId);
      void (async () => {
        const result = await revoke({
          environmentId: target.environmentId,
          input: {
            schemaVersion: 1,
            workspaceId: target.peerWorkspaceId,
            environmentId: target.peerEnvironmentId,
          },
        });
        if (result._tag === "Success") {
          const revoked = result.value.outcome === "revoked";
          toastManager.add({
            type: revoked ? "success" : "warning",
            title: revoked ? "Peer trust revoked" : "No pinned keys for that machine",
            // Say what changed AND what did not: the pin is gone, but the
            // machine is not blocked — it will be trusted again on its next
            // verified envelope, which is the whole point of the recovery path.
            description: revoked
              ? `${target.peerEnvironmentId} is no longer trusted. Its old keys are refused permanently; the next envelope that verifies from it establishes a new pin.`
              : "Nothing was destroyed. This machine had no pinned keys for that address.",
          });
        } else if (!isAtomCommandInterrupted(result)) {
          toastManager.add({
            type: "error",
            title: "The trust pin was not revoked",
            description: "Nothing was changed. The peer is still trusted as before.",
          });
        }
      })().finally(() => setRevoking(null));
    },
    [revoke, revoking],
  );

  return {
    environments,
    isPending: environments.length > 0 && answered === 0,
    refresh,
    revokePeer,
    revoking,
  };
}
