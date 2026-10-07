import type { ProjectOverview } from "@workjet/contracts";

/** Editable starting suggestions, never fabricated measurements or analytics integrations. */
export const projectKpiSuggestions = {
  "ctox.dev": ["Runs", "Success", "Queue"],
  "greppy.xyz": ["Users", "Queries", "Latency"],
  "miltonticket.app": ["Tickets", "Resolved", "Response"],
  "mypokedex.app": ["Trainers", "Collections", "Activity"],
  "kunstmen.com": ["Visits", "Inquiries", "Conversion"],
  "metric-space.ai": ["Visits", "Leads", "Conversion"],
  "fzul.app": ["Applications", "Approved", "Volume"],
  "flylabs.dev": ["Users", "Projects", "Activity"],
  "learordie.app": ["Learners", "Lessons", "Completion"],
  "i-hate-ai.community": ["Members", "Posts", "Activity"],
  "dommify.dev": ["Visits", "Signups", "Conversion"],
  molecularity: ["Sessions", "Latency", "Errors"],
} as const;

export function suggestedProjectKpis(title: string): ProjectOverview["slots"] | null {
  const key = title.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "");
  const labels = projectKpiSuggestions[key as keyof typeof projectKpiSuggestions];
  if (!labels) return null;
  return labels.map((label) => ({ kind: "text" as const, label, value: "—" }));
}
