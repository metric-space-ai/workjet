import {
  CommandId,
  type CtoxWorkjetComputerProjection,
  type CtoxWorkjetComputerSshKey,
  type CtoxWorkjetComputerControlRequest,
  type DesktopCtoxBridge,
  type WorkjetComputer,
} from "@workjet/contracts";
import { randomUUID } from "./lib/utils";
import { getCtoxClient, subscribeCtoxClients, type CtoxAppApi } from "./ctox/ctoxClient";
import type { CtoxMachineDocument } from "./ctox/workjetLiveData";
import { projectCtoxMachine } from "./ctox/machineControl";
import {
  enrollOperationalComputer,
  type OperationalComputerEnrollment,
} from "./computerCapabilityEnrollment";

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
      return "Bei der Instanz anmelden und erneut versuchen.";
    case "unsupported":
      return "Instanz braucht ein Update, um Rechner hinzuzufügen.";
    case "timeout":
      return "Instanz hat den Rechner noch nicht bestätigt.";
    case "unreachable":
      return "Instanz antwortet nicht.";
    case "sync_unavailable":
      return "Synchronisierung mit der Instanz unterbrochen.";
    case "query_unsupported":
      return "Instanz kann die Rechnerliste noch nicht laden. Backend aktualisieren.";
    case "command_failed":
      return "Instanz konnte die Rechner-Anfrage nicht ausführen.";
    case "response_invalid":
      return "Instanz lieferte ein unpassendes Ergebnis. Workjet und Backend aktualisieren.";
    case "not_active":
      return "Instanz öffnen und erneut versuchen.";
    default:
      return "Rechner konnte mit der Instanz nicht bestätigt werden.";
  }
}

/** @deprecated V4 reads are synchronous; retained for legacy consumers until slice C. */
export const MEMBERSHIP_DEADLINE_MS = 20_000;

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
  let currentApi: CtoxAppApi | null = null;
  let stopRows = () => {};
  let stopClients = () => {};
  const detach = () => {
    stopRows();
    stopClients();
    stopRows = () => {};
    stopClients = () => {};
  };
  const listeners = new Set<() => void>();
  const publish = (next: ComputerMembershipSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const select = (instanceId: string | null) => {
    if (snapshot.instanceId === instanceId) return;
    generation++;
    detach();
    currentApi = null;
    publish({ instanceId, phase: "loading", computers: [], pendingComputerId: null, error: null });
  };
  const refresh = async (instanceId: string, _bridge: DesktopCtoxBridge | undefined) => {
    select(instanceId);
    detach();
    let boundApi: CtoxAppApi | null | undefined;
    const bind = () => {
      if (snapshot.instanceId !== instanceId) return;
      const api = getCtoxClient(instanceId);
      if (api === boundApi) return;
      boundApi = api;
      if (api !== currentApi) {
        currentApi = api;
        generation++;
        publish({
          ...snapshot,
          phase: "loading",
          computers: [],
          pendingComputerId: null,
          error: null,
        });
      }
      stopRows();
      stopRows = () => {};
      if (snapshot.instanceId !== instanceId) return;
      if (!api) {
        publish({
          ...snapshot,
          phase: "loading",
          computers: [],
          pendingComputerId: null,
          error: null,
        });
        return;
      }
      const rows = api.query<CtoxMachineDocument>("workjet_computers", {
        selector: { status: "assigned", is_deleted: { $ne: true } },
      });
      const receive = (documents: CtoxMachineDocument[]) => {
        if (snapshot.instanceId !== instanceId || getCtoxClient(instanceId) !== api) return;
        try {
          publish({
            ...snapshot,
            phase: "ready",
            computers: documents.map(projectCtoxMachine),
            error: null,
          });
        } catch {
          publish({
            ...snapshot,
            phase: "failed",
            computers: [],
            error: membershipError("response_invalid"),
          });
        }
      };
      stopRows = rows.subscribe(receive);
    };
    stopClients = subscribeCtoxClients(bind);
    bind();
  };
  const changeAssignment = async (
    instanceId: string,
    computerId: string,
    assigned: boolean,
    request: CtoxWorkjetComputerControlRequest,
    bridge: DesktopCtoxBridge | undefined,
  ): Promise<boolean> => {
    if (
      snapshot.instanceId !== instanceId ||
      snapshot.phase !== "ready" ||
      snapshot.pendingComputerId !== null
    )
      return false;
    const revision = ++generation;
    publish({ ...snapshot, pendingComputerId: computerId, error: null });
    try {
      if (!bridge?.requestComputerControl) throw new Error(membershipError("unsupported"));
      const result = await bridge.requestComputerControl(instanceId, request);
      if (revision !== generation) return false;
      if (result._tag === "failed") throw new Error(membershipError(result.code));
      const response = result.response;
      if (
        (response.action !== "computer.assign" && response.action !== "computer.unassign") ||
        response.action !== (assigned ? "computer.assign" : "computer.unassign") ||
        response.computer.id !== computerId ||
        response.computer.status !== (assigned ? "assigned" : "unassigned")
      ) {
        throw new Error(membershipError("guest_failed"));
      }
      const remaining = snapshot.computers.filter((entry) => entry.id !== computerId);
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
  const unassign = (
    instanceId: string,
    computerId: string,
    bridge: DesktopCtoxBridge | undefined,
  ) =>
    changeAssignment(
      instanceId,
      computerId,
      false,
      {
        action: "computer.unassign",
        commandId: CommandId.make(randomUUID()),
        computerId,
      },
      bridge,
    );
  const setAssigned = (
    instanceId: string,
    computer: WorkjetComputer,
    assigned: boolean,
    bridge: DesktopCtoxBridge | undefined,
  ) =>
    assigned
      ? changeAssignment(
          instanceId,
          computer.id,
          true,
          {
            action: "computer.assign",
            commandId: CommandId.make(randomUUID()),
            computerId: computer.id,
            displayName: computer.label,
            hostingMode: "workstation",
            selfHostedColocation: false,
            capabilities: computer.harnesses
              .filter((entry) => entry.available)
              .map((entry) => entry.harness),
          },
          bridge,
        )
      : unassign(instanceId, computer.id, bridge);

  const enroll = async (
    instanceId: string,
    enrollment: OperationalComputerEnrollment,
    bridge: DesktopCtoxBridge | undefined,
  ): Promise<CtoxWorkjetComputerSshKey | null> => {
    if (
      snapshot.instanceId !== instanceId ||
      snapshot.phase !== "ready" ||
      snapshot.pendingComputerId !== null
    ) {
      throw new Error("Instanz prüft ihre Rechner noch.");
    }
    const revision = ++generation;
    const isCurrent = () => revision === generation && snapshot.instanceId === instanceId;
    publish({ ...snapshot, pendingComputerId: enrollment.computerId, error: null });
    try {
      const control = bridge?.requestComputerControl;
      if (!control) throw new Error(membershipError("unsupported"));
      let sshKey: CtoxWorkjetComputerSshKey | null = null;
      const confirmed = await enrollOperationalComputer(
        enrollment,
        (request) => control(instanceId, request),
        () => CommandId.make(randomUUID()),
        isCurrent,
        (key) => {
          sshKey = key;
        },
      );
      if (!isCurrent()) throw new Error("Instanz gewechselt. Rechner erneut hinzufügen.");
      publish({
        ...snapshot,
        computers: [...snapshot.computers.filter((entry) => entry.id !== confirmed.id), confirmed],
        pendingComputerId: null,
        error: null,
      });
      return sshKey;
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : membershipError("guest_failed");
      if (isCurrent()) publish({ ...snapshot, pendingComputerId: null, error: message });
      throw new Error(message, { cause: failure });
    }
  };
  return {
    dispose: () => {
      generation++;
      currentApi = null;
      detach();
    },
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
    unassign,
    enroll,
  };
}

export const workjetComputerMembership = createComputerMembershipStore();
