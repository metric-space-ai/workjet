/**
 * Andockpunkt für den Ein-Klick-Beitritt (ctox sync v4 §16.41).
 *
 * Heute: Adapter über den vorhandenen Installationsweg der Rechner-Seite
 * (legacyMachineEnrollment). Freitag (V4-Kern): hier die Quelle gegen
 * `useCtoxCommand('ctox.machine.enroll.begin' | '.cancel')` und
 * `useCtoxDoc('machine_enrollments/<id>')` tauschen; die UI bleibt gleich.
 */
import { useMemo, useRef } from "react";

import {
  createLegacyMachineEnrollment,
  type LegacyEnrollmentDeps,
} from "./legacyMachineEnrollment";
import type { MachineEnrollmentSource, MachineInstallTransport } from "./machineEnrollment";

export interface MachineEnrollmentAdapters {
  readonly source: MachineEnrollmentSource;
  readonly transport: MachineInstallTransport;
}

/**
 * Die Adapter bleiben über Renderings stabil; die Abhängigkeiten werden über
 * eine Referenz immer aktuell gelesen (laufende Beitritte überleben Re-Render).
 */
export function useMachineEnrollment(deps: LegacyEnrollmentDeps): MachineEnrollmentAdapters {
  const latest = useRef(deps);
  latest.current = deps;
  return useMemo(
    () =>
      createLegacyMachineEnrollment({
        listSshHosts: () => latest.current.listSshHosts(),
        discoverTailscalePeers: () =>
          latest.current.discoverTailscalePeers
            ? latest.current.discoverTailscalePeers()
            : Promise.resolve({ status: "unavailable" as const, peers: [] }),
        get localName() {
          return latest.current.localName;
        },
        installKey: (target) =>
          latest.current.installKey
            ? latest.current.installKey(target)
            : Promise.resolve({ ok: false, message: "Schlüsseleintrag nicht verfügbar." }),
        add: (request, phase) => latest.current.add(request, phase),
        isOnline: (environmentId) => latest.current.isOnline(environmentId),
      }),
    [],
  );
}
