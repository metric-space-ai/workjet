/**
 * D02: Die Desktop-App meldet englische Rohtexte. Bekannte Texte werden hier
 * auf kurze deutsche Zeilen (≤ 12 Wörter) abgebildet; der Rohtext bleibt nur
 * hinter „Details“.
 */
const PROVISIONING_MESSAGES_DE: ReadonlyArray<readonly [RegExp, string]> = [
  [/^Operation queued/i, "In der Warteschlange"],
  [/^Requested components are ready/i, "Komponenten bereit"],
  [/^Verified the approved target/i, "Ziel und Release-Kanal geprüft"],
  [/^Requesting target authorization/i, "Rechte auf dem Rechner anfragen"],
  [/^Creating a local-only Business OS pairing invite/i, "Kopplung wird vorbereitet"],
  [/^CTOX \w+ completed/i, "CTOX fertig"],
  [/^Confirm the current SSH host-key fingerprint/i, "Host-Schlüssel bestätigen"],
  [/^The SSH host key changed/i, "Host-Schlüssel hat sich geändert"],
  [/^The target did not publish an SSH host key/i, "Rechner liefert keinen Host-Schlüssel"],
  [/^The SSH host key response was invalid/i, "Host-Schlüssel ungültig"],
  [/^The SSH fingerprint could not be calculated/i, "Host-Schlüssel nicht prüfbar"],
  [/^The target operating system is not supported/i, "Betriebssystem wird nicht unterstützt"],
  [/^The target architecture is not supported/i, "Prozessor wird nicht unterstützt"],
  [/^The target is missing required provisioning tools/i, "Auf dem Rechner fehlen Werkzeuge"],
  [
    /^The target cannot reach the official CTOX release channel/i,
    "Rechner erreicht den CTOX-Release-Kanal nicht",
  ],
  [/administrator/i, "Administratorrechte nötig"],
  [/^Windows will show a User Account Control/i, "Windows fragt gleich nach Administratorrechten"],
  [/^No active graphical session/i, "Ohne Desktop: nur CTOX installierbar"],
  [/^Workjet is unavailable on a headless target/i, "Ohne Desktop: nur CTOX installierbar"],
  [
    /^Workjet cannot be installed without an active graphical session/i,
    "Ohne Desktop: nur CTOX installierbar",
  ],
  [/^Run the target preflight again/i, "Prüfung abgelaufen"],
  [
    /installation journal|Saved installations could not be read/i,
    "Gespeicherte Installation nicht lesbar",
  ],
  [/^Target preflight failed/i, "Prüfung fehlgeschlagen"],
  [/^Provisioning failed/i, "Einrichtung fehlgeschlagen"],
  [/^Approved SSH (target|host key) is missing/i, "Bestätigung fehlt, neu prüfen"],
  [/password|permission denied|authentication/i, "Anmeldung abgelehnt"],
  [/timed? ?out|timeout/i, "Zeitüberschreitung"],
  [/unreachable|no route|could not resolve|connection refused/i, "Rechner nicht erreichbar"],
];

export const PROVISIONING_PHASES_DE: Readonly<Record<string, string>> = {
  queued: "In der Warteschlange",
  preflight: "Prüfung",
  authorization: "Rechte anfragen",
  download: "Download",
  verification: "Überprüfung",
  installation: "Installation",
  service: "Dienst starten",
  health: "Zustand prüfen",
  pairing: "Kopplung",
  replication: "Abgleich",
  complete: "Fertig",
  failed: "Fehlgeschlagen",
};

/** Deutscher Text zu einer Desktop-Meldung; `raw` nur, wenn er abweicht (für „Details“). */
export function provisioningMessageDe(
  message: string,
  fallback = "Einrichtung fehlgeschlagen",
): { readonly text: string; readonly raw: string | null } {
  const trimmed = message.trim();
  // Schon deutsch (Umlaute oder bekannte Wörter): unverändert.
  if (trimmed !== "" && /[äöüß]|^(Prüf|Rechner|Einricht|Anmeld|Kein|Nicht)/i.test(trimmed))
    return { text: trimmed, raw: null };
  const match = PROVISIONING_MESSAGES_DE.find(([pattern]) => pattern.test(trimmed));
  const text = match ? match[1] : fallback;
  return { text, raw: trimmed !== "" && trimmed !== text ? trimmed : null };
}
