/**
 * Attrappe für Tests und Screenshots: spielt den Vertrag §16.41 ohne Instanz
 * und ohne Desktop durch. Nichts verbindet sich irgendwohin.
 */
import {
  MACHINE_ENROLLMENT_STEP_KEYS,
  type MachineEnrollmentStep,
  type MachineEnrollmentStepKey,
} from "@workjet/contracts";

import type {
  MachineCandidate,
  MachineCapabilities,
  MachineEnrollmentSnapshot,
  MachineEnrollmentSource,
  MachineInstallTransport,
} from "./machineEnrollment";

export interface FixtureFailure {
  readonly key: MachineEnrollmentStepKey;
  readonly error_code: string;
  readonly detail: string;
}

export interface FixtureOptions {
  /** Abstand zwischen zwei Schritten. */
  readonly stepMs?: number;
  /** Fehler je Kandidat (nach Name). */
  readonly failures?: Readonly<Record<string, FixtureFailure>>;
  /** Hält vor diesem Schritt an (für feste Screenshots). */
  readonly holdBefore?: MachineEnrollmentStepKey | null;
  readonly capabilities?: Readonly<Record<string, MachineCapabilities>>;
  readonly candidates?: ReadonlyArray<MachineCandidate>;
  readonly now?: () => number;
  readonly schedule?: (fn: () => void, ms: number) => void;
}

export const FIXTURE_MACHINE_CANDIDATES: ReadonlyArray<MachineCandidate> = [
  {
    id: "local",
    transport: "local",
    name: "MacBook Pro",
    user: null,
    host: null,
    port: null,
    sshAlias: null,
  },
  {
    id: "ssh:ts-gpu1",
    transport: "ssh",
    name: "ts-gpu1",
    user: "deck",
    host: "100.87.204.48",
    port: 22,
    sshAlias: "ts-gpu1",
  },
  {
    id: "ssh:lan-gpu3",
    transport: "ssh",
    name: "lan-gpu3",
    user: "metricspace",
    host: "192.168.1.30",
    port: 22,
    sshAlias: "lan-gpu3",
  },
  {
    id: "ssh:skf-vm",
    transport: "ssh",
    name: "skf-vm",
    user: "ctox",
    host: "10.20.0.4",
    port: 2222,
    sshAlias: "skf-vm",
  },
  {
    id: "tailscale:gpu4",
    transport: "tailscale",
    name: "gpu4",
    user: "metricspace",
    host: "100.120.16.93",
    port: 22,
    sshAlias: "ts-gpu4",
  },
  {
    id: "tailscale:nas-asustor",
    transport: "tailscale",
    name: "nas-asustor",
    user: null,
    host: "100.64.0.28",
    port: 22,
    sshAlias: null,
  },
];

interface FixtureEnrollment {
  readonly id: string;
  readonly label: string;
  steps: MachineEnrollmentStep[];
  capabilities: MachineCapabilities | null;
  listeners: Set<(snapshot: MachineEnrollmentSnapshot) => void>;
  cancelled: boolean;
}

export function createFixtureMachineEnrollment(options: FixtureOptions = {}): {
  readonly source: MachineEnrollmentSource;
  readonly transport: MachineInstallTransport;
} {
  const stepMs = options.stepMs ?? 700;
  const now = options.now ?? (() => Date.now());
  const schedule =
    options.schedule ?? ((fn: () => void, ms: number) => void globalThis.setTimeout(fn, ms));
  const enrollments = new Map<string, FixtureEnrollment>();
  let counter = 0;

  const emit = (entry: FixtureEnrollment) => {
    const snapshot: MachineEnrollmentSnapshot = {
      steps: [...entry.steps],
      capabilities: entry.capabilities,
    };
    for (const listener of entry.listeners) listener(snapshot);
  };
  const put = (entry: FixtureEnrollment, step: MachineEnrollmentStep) => {
    entry.steps = [...entry.steps.filter((existing) => existing.key !== step.key), step];
    emit(entry);
  };
  const failureFor = (entry: FixtureEnrollment, key: MachineEnrollmentStepKey) => {
    const failure = options.failures?.[entry.label];
    return failure && failure.key === key ? failure : null;
  };
  // Läuft einen Schritt: running → done (oder failed) und ruft `next` auf.
  const runStep = (
    entry: FixtureEnrollment,
    key: MachineEnrollmentStepKey,
    report: (step: MachineEnrollmentStep) => void,
    next: () => void,
  ) => {
    if (entry.cancelled || options.holdBefore === key) return;
    report({ key, state: "running", at_ms: now() });
    schedule(() => {
      if (entry.cancelled) return;
      const failure = failureFor(entry, key);
      if (failure) {
        report({
          key,
          state: "failed",
          at_ms: now(),
          error_code: failure.error_code,
          detail: failure.detail,
        });
        return;
      }
      report({ key, state: "done", at_ms: now() });
      next();
    }, stepMs);
  };
  // Ab `service_started` meldet sich der Rechner selbst über seinen Peer.
  const machineSide = (entry: FixtureEnrollment, index: number) => {
    const key = MACHINE_ENROLLMENT_STEP_KEYS[index];
    if (!key) return;
    if (key === "green") {
      entry.capabilities = options.capabilities?.[entry.label] ?? {
        build: true,
        storage: false,
        gpu: null,
      };
    }
    runStep(
      entry,
      key,
      (step) => put(entry, step),
      () => machineSide(entry, index + 1),
    );
  };

  const source: MachineEnrollmentSource = {
    begin: async ({ label }) => {
      counter += 1;
      const id = `fixture-enrollment-${counter}`;
      const entry: FixtureEnrollment = {
        id,
        label,
        steps: [{ key: "token_issued", state: "done", at_ms: now() }],
        capabilities: null,
        listeners: new Set(),
        cancelled: false,
      };
      enrollments.set(id, entry);
      return { enrollment_id: id, join_token: `fixture-token-${counter}`, installer_ref: "fixture" };
    },
    cancel: async (id) => {
      const entry = enrollments.get(id);
      if (!entry) return;
      entry.cancelled = true;
      entry.listeners.clear();
      enrollments.delete(id);
    },
    watch: (id, onSnapshot) => {
      const entry = enrollments.get(id);
      if (!entry) return () => undefined;
      entry.listeners.add(onSnapshot);
      onSnapshot({ steps: [...entry.steps], capabilities: entry.capabilities });
      return () => entry.listeners.delete(onSnapshot);
    },
    reportTransportStep: async (id, step) => {
      const entry = enrollments.get(id);
      if (!entry) return;
      put(entry, step);
      if (step.key === "installed" && step.state === "done") machineSide(entry, 4);
    },
  };

  const transport: MachineInstallTransport = {
    listCandidates: async () => options.candidates ?? FIXTURE_MACHINE_CANDIDATES,
    install: async ({ enrollmentId }, onStep) => {
      const entry = enrollments.get(enrollmentId);
      if (!entry) return;
      const keys = ["transport_connected", "package_copied", "installed"] as const;
      const go = (index: number) => {
        const key = keys[index];
        if (!key) return;
        runStep(
          entry,
          key,
          (step) => onStep({ ...step, key }),
          () => go(index + 1),
        );
      };
      go(0);
    },
  };

  return { source, transport };
}
