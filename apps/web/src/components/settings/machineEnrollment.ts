/**
 * Rechner-Beitritt mit einem Klick (ctox sync v4, Architektur §16.41).
 *
 * Schmale Adapter-Schnittstelle zwischen der Rechner-Seite und
 * (a) der Instanz: `ctox.machine.enroll.begin/cancel` plus Dokument
 *     `machine_enrollments/<id>` (ab Fr über useCtoxDoc/useCtoxCommand),
 * (b) dem Desktop-Installationsweg (lokal, SSH, Tailscale), der Paket kopiert,
 *     `ctox machine join --token` startet und die Transport-Schritte meldet.
 * Nach `green` läuft nichts mehr über SSH; Laufzeit ist CTOX Sync.
 */
// Vertragstypen §16.41. Bewusst hier statt in @workjet/contracts: die echten
// Typen liefert ctox sync v4 (Phase 11) mit useCtoxDoc/useCtoxCommand.
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
export type MachineEnrollmentTransportStepKey =
  | "transport_connected"
  | "package_copied"
  | "installed";

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

/** Ein Eintrag der Quellenliste: dieser Rechner, ein SSH-Host oder ein tailnet-Gerät. */
export interface MachineCandidate {
  readonly id: string;
  readonly transport: MachineEnrollmentTransport;
  /** Hostname bzw. Alias; wird der Name des Rechners. */
  readonly name: string;
  /** Aufgelöst aus ~/.ssh/config bzw. `ssh -G`; null = unbekannt, nie der lokale Benutzer. */
  readonly user: string | null;
  readonly host: string | null;
  readonly port: number | null;
  /** SSH-Alias, über den der Desktop verbindet (null bei lokal). */
  readonly sshAlias: string | null;
}

/** Erkannte Fähigkeiten, sobald der Rechner verbunden ist. */
export interface MachineCapabilities {
  readonly build: boolean;
  readonly storage: boolean;
  /** Kurzname der GPU, z. B. „RTX A4500 · 20 GB“; null = keine GPU. */
  readonly gpu: string | null;
}

export interface MachineEnrollmentSnapshot {
  readonly steps: ReadonlyArray<MachineEnrollmentStep>;
  readonly capabilities?: MachineCapabilities | null;
}

type Settled = Promise<void>;

/** Instanzseite (Vertrag §16.41). */
export interface MachineEnrollmentSource {
  begin(input: {
    readonly label: string;
    readonly transport: MachineEnrollmentTransport;
  }): Promise<MachineEnrollmentBeginResult>;
  cancel(enrollmentId: string): Settled;
  watch(
    enrollmentId: string,
    onSnapshot: (snapshot: MachineEnrollmentSnapshot) => void,
  ): () => void;
  reportTransportStep(enrollmentId: string, step: MachineEnrollmentStep): Promise<void>;
}

export interface MachineSources {
  readonly candidates: ReadonlyArray<MachineCandidate>;
  /** false = Tailscale nicht installiert oder nicht angemeldet. */
  readonly tailscale: boolean;
}

/** Desktopseite: Quellen auflösen und den Installationsweg fahren. */
export interface MachineInstallTransport {
  listCandidates(): Promise<MachineSources>;
  install(
    input: {
      readonly enrollmentId: string;
      readonly candidate: MachineCandidate;
      readonly joinToken: string;
      readonly installerRef: string;
      /**
       * Einmal-Passwort: nur für die erste Anmeldung (Schlüssel eintragen),
       * nie gespeichert, nie geloggt, nie in Details.
       */
      readonly password?: string;
    },
    onStep: (step: MachineEnrollmentStep & { key: MachineEnrollmentTransportStepKey }) => void,
  ): Promise<void>;
}

/** Ein Klick: begin → Desktop-Transport, der seine Schritte ins Dokument meldet. */
export async function startMachineEnrollment(
  source: MachineEnrollmentSource,
  transport: MachineInstallTransport,
  candidate: MachineCandidate,
  label: string,
  password?: string,
): Promise<string> {
  const begun = await source.begin({ label, transport: candidate.transport });
  void transport
    .install(
      {
        enrollmentId: begun.enrollment_id,
        candidate,
        joinToken: begun.join_token,
        installerRef: begun.installer_ref,
        ...(password ? { password } : {}),
      },
      (step) => void source.reportTransportStep(begun.enrollment_id, step),
    )
    .catch((cause: unknown) => {
      void source.reportTransportStep(begun.enrollment_id, {
        key: "transport_connected",
        state: "failed",
        at_ms: Date.now(),
        error_code: "transport_failed",
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    });
  return begun.enrollment_id;
}

export type MachineEnrollmentLanguage = "de" | "en";

const STEP_LABELS: Record<MachineEnrollmentLanguage, Record<MachineEnrollmentStepKey, string>> = {
  de: {
    token_issued: "Vorbereiten",
    transport_connected: "Verbinden",
    package_copied: "Kopieren",
    installed: "Installieren",
    service_started: "Starten",
    device_bound: "Koppeln",
    peer_connected: "Synchronisieren",
    green: "Verbunden",
  },
  en: {
    token_issued: "Preparing",
    transport_connected: "Connecting",
    package_copied: "Copying",
    installed: "Installing",
    service_started: "Starting",
    device_bound: "Pairing",
    peer_connected: "Syncing",
    green: "Connected",
  },
};

export type MachineEnrollmentErrorAction = "retry" | "user" | "password" | "details";

interface ErrorEntry {
  readonly text: Record<MachineEnrollmentLanguage, string>;
  readonly action: MachineEnrollmentErrorAction;
}

const ERRORS: Record<string, ErrorEntry> = {
  auth_rejected: {
    text: { de: "Anmeldung abgelehnt", en: "Sign-in rejected" },
    action: "user",
  },
  user_missing: { text: { de: "Benutzer fehlt", en: "User missing" }, action: "user" },
  password_rejected: {
    text: { de: "Passwort falsch", en: "Wrong password" },
    action: "password",
  },
  unreachable: {
    text: { de: "Rechner nicht erreichbar", en: "Computer unreachable" },
    action: "retry",
  },
  host_key_changed: {
    text: { de: "Host-Schlüssel geändert", en: "Host key changed" },
    action: "details",
  },
  copy_failed: { text: { de: "Kopieren fehlgeschlagen", en: "Copy failed" }, action: "retry" },
  install_failed: {
    text: { de: "Installation fehlgeschlagen", en: "Installation failed" },
    action: "retry",
  },
  disk_full: {
    text: { de: "Zu wenig Speicherplatz", en: "Not enough disk space" },
    action: "retry",
  },
  token_expired: { text: { de: "Freigabe abgelaufen", en: "Join token expired" }, action: "retry" },
  service_failed: {
    text: { de: "Dienst startet nicht", en: "Service does not start" },
    action: "retry",
  },
  bind_rejected: { text: { de: "Kopplung abgelehnt", en: "Pairing rejected" }, action: "retry" },
  peer_timeout: {
    text: { de: "Keine Sync-Verbindung", en: "No sync connection" },
    action: "retry",
  },
  cancelled: { text: { de: "Abgebrochen", en: "Cancelled" }, action: "retry" },
};

const FALLBACK_ERROR: ErrorEntry = {
  text: { de: "Einrichtung fehlgeschlagen", en: "Setup failed" },
  action: "retry",
};

export function machineEnrollmentLabels(language: MachineEnrollmentLanguage = "de") {
  return language === "en"
    ? {
        add: "Add computer",
        addSubmit: "Add",
        cancel: "Cancel",
        retry: "Retry",
        connect: "Connect",
        changePassword: "Change password",
        known: "Added",
        tailscaleSignIn: "Sign in to Tailscale",
        password: "Password",
        address: "Address",
        manual: "Manual",
        tailscaleSignedOut: "Tailscale not signed in",
        open: "Open",
        checkUser: "Check user",
        enterUser: "Enter user",
        user: "User",
        details: "Details",
        thisComputer: "This computer",
        rename: "Rename",
        reload: "Reload",
        abort: "Abort",
        remove: "Remove",
        capabilities: { build: "Build", storage: "Storage", gpu: "GPU" },
        transports: { local: "Local", ssh: "SSH", tailscale: "Tailscale" },
        sourcesEmpty: "No computers found",
      }
    : {
        add: "Rechner hinzufügen",
        addSubmit: "Hinzufügen",
        cancel: "Abbrechen",
        retry: "Erneut versuchen",
        connect: "Verbinden",
        changePassword: "Passwort ändern",
        known: "Vorhanden",
        tailscaleSignIn: "Bei Tailscale anmelden",
        password: "Passwort",
        address: "Adresse",
        manual: "Manuell",
        tailscaleSignedOut: "Tailscale nicht angemeldet",
        open: "Öffnen",
        checkUser: "Benutzer prüfen",
        enterUser: "Benutzer eintragen",
        user: "Benutzer",
        details: "Details",
        thisComputer: "Dieser Rechner",
        rename: "Umbenennen",
        reload: "Neu laden",
        abort: "Abbrechen",
        remove: "Entfernen",
        capabilities: { build: "Build", storage: "Speicher", gpu: "GPU" },
        transports: { local: "Lokal", ssh: "SSH", tailscale: "Tailscale" },
        sourcesEmpty: "Keine Rechner gefunden",
      };
}

export function machineEnrollmentStepLabel(
  key: MachineEnrollmentStepKey,
  language: MachineEnrollmentLanguage = "de",
): string {
  return STEP_LABELS[language][key];
}

/** Eine Zeile ≤ 12 Wörter mit genau einer Aktion; Rohtext bleibt hinter „Details“. */
export function machineEnrollmentError(
  errorCode: string | undefined,
  language: MachineEnrollmentLanguage = "de",
): {
  readonly text: string;
  readonly action: MachineEnrollmentErrorAction;
  readonly actionLabel: string;
} {
  const entry = (errorCode ? ERRORS[errorCode] : undefined) ?? FALLBACK_ERROR;
  const labels = machineEnrollmentLabels(language);
  return {
    text: entry.text[language],
    action: entry.action,
    actionLabel:
      entry.action === "user"
        ? labels.checkUser
        : entry.action === "password"
          ? labels.changePassword
          : entry.action === "details"
            ? labels.details
            : labels.retry,
  };
}

export interface MachineEnrollmentProgress {
  /** Index des aktuellen Schritts (0–7). */
  readonly index: number;
  readonly key: MachineEnrollmentStepKey;
  /** Anteil erledigter Schritte, 0–1. */
  readonly fraction: number;
  readonly phase: "running" | "failed" | "green";
  readonly fault: MachineEnrollmentStep | null;
}

/**
 * Leitet den Balken aus `steps` ab. Spätere Meldungen eines Schlüssels
 * überschreiben frühere; fehlende Schlüssel gelten als pending.
 */
export function machineEnrollmentProgress(
  steps: ReadonlyArray<MachineEnrollmentStep>,
): MachineEnrollmentProgress {
  const latest = new Map<MachineEnrollmentStepKey, MachineEnrollmentStep>();
  for (const step of steps) {
    const known = latest.get(step.key);
    if (!known || step.at_ms >= known.at_ms) latest.set(step.key, step);
  }
  const total = MACHINE_ENROLLMENT_STEP_KEYS.length;
  const failedKey = MACHINE_ENROLLMENT_STEP_KEYS.find((key) => latest.get(key)?.state === "failed");
  if (failedKey) {
    const index = MACHINE_ENROLLMENT_STEP_KEYS.indexOf(failedKey);
    return {
      index,
      key: failedKey,
      fraction: index / total,
      phase: "failed",
      fault: latest.get(failedKey) ?? null,
    };
  }
  if (latest.get("green")?.state === "done") {
    return { index: total - 1, key: "green", fraction: 1, phase: "green", fault: null };
  }
  let done = 0;
  for (const key of MACHINE_ENROLLMENT_STEP_KEYS) {
    if (latest.get(key)?.state !== "done") break;
    done += 1;
  }
  const index = Math.min(done, total - 1);
  const running = latest.get(MACHINE_ENROLLMENT_STEP_KEYS[index]!)?.state === "running";
  return {
    index,
    key: MACHINE_ENROLLMENT_STEP_KEYS[index]!,
    // Ein laufender Schritt zählt halb, damit der Balken sichtbar wandert.
    fraction: (done + (running ? 0.5 : 0)) / total,
    phase: "running",
    fault: null,
  };
}

/** Meta-Zeile eines Eintrags: `benutzer@host:port`, fehlende Werte als „—“. */
export function machineCandidateAddress(candidate: MachineCandidate): string | null {
  if (candidate.transport === "local") return null;
  const host = candidate.host ?? candidate.name;
  const port = candidate.port && candidate.port !== 22 ? `:${candidate.port}` : "";
  return candidate.user ? `${candidate.user}@${host}${port}` : `${host}${port}`;
}

/** „Adresse“ der Zeile „Manuell“: IP oder Hostname, optional :Port. */
export function parseManualAddress(
  value: string,
): { readonly host: string; readonly port: number | null } | null {
  const trimmed = value.trim();
  if (!trimmed || /\s/u.test(trimmed)) return null;
  const match = /^(?:\[([^\]]+)\]|([^:]+))(?::(\d{1,5}))?$/u.exec(trimmed);
  if (!match) return null;
  const host = match[1] ?? match[2] ?? "";
  const port = match[3] ? Number.parseInt(match[3], 10) : null;
  if (!host || (port !== null && (port < 1 || port > 65535))) return null;
  return { host, port };
}
