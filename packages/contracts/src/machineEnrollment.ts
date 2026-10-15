/**
 * Rechner-Beitritt (ctox sync v4, Architektur §16.41): Fortschrittsschritte
 * im Dokument `machine_enrollments/<id>`. Die Reihenfolge der Schlüssel ist
 * fest. Bis `installed` schreibt der Desktop (Installationsweg), ab
 * `service_started` der Rechner selbst über seinen Peer.
 */
export const MACHINE_ENROLLMENT_STEP_KEYS = [
  "token_issued",
  "transport_connected",
  "package_copied",
  "installed",
  "service_started",
  "device_bound",
  "peer_connected",
  "green",
] as const;

export type MachineEnrollmentStepKey = (typeof MACHINE_ENROLLMENT_STEP_KEYS)[number];

/** Schritte, die der Desktop aus der Installer-Ausgabe meldet. */
export const MACHINE_ENROLLMENT_TRANSPORT_STEP_KEYS = [
  "transport_connected",
  "package_copied",
  "installed",
] as const satisfies ReadonlyArray<MachineEnrollmentStepKey>;

export type MachineEnrollmentTransportStepKey =
  (typeof MACHINE_ENROLLMENT_TRANSPORT_STEP_KEYS)[number];

export type MachineEnrollmentStepState = "pending" | "running" | "done" | "failed";

export type MachineEnrollmentTransport = "local" | "ssh" | "tailscale";

export interface MachineEnrollmentStep {
  readonly key: MachineEnrollmentStepKey;
  readonly state: MachineEnrollmentStepState;
  readonly at_ms: number;
  readonly detail?: string;
  readonly error_code?: string;
}

/** Antwort auf `ctox.machine.enroll.begin`. Token einmalig, 15 min, instanzgebunden. */
export interface MachineEnrollmentBeginResult {
  readonly enrollment_id: string;
  readonly join_token: string;
  readonly installer_ref: string;
}
