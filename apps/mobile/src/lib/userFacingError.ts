/**
 * The single UI boundary for errors in Workjet Mobile.
 *
 * Internal validation and protocol errors (invite parsing, shell pack, DPoP,
 * session store, transport, ...) keep their precise English messages for
 * diagnostics and tests. Whatever reaches the screen is one fixed German line
 * (at most twelve words) plus exactly one action. The raw error text is never
 * shown; it goes to the diagnostic log only.
 */

export type UserFacingErrorKind =
  | "pairing"
  | "auth"
  | "unreachable"
  | "package"
  | "permission"
  | "storage"
  | "task-required"
  | "branch-required"
  | "name-required"
  | "path-required"
  | "unexpected";

export interface UserFacingError {
  readonly kind: UserFacingErrorKind;
  /** Fixed German line, at most twelve words. */
  readonly line: string;
  /** Exactly one action the user can take next. */
  readonly action: string;
  /** `line · action`, the form rendered in banners, alerts and status rows. */
  readonly text: string;
}

const LINES: Readonly<Record<UserFacingErrorKind, { line: string; action: string }>> = {
  pairing: { line: "Kopplungscode ungültig", action: "Neu scannen" },
  auth: { line: "Anmeldung abgelaufen", action: "Neu verbinden" },
  unreachable: { line: "Instanz nicht erreichbar", action: "Erneut" },
  package: { line: "App-Paket fehlerhaft", action: "Workjet aktualisieren" },
  permission: { line: "Zugriff nicht erlaubt", action: "Einstellungen öffnen" },
  storage: { line: "Speichern auf dem Gerät fehlgeschlagen", action: "Erneut" },
  "task-required": { line: "Aufgabe fehlt", action: "Text eingeben" },
  "branch-required": { line: "Basiszweig fehlt", action: "Zweig wählen" },
  "name-required": { line: "Projektname fehlt", action: "Namen eingeben" },
  "path-required": { line: "Projektpfad fehlt", action: "Pfad eingeben" },
  unexpected: { line: "Unerwarteter Fehler", action: "Erneut" },
};

const KIND_BY_ERROR_NAME: Readonly<Record<string, UserFacingErrorKind>> = {
  PairingQrPayloadEmptyError: "pairing",
  WorkjetDeviceInviteValidationError: "pairing",
  BusinessOsInviteValidationError: "pairing",
  CloudDpopError: "auth",
  WorkjetDeviceSessionStoreError: "auth",
  ManagedRelayTokenStoreError: "auth",
  WorkjetDeviceInviteControlUnavailableError: "unreachable",
  BusinessOsInviteControlUnavailableError: "unreachable",
  BusinessOsRegistryError: "unreachable",
  CloudEnvironmentLinkError: "unreachable",
  CloudPublicConfigMissingError: "package",
  BusinessOsShellPackError: "package",
  BusinessOsShellDistributionError: "package",
  NotificationPermissionReadError: "permission",
  NotificationPermissionRequestError: "permission",
  MobileStorageDecodeError: "storage",
  MobileStorageEncodeError: "storage",
  MobileSecureStorageError: "storage",
  MobileDatabaseError: "storage",
  MobilePreferencesLoadError: "storage",
  MobilePreferencesSaveError: "storage",
  ThreadOutboxStorageError: "storage",
  ComposerDraftPersistenceError: "storage",
  IncomingShareStorageError: "storage",
  ProjectThreadTaskRequiredError: "task-required",
  ProjectThreadBaseBranchRequiredError: "branch-required",
};

// Ordered: the first matching pattern wins. Applied to the raw text only to
// pick a category; the raw text itself never leaves this module.
const KIND_BY_TEXT: ReadonlyArray<readonly [RegExp, UserFacingErrorKind]> = [
  [/\benter a project name\b/iu, "name-required"],
  [/\benter a project path\b/iu, "path-required"],
  [/\b(?:pairing|invite|qr)\b|qr-code|kopplung|einladung/iu, "pairing"],
  [
    /\b(?:401|403|unauthori[sz]ed|forbidden|dpop|expired|(?:access|refresh|bearer|session) token|credentials?|sign[- ]?in|session)\b|abgelaufen|anmeld/iu,
    "auth",
  ],
  [/shell pack|shell descriptor|signature|bundle|app-paket/iu, "package"],
  [/\b(?:permission|denied|not allowed)\b|berechtigung|zugriff/iu, "permission"],
  [
    /\b(?:network|fetch|timeout|timed out|unreachable|offline|econn\w*|socket|websocket|transport|disconnect\w*|connection|relay|5\d\d)\b|erreichbar|verbindung|getrennt/iu,
    "unreachable",
  ],
  [/\b(?:storage|database|sqlite|persist\w*|disk)\b|speicher/iu, "storage"],
];

function errorName(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const record = error as { readonly _tag?: unknown; readonly name?: unknown };
  if (typeof record._tag === "string" && record._tag in KIND_BY_ERROR_NAME) return record._tag;
  if (typeof record.name === "string" && record.name in KIND_BY_ERROR_NAME) return record.name;
  return null;
}

function rawText(error: unknown, depth = 0): string {
  if (depth > 3 || error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (typeof error !== "object") return String(error);
  const record = error as {
    readonly message?: unknown;
    readonly detail?: unknown;
    readonly cause?: unknown;
    readonly _tag?: unknown;
    readonly name?: unknown;
  };
  const parts: string[] = [];
  for (const value of [record._tag, record.name, record.message, record.detail]) {
    if (typeof value === "string" && value.length > 0) parts.push(value);
  }
  const nested = rawText(record.cause, depth + 1);
  if (nested.length > 0) parts.push(nested);
  return parts.join(" | ");
}

// A line that already passed this boundary maps to itself, so a render site
// may map a value that a state hook mapped before.
const KIND_BY_FIXED_TEXT: ReadonlyMap<string, UserFacingErrorKind> = new Map(
  (Object.keys(LINES) as UserFacingErrorKind[]).map((kind) => [
    `${LINES[kind].line} · ${LINES[kind].action}`,
    kind,
  ]),
);

function classify(error: unknown, depth = 0): UserFacingErrorKind {
  if (typeof error === "string") {
    const fixed = KIND_BY_FIXED_TEXT.get(error);
    if (fixed !== undefined) return fixed;
  }
  const named = errorName(error);
  if (named !== null) return KIND_BY_ERROR_NAME[named] ?? "unexpected";
  if (depth < 3 && typeof error === "object" && error !== null && "cause" in error) {
    const nested = classify((error as { readonly cause?: unknown }).cause, depth + 1);
    if (nested !== "unexpected") return nested;
  }
  const text = rawText(error);
  for (const [pattern, kind] of KIND_BY_TEXT) {
    if (pattern.test(text)) return kind;
  }
  return "unexpected";
}

const loggedErrors = new WeakSet<object>();
let lastLoggedText: string | null = null;

function logDiagnostic(scope: string, error: unknown, kind: UserFacingErrorKind): void {
  if (typeof error === "object" && error !== null) {
    if (loggedErrors.has(error)) return;
    loggedErrors.add(error);
  } else {
    const key = `${scope}\u0000${String(error)}`;
    if (key === lastLoggedText) return;
    lastLoggedText = key;
  }
  console.warn(`[user-facing-error] ${scope}`, { kind, error });
}

/** The fixed German line for a known category, without logging. */
export function userFacingErrorOfKind(kind: UserFacingErrorKind): UserFacingError {
  const { line, action } = LINES[kind];
  return { kind, line, action, text: `${line} · ${action}` };
}

/**
 * Maps any error that is about to reach the UI to a fixed German line plus one
 * action and logs the raw error to the diagnostic log. `scope` names the call
 * site in the log only.
 */
export function userFacingError(error: unknown, scope = "ui"): UserFacingError {
  const kind = classify(error);
  if (!(typeof error === "string" && KIND_BY_FIXED_TEXT.has(error))) {
    logDiagnostic(scope, error, kind);
  }
  return userFacingErrorOfKind(kind);
}

/** Shorthand for the rendered `line · action` text. */
export function userFacingErrorText(error: unknown, scope = "ui"): string {
  return userFacingError(error, scope).text;
}
