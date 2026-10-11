import type { ProjectOverview } from "@workjet/contracts";

/** Editierbare Startvorschläge, nie erfundene Messwerte. */
export const projectKpiSuggestions = {
  "ctox.dev": ["Läufe", "Erfolg", "Warteschlange"],
  "greppy.xyz": ["Nutzer", "Abfragen", "Latenz"],
  "miltonticket.app": ["Spieler", "Spiele", "Punkte"],
  "mypokedex.app": ["Trainer", "Sammlungen", "Aktivität"],
  "kunstmen.com": ["Besuche", "Anfragen", "Konversion"],
  "metric-space.ai": ["Besuche", "Leads", "Konversion"],
  "fzul.app": ["Anträge", "Genehmigt", "Volumen"],
  "flylabs.dev": ["Läufe", "FPS", "Neuronen"],
  "learordie.app": ["Lernende", "Lektionen", "Abschluss"],
  "i-hate-ai.community": ["Mitglieder", "Beiträge", "Aktivität"],
  "dommify.dev": ["Besuche", "Anmeldungen", "Konversion"],
  molecularity: ["Sitzungen", "Latenz", "Fehler"],
} as const;

export function suggestedProjectKpis(title: string): ProjectOverview["slots"] | null {
  const key = title
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");
  const labels = projectKpiSuggestions[key as keyof typeof projectKpiSuggestions];
  if (!labels) return null;
  const slot = (label: string) => ({ kind: "text" as const, label, value: "—" });
  return [slot(labels[0]), slot(labels[1]), slot(labels[2])];
}
