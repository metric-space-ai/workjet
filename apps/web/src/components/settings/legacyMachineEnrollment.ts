/**
 * Übergangs-Adapter für den Ein-Klick-Beitritt: bildet den HEUTE vorhandenen
 * Installationsweg (Rechner-Seite `addComputer`: SSH über
 * DesktopSshEnvironment.ensureEnvironment bzw. lokal, Werkzeugprüfung,
 * Erkennung, Eintrag in der Instanz) grob auf die acht Vertragsschritte aus
 * ctox sync v4 §16.41 ab. Grün = der Rechner steht in der Rechnerliste als
 * online.
 *
 * Am Freitag (V4-Kern) wird nur dieser Adapter gegen die echte Quelle
 * (`ctox.machine.enroll.begin/cancel`, Dokument `machine_enrollments/<id>`)
 * getauscht; die UI bleibt.
 */
import type {
  DesktopDiscoveredSshHost,
  DesktopTailscalePeers,
  EnvironmentId,
} from "@workjet/contracts";

import type { AddComputerOutcome, AddComputerRequest } from "./AddComputerInline";
import {
  MACHINE_ENROLLMENT_STEP_KEYS,
  type MachineCandidate,
  type MachineEnrollmentSnapshot,
  type MachineEnrollmentSource,
  type MachineEnrollmentStep,
  type MachineEnrollmentStepKey,
  type MachineInstallTransport,
} from "./machineEnrollment";
import { claimSshPassword } from "./sshPasswordOnce";

export type AddComputerPhase = (key: MachineEnrollmentStepKey, state: "running" | "done") => void;

export interface LegacyEnrollmentDeps {
  /** Host-Einträge aus ~/.ssh/config (Desktop-IPC, mit `ssh -G` aufgelöst). */
  readonly listSshHosts: () => Promise<ReadonlyArray<DesktopDiscoveredSshHost>>;
  readonly discoverTailscalePeers?: (() => Promise<DesktopTailscalePeers>) | undefined;
  /** null, wenn dieser Rechner nicht hinzugefügt werden kann. */
  readonly localName: string | null;
  readonly add: (
    request: AddComputerRequest,
    phase: AddComputerPhase,
  ) => Promise<AddComputerOutcome & { readonly environmentId?: EnvironmentId }>;
  /** Steht der Rechner dieser Umgebung in der Liste als online? */
  readonly isOnline: (environmentId: EnvironmentId) => boolean;
  readonly now?: () => number;
  readonly schedule?: (fn: () => void, ms: number) => void;
  readonly onlinePollMs?: number;
  readonly onlineTimeoutMs?: number;
}

const WILDCARD = /[*?!]/u;

/** Quellenliste: dieser Rechner, SSH-Hosts, tailnet-Geräte (je Gerät einmal). */
export function legacyMachineCandidates(input: {
  readonly localName: string | null;
  readonly sshHosts: ReadonlyArray<DesktopDiscoveredSshHost>;
  readonly peers: DesktopTailscalePeers | null;
}): ReadonlyArray<MachineCandidate> {
  const ssh: MachineCandidate[] = input.sshHosts
    .filter((host) => host.source === "ssh-config" && !WILDCARD.test(host.alias))
    .map((host) => ({
      id: `ssh:${host.alias}`,
      transport: "ssh" as const,
      name: host.alias,
      user: host.username,
      host: host.hostname,
      port: host.port,
      sshAlias: host.alias,
    }));
  const claimed = new Set<string>();
  const tailnet: MachineCandidate[] = [];
  for (const peer of input.peers?.status === "available" ? input.peers.peers : []) {
    if (!peer.online) continue;
    const short = peer.name.split(".")[0] ?? peer.name;
    const match = ssh.find(
      (entry) =>
        entry.host === peer.hostname ||
        entry.host === peer.name ||
        entry.host === short ||
        entry.name === short,
    );
    if (match) claimed.add(match.id);
    // Tailscale = SSH auf die tailnet-Adresse; Benutzer aus dem Host-Eintrag,
    // sonst fragt die Liste nach (nie der lokale Benutzer).
    tailnet.push({
      id: `tailscale:${short}`,
      transport: "tailscale",
      name: short,
      user: match?.user ?? null,
      host: peer.hostname,
      port: match?.port ?? null,
      sshAlias: match?.sshAlias ?? null,
    });
  }
  return [
    ...(input.localName
      ? [
          {
            id: "local",
            transport: "local" as const,
            name: input.localName,
            user: null,
            host: null,
            port: null,
            sshAlias: null,
          },
        ]
      : []),
    ...ssh.filter((entry) => !claimed.has(entry.id)),
    ...tailnet,
  ];
}

export function requestForCandidate(
  candidate: MachineCandidate,
  label: string,
): AddComputerRequest {
  return {
    kind: candidate.transport,
    target:
      candidate.transport === "local"
        ? null
        : {
            alias: candidate.sshAlias ?? candidate.host ?? candidate.name,
            hostname: candidate.host ?? candidate.name,
            username: candidate.user,
            port: candidate.port,
          },
    label,
    // Fähigkeiten werden nach der Verbindung erkannt und in der Zeile geschaltet.
    roles: { build: false, storage: false, gpu: false },
    hostKey: null,
    identityFile: null,
    // Erkannte GPU gilt als an („wenn eine GPU da ist, kann sie benutzt werden“).
    gpuDecided: false,
  };
}

/** Rohtext des heutigen Wegs → error_code des Vertrags. */
export function legacyErrorCode(
  key: MachineEnrollmentStepKey,
  message: string,
  withPassword = false,
): string {
  if (/permission denied|publickey|authentication|anmeldung/iu.test(message))
    return withPassword ? "password_rejected" : "auth_rejected";
  if (/abgebrochen|cancel/iu.test(message)) return withPassword ? "password_rejected" : "cancelled";
  if (/host key|identification has changed/iu.test(message)) return "host_key_changed";
  if (/no space|speicherplatz/iu.test(message)) return "disk_full";
  if (
    /timed out|unreachable|no route|could not resolve|refused|nicht erreichbar|nicht verbunden/iu.test(
      message,
    )
  )
    return "unreachable";
  if (/benutzer fehlt|user/iu.test(message) && key === "transport_connected") return "user_missing";
  switch (key) {
    case "transport_connected":
    case "package_copied":
      return "unreachable";
    case "installed":
      return "install_failed";
    case "service_started":
      return "service_failed";
    case "device_bound":
      return "bind_rejected";
    default:
      return "peer_timeout";
  }
}

interface Entry {
  steps: MachineEnrollmentStep[];
  listeners: Set<(snapshot: MachineEnrollmentSnapshot) => void>;
  current: MachineEnrollmentStepKey | null;
  cancelled: boolean;
}

export function createLegacyMachineEnrollment(deps: LegacyEnrollmentDeps): {
  readonly source: MachineEnrollmentSource;
  readonly transport: MachineInstallTransport;
} {
  const now = deps.now ?? (() => Date.now());
  const schedule =
    deps.schedule ?? ((fn: () => void, ms: number) => void globalThis.setTimeout(fn, ms));
  const pollMs = deps.onlinePollMs ?? 1_000;
  const timeoutMs = deps.onlineTimeoutMs ?? 90_000;
  const entries: Map<string, Entry> = new Map();
  let counter = 0;

  const put = (entry: Entry, step: MachineEnrollmentStep) => {
    if (entry.cancelled) return;
    if (step.state === "running") entry.current = step.key;
    entry.steps = [...entry.steps.filter((existing) => existing.key !== step.key), step];
    const snapshot: MachineEnrollmentSnapshot = { steps: [...entry.steps] };
    for (const listener of entry.listeners) listener(snapshot);
  };
  const fail = (entry: Entry, message: string, withPassword = false) => {
    const key = entry.current ?? "transport_connected";
    put(entry, {
      key,
      state: "failed",
      at_ms: now(),
      error_code: legacyErrorCode(key, message, withPassword),
      detail: message,
    });
  };
  const waitOnline = (entry: Entry, environmentId: EnvironmentId) => {
    const started = now();
    put(entry, { key: "peer_connected", state: "running", at_ms: now() });
    const check = () => {
      if (entry.cancelled) return;
      if (deps.isOnline(environmentId)) {
        put(entry, { key: "peer_connected", state: "done", at_ms: now() });
        put(entry, { key: "green", state: "done", at_ms: now() });
        return;
      }
      if (now() - started > timeoutMs) {
        fail(entry, "Rechner erscheint nicht als online.");
        return;
      }
      schedule(check, pollMs);
    };
    check();
  };

  const source: MachineEnrollmentSource = {
    begin: async () => {
      counter += 1;
      const id = `legacy-enrollment-${counter}`;
      entries.set(id, {
        steps: [{ key: "token_issued", state: "done", at_ms: now() }],
        listeners: new Set(),
        current: null,
        cancelled: false,
      });
      // Heute ohne Token: der Installationsweg ist SSH bzw. lokal.
      return { enrollment_id: id, join_token: "", installer_ref: "" };
    },
    cancel: async (id) => {
      const entry = entries.get(id);
      if (!entry) return;
      entry.cancelled = true;
      entry.listeners.clear();
      entries.delete(id);
    },
    watch: (id, onSnapshot) => {
      const entry = entries.get(id);
      if (!entry) return () => undefined;
      entry.listeners.add(onSnapshot);
      onSnapshot({ steps: [...entry.steps] });
      return () => entry.listeners.delete(onSnapshot);
    },
    reportTransportStep: async (id, step) => {
      const entry = entries.get(id);
      if (entry) put(entry, step);
    },
  };

  const transport: MachineInstallTransport = {
    listCandidates: async () => {
      const [sshHosts, peers] = await Promise.all([
        deps.listSshHosts().catch(() => []),
        deps.discoverTailscalePeers ? deps.discoverTailscalePeers().catch(() => null) : null,
      ]);
      return {
        candidates: legacyMachineCandidates({ localName: deps.localName, sshHosts, peers }),
        tailscale: peers?.status === "available",
      };
    },
    install: async ({ enrollmentId, candidate, password }) => {
      const entry = entries.get(enrollmentId);
      if (!entry) return;
      // Das Passwort beantwortet nur die ssh-Anfragen dieses Beitritts und ist
      // nach dem Lauf (Erfolg oder Fehler) aus dem Speicher.
      const release =
        password && candidate.transport !== "local"
          ? claimSshPassword(
              {
                hosts: [candidate.host, candidate.sshAlias, candidate.name].filter(
                  (value): value is string => !!value,
                ),
                user: candidate.user,
              },
              password,
            )
          : () => undefined;
      const withPassword = !!password;
      try {
        const outcome = await deps.add(
          requestForCandidate(candidate, candidate.name),
          (key, state) => put(entry, { key, state, at_ms: now() }),
        );
        if (outcome.status === "error") {
          fail(entry, outcome.message, withPassword);
          return;
        }
        for (const key of MACHINE_ENROLLMENT_STEP_KEYS.slice(0, 6)) {
          if (!entry.steps.some((step) => step.key === key && step.state === "done"))
            put(entry, { key, state: "done", at_ms: now() });
        }
        if (outcome.environmentId) waitOnline(entry, outcome.environmentId);
        else {
          put(entry, { key: "peer_connected", state: "done", at_ms: now() });
          put(entry, { key: "green", state: "done", at_ms: now() });
        }
      } catch (cause) {
        fail(entry, cause instanceof Error ? cause.message : String(cause), withPassword);
      } finally {
        release();
      }
    },
  };
  return { source, transport };
}
