import {
  CommandId,
  type CtoxWorkjetComputerProjection,
  type CtoxWorkjetComputerSshKey,
  type CtoxWorkjetComputerControlRequest,
  type DesktopCtoxBridge,
  type WorkjetComputer,
} from "@workjet/contracts";
import { randomUUID } from "./lib/utils";
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
  /**
   * Ab wann die Fehlerzeile sichtbar ist (UI-Vertrag: still wiederholen, erst nach
   * 2 min zeigen). Bleibt über stille Wiederholungen stehen; null nach Erfolg.
   */
  readonly failureVisibleAtMs?: number | null;
}

/** Nach dieser Dauer ununterbrochener Fehler erscheint die Zeile. */
export const MEMBERSHIP_FAILURE_GRACE_MS = 120_000;
/** Abstand der stillen Wiederholungen nach einem Fehler. */
export const MEMBERSHIP_SILENT_RETRY_MS = 30_000;
/** Fehler, die nur der Nutzer beheben kann: Zeile sofort, keine stille Wiederholung. */
const USER_ACTION_CODES = new Set(["authentication_required", "unsupported", "query_unsupported"]);

class MembershipFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(membershipError(code));
    this.code = code;
  }
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

/**
 * A blocked instance must not leave the list loading forever. The desktop waits up to
 * 45 s for the CTOX guest; a shorter deadline here discarded answers that arrived
 * between 20 and 45 s (Welsch, 16.10.: computer.list took 9–45 s).
 */
export const MEMBERSHIP_DEADLINE_MS = 50_000;
function withDeadline<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new MembershipFailure("unreachable")),
      MEMBERSHIP_DEADLINE_MS,
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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
    publish({
      instanceId,
      phase: "loading",
      computers: [],
      pendingComputerId: null,
      error: null,
      failureVisibleAtMs: null,
    });
  };
  const refresh = async (instanceId: string, bridge: DesktopCtoxBridge | undefined) => {
    select(instanceId);
    const revision = ++generation;
    // A focus refresh must not remove the selected computer while its inventory reloads.
    // Changing instances clears the previous inventory in select(); a failed refresh also clears it.
    publish({ ...snapshot, phase: "loading", error: null, pendingComputerId: null });
    try {
      if (!bridge?.requestComputerControl) throw new MembershipFailure("unsupported");
      let result = await withDeadline(
        bridge.requestComputerControl(instanceId, {
          action: "computer.list",
          includeOperationalDetails: true,
        }),
      );
      if (revision !== generation) return;
      if (result._tag === "failed" && result.code === "not_active" && bridge.ensurePooled) {
        await withDeadline(bridge.ensurePooled(instanceId));
        if (revision !== generation) return;
        result = await withDeadline(
          bridge.requestComputerControl(instanceId, {
            action: "computer.list",
            includeOperationalDetails: true,
          }),
        );
      }
      if (revision !== generation) return;
      if (result._tag === "failed") throw new MembershipFailure(result.code);
      if (result.response.action !== "computer.list") throw new MembershipFailure("guest_failed");
      publish({
        instanceId,
        phase: "ready",
        computers: result.response.computers,
        pendingComputerId: null,
        error: null,
        failureVisibleAtMs: null,
      });
    } catch (error) {
      if (revision !== generation) return;
      const code = error instanceof MembershipFailure ? error.code : "guest_failed";
      const userAction = USER_ACTION_CODES.has(code);
      const now = Date.now();
      const previous = snapshot.instanceId === instanceId ? snapshot.failureVisibleAtMs : null;
      publish({
        instanceId,
        phase: "failed",
        computers: [],
        pendingComputerId: null,
        error: error instanceof Error ? error.message : membershipError("guest_failed"),
        failureVisibleAtMs: userAction
          ? now
          : Math.min(previous ?? Number.POSITIVE_INFINITY, now + MEMBERSHIP_FAILURE_GRACE_MS),
      });
      if (!userAction) {
        // Still wiederholen; ein neuer Aufruf (Fokus, Instanzwechsel) überholt diesen.
        setTimeout(() => {
          if (revision === generation && snapshot.phase === "failed")
            void refresh(instanceId, bridge);
        }, MEMBERSHIP_SILENT_RETRY_MS);
      }
    }
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
