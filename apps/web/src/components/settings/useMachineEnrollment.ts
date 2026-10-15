/**
 * Andockpunkt für den Ein-Klick-Beitritt (ctox sync v4 §16.41).
 *
 * Bis die Instanzseite steht (ctox sync v4: `ctox.machine.enroll.begin/cancel`,
 * Collection `machine_enrollments`, Phase 11 mit useCtoxDoc/useCtoxCommand)
 * und der Desktop seinen Installationsweg über IPC anbietet, gibt es keine
 * echte Quelle: der Hook liefert null, die Rechner-Seite bleibt beim
 * bisherigen Panel. Sichtbar wird der neue Weg nur im Entwicklermodus UND mit
 * beiden Adaptern; nichts Halbfertiges erreicht Nutzer.
 */
import { useClientSettings } from "../../hooks/useSettings";
import type { MachineEnrollmentSource, MachineInstallTransport } from "./machineEnrollment";

export interface MachineEnrollmentAdapters {
  readonly source: MachineEnrollmentSource;
  readonly transport: MachineInstallTransport;
}

/** Fr: hier `useCtoxDoc`/`useCtoxCommand` und `desktopBridge.machineEnroll*` einsetzen. */
function useMachineEnrollmentAdaptersOrNull(): MachineEnrollmentAdapters | null {
  return null;
}

export function useMachineEnrollment(): MachineEnrollmentAdapters | null {
  const developerMode = useClientSettings((settings) => settings.developerMode);
  const adapters = useMachineEnrollmentAdaptersOrNull();
  return developerMode && adapters ? adapters : null;
}
