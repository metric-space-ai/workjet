import {
  CommandId,
  type CtoxWorkjetComputerProjection,
  type DesktopCtoxBridge,
  type WorkjetComputer,
} from "@workjet/contracts";
import { randomUUID } from "./lib/utils";

export interface ComputerMembershipSnapshot {
  readonly instanceId: string | null;
  readonly phase: "loading" | "ready" | "failed";
  readonly computers: ReadonlyArray<CtoxWorkjetComputerProjection>;
  readonly pendingComputerId: string | null;
  readonly error: string | null;
}

function membershipError(code: string): string {
  switch (code) {
    case "authentication_required":
      return "Sign in to the selected Business OS, then retry.";
    case "unsupported":
      return "This Business OS needs an update before it can add computers.";
    case "timeout":
      return "The Business OS has not confirmed the computer yet. Refresh to check its status.";
    case "not_active":
      return "Open the selected Business OS and retry.";
    default:
      return "Could not confirm the computer with this Business OS. Check its connection and retry.";
  }
}

/** Only native-confirmed projections enter this store. It never persists local membership claims. */
export function createComputerMembershipStore() {
  let snapshot: ComputerMembershipSnapshot = {
    instanceId: null,
    phase: "loading",
    computers: [],
    pendingComputerId: null,
    error: null,
  };
  let generation = 0;
  const listeners = new Set<() => void>();
  const publish = (next: ComputerMembershipSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const select = (instanceId: string | null) => {
    if (snapshot.instanceId === instanceId) return;
    generation++;
    publish({ instanceId, phase: "loading", computers: [], pendingComputerId: null, error: null });
  };
  const refresh = async (instanceId: string, bridge: DesktopCtoxBridge | undefined) => {
    select(instanceId);
    const revision = ++generation;
    // A focus refresh must not remove the selected computer while its inventory reloads.
    // Changing instances clears the previous inventory in select(); a failed refresh also clears it.
    publish({ ...snapshot, phase: "loading", error: null, pendingComputerId: null });
    try {
      if (!bridge?.requestComputerControl) throw new Error(membershipError("unsupported"));
      let result = await bridge.requestComputerControl(instanceId, { action: "computer.list" });
      if (revision !== generation) return;
      if (result._tag === "failed" && result.code === "not_active" && bridge.ensurePooled) {
        await bridge.ensurePooled(instanceId);
        if (revision !== generation) return;
        result = await bridge.requestComputerControl(instanceId, { action: "computer.list" });
      }
      if (revision !== generation) return;
      if (result._tag === "failed") throw new Error(membershipError(result.code));
      if (result.response.action !== "computer.list")
        throw new Error(membershipError("guest_failed"));
      publish({
        instanceId,
        phase: "ready",
        computers: result.response.computers,
        pendingComputerId: null,
        error: null,
      });
    } catch (error) {
      if (revision !== generation) return;
      publish({
        instanceId,
        phase: "failed",
        computers: [],
        pendingComputerId: null,
        error: error instanceof Error ? error.message : membershipError("guest_failed"),
      });
    }
  };
  const setAssigned = async (
    instanceId: string,
    computer: WorkjetComputer,
    assigned: boolean,
    bridge: DesktopCtoxBridge | undefined,
  ): Promise<boolean> => {
    if (
      snapshot.instanceId !== instanceId ||
      snapshot.phase !== "ready" ||
      snapshot.pendingComputerId !== null
    )
      return false;
    const revision = ++generation;
    publish({ ...snapshot, pendingComputerId: computer.id, error: null });
    try {
      if (!bridge?.requestComputerControl) throw new Error(membershipError("unsupported"));
      const common = { commandId: CommandId.make(randomUUID()), computerId: computer.id };
      const result = await bridge.requestComputerControl(
        instanceId,
        assigned
          ? {
              action: "computer.assign",
              ...common,
              displayName: computer.label,
              hostingMode: "workstation",
              selfHostedColocation: false,
              capabilities: computer.harnesses
                .filter((entry) => entry.available)
                .map((entry) => entry.harness),
            }
          : { action: "computer.unassign", ...common },
      );
      if (revision !== generation) return false;
      if (result._tag === "failed") throw new Error(membershipError(result.code));
      const response = result.response;
      if (
        response.action !== (assigned ? "computer.assign" : "computer.unassign") ||
        response.computer.id !== computer.id ||
        response.computer.status !== (assigned ? "assigned" : "unassigned")
      ) {
        throw new Error(membershipError("guest_failed"));
      }
      const remaining = snapshot.computers.filter((entry) => entry.id !== computer.id);
      publish({
        ...snapshot,
        computers: assigned ? [...remaining, response.computer] : remaining,
        pendingComputerId: null,
        error: null,
      });
      return true;
    } catch (error) {
      if (revision !== generation) return false;
      publish({
        ...snapshot,
        pendingComputerId: null,
        error: error instanceof Error ? error.message : membershipError("guest_failed"),
      });
      return false;
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select,
    refresh,
    setAssigned,
  };
}

export const workjetComputerMembership = createComputerMembershipStore();
