import { workjetUiLanguage } from "./workjetProjectControl";

/**
 * The server names the project supervisor thread "Project supervisor" (data,
 * not UI text). Show it in the UI language instead of English in a German UI.
 */
const KNOWN_TITLES: Readonly<Record<string, { readonly de: string; readonly en: string }>> = {
  "project supervisor": { de: "Projekt-Supervisor", en: "Project supervisor" },
};

export function localizedThreadTitle(
  title: string,
  language: "de" | "en" = workjetUiLanguage(),
): string {
  const known = KNOWN_TITLES[title.trim().toLowerCase()];
  return known ? known[language] : title;
}
