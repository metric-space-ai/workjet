/** Cap for the per-thread "recently seen" URL list shown in the empty state. */
export const PREVIEW_RECENT_URL_LIMIT = 10;

/**
 * Common Chromium error codes mapped to a short human label. Used by the
 * unreachable view to drop the raw `ERR_*` code in favour of friendlier copy.
 */
export const PREVIEW_ERROR_CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ERR_NAME_NOT_RESOLVED: "DNS-Adresse nicht gefunden",
  ERR_NAME_RESOLUTION_FAILED: "DNS-Adresse nicht gefunden",
  ERR_CONNECTION_REFUSED: "Verbindung abgelehnt",
  ERR_CONNECTION_RESET: "Verbindung zurückgesetzt",
  ERR_CONNECTION_CLOSED: "Verbindung geschlossen",
  ERR_CONNECTION_TIMED_OUT: "Zeitüberschreitung der Verbindung",
  ERR_INTERNET_DISCONNECTED: "Keine Internetverbindung",
  ERR_TIMED_OUT: "Zeitüberschreitung der Verbindung",
  ERR_CERT_AUTHORITY_INVALID: "Zertifizierungsstelle nicht vertrauenswürdig",
  ERR_CERT_COMMON_NAME_INVALID: "Zertifikat passt nicht zum Host",
  ERR_CERT_DATE_INVALID: "Zertifikat abgelaufen oder noch nicht gültig",
  ERR_TOO_MANY_REDIRECTS: "Zu viele Weiterleitungen",
});
