/**
 * Fehler im Chat-Composer (UI-Vertrag §2): nie Rohtext, höchstens eine deutsche
 * Zeile mit genau einer Aktion. Der Rohtext wird nie angezeigt.
 *
 * - Abgelaufener Instanz-Zugang (401): „Anmeldung der Instanz abgelaufen · Neu verbinden“.
 * - Nicht erreichbar (503, Zeitüberschreitung, Netz): still alle 15 s wiederholen,
 *   erst nach 2 min „Instanz nicht erreichbar · Erneut versuchen“.
 * - Alles andere: die deutsche Zeile des Aufrufers · Erneut versuchen.
 */

export const COMPOSER_SILENT_RETRY_MS = 15_000;
export const COMPOSER_UNREACHABLE_NOTICE_MS = 120_000;

export type ComposerErrorKind = "authentication" | "unreachable" | "failed";

export interface ComposerErrorLine {
  readonly kind: ComposerErrorKind;
  /** Deutsche Kurzzeile, höchstens 12 Wörter. */
  readonly text: string;
  /** Genau eine Aktion. */
  readonly action: "reconnect" | "retry";
  readonly actionLabel: string;
  /** Rohtext, nur für Diagnose und Logs; nie im Chat sichtbar. */
  readonly details: string | null;
}

export const COMPOSER_AUTHENTICATION_LINE = "Anmeldung der Instanz abgelaufen";
export const COMPOSER_UNREACHABLE_LINE = "Instanz nicht erreichbar";
export const COMPOSER_RECONNECT_LABEL = "Neu verbinden";
export const COMPOSER_RETRY_LABEL = "Erneut versuchen";

const AUTHENTICATION_PATTERN =
  /\b401\b|unauthori[sz]ed|authentication[-_ ]required|needs[-_ ]auth|signed[-_ ]out|sign in to|token (?:has )?expired|session expired|\bexpired\b|abgelaufen|anmelden|anmeldung erforderlich/i;

const UNREACHABLE_PATTERN =
  /\b50[0234]\b|\b408\b|\b429\b|service unavailable|bad gateway|gateway timeout|failed to connect|connection[-_ ](?:unavailable|refused|reset|failed|lost|closed)|reconnecting|\bunavailable\b|not reachable|unreachable|timed? ?out|timeout|network|socket hang up|fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|EAI_AGAIN|offline|nicht erreichbar|nicht rechtzeitig|zu lange gedauert|gestört|noch nicht bereit|wird noch aufgebaut|verbindung nicht (?:verfügbar|bereit)/i;

/** Englische Füllwörter, Fehlerklassen, Status-Codes, Pfade: alles Rohtext. */
const RAW_TEXT_PATTERN =
  /\b(?:the|to|is|are|has|have|was|did|does|not|could|cannot|can't|failed|error|request|response|please|choose|this|selection|instance|connection|reason|reconnecting|configuration|again)\b|\b[A-Z][A-Za-z]+(?:Error|Exception)\b|\b\d{3}\b|https?:\/\/|file:\/\/|[{}[\]]|[0-9a-f]{8}-[0-9a-f]{4}-/i;

const MAX_LINE_WORDS = 12;

/** Der Rohtext eines beliebigen Fehlerwerts, ohne Leerraum am Rand. */
export function composerRawErrorText(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  const text =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : typeof error === "object" && "message" in error && typeof error.message === "string"
          ? error.message
          : typeof error === "object" && "code" in error && typeof error.code === "string"
            ? error.code
            : String(error);
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

export function classifyComposerError(error: unknown): ComposerErrorKind {
  const raw = composerRawErrorText(error) ?? "";
  if (AUTHENTICATION_PATTERN.test(raw)) return "authentication";
  if (UNREACHABLE_PATTERN.test(raw)) return "unreachable";
  return "failed";
}

/** Eine eigene, schon deutsche Kurzzeile darf stehen bleiben; sonst gilt die Zeile des Aufrufers. */
export function isComposerPlainLine(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= MAX_LINE_WORDS && !RAW_TEXT_PATTERN.test(text);
}

function stripSentenceEnd(text: string): string {
  return text.trim().replace(/[.!]+$/, "");
}

/**
 * Bildet einen Fehler auf genau eine Zeile ab.
 *
 * `null` heißt: still bleiben. Das gilt für Nichterreichbarkeit, solange sie
 * kürzer als 2 min besteht (`unreachableForMs`); der Aufrufer wiederholt still.
 */
export function composerErrorLine(
  error: unknown,
  options: {
    /** Deutsche Zeile für alles, was weder Anmeldung noch Erreichbarkeit ist. */
    readonly fallback: string;
    /** Wie lange die Instanz schon nicht erreichbar ist; `null` = unbekannt/gerade erst. */
    readonly unreachableForMs?: number | null;
  },
): ComposerErrorLine | null {
  const raw = composerRawErrorText(error);
  if (raw === null) return null;
  const kind = classifyComposerError(raw);
  if (kind === "authentication") {
    return {
      kind,
      text: COMPOSER_AUTHENTICATION_LINE,
      action: "reconnect",
      actionLabel: COMPOSER_RECONNECT_LABEL,
      details: raw === COMPOSER_AUTHENTICATION_LINE ? null : raw,
    };
  }
  if (kind === "unreachable") {
    if ((options.unreachableForMs ?? 0) < COMPOSER_UNREACHABLE_NOTICE_MS) return null;
    return {
      kind,
      text: COMPOSER_UNREACHABLE_LINE,
      action: "retry",
      actionLabel: COMPOSER_RETRY_LABEL,
      details: raw === COMPOSER_UNREACHABLE_LINE ? null : raw,
    };
  }
  const plain = isComposerPlainLine(raw);
  return {
    kind,
    text: plain ? stripSentenceEnd(raw) : options.fallback,
    action: "retry",
    actionLabel: COMPOSER_RETRY_LABEL,
    details: plain ? null : raw,
  };
}

/**
 * Toasts haben keinen Aufklapper (UI-Vertrag §1): Rohtext entfällt ganz. Übrig
 * bleibt höchstens eine deutsche Kurzzeile als Beschreibung.
 */
export function composerToastDescription(error: unknown): string | undefined {
  const raw = composerRawErrorText(error);
  if (raw === null) return undefined;
  const kind = classifyComposerError(raw);
  if (kind === "authentication") return COMPOSER_AUTHENTICATION_LINE;
  if (kind === "unreachable") return COMPOSER_UNREACHABLE_LINE;
  return isComposerPlainLine(raw) ? stripSentenceEnd(raw) : undefined;
}
