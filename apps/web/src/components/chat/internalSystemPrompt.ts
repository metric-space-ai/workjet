/**
 * Interne Systemaufträge (z. B. der automatische Wochenbericht aus dem CTOX-Zeitplan)
 * landen technisch als Nutzer-Nachricht im Supervisor-Thread. Im Verlauf zeigen wir
 * sie nicht als Nutzertext, sondern als kurze, lokalisierte Systemzeile.
 */
const INTERNAL_PROMPTS: ReadonlyArray<{
  readonly prefix: string;
  readonly de: string;
  readonly en: string;
}> = [
  {
    prefix: "Write this project's weekly report in this supervisor chat",
    de: "Wochenbericht automatisch angefordert",
    en: "Weekly report requested automatically",
  },
];

function uiLanguage(): "de" | "en" {
  return typeof document !== "undefined" &&
    document.documentElement?.lang?.startsWith("en") === true
    ? "en"
    : "de";
}

export function internalSystemPromptLabel(
  text: string | null | undefined,
  language?: "de" | "en",
): string | null {
  const trimmed = (text ?? "").trimStart();
  const match = INTERNAL_PROMPTS.find((entry) => trimmed.startsWith(entry.prefix));
  return match ? match[language ?? uiLanguage()] : null;
}
