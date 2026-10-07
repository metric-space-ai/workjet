/** Presentation-only fields from CTOX's workjet-project-kpis-v1 contract (#368).
 * The native service validates source evidence and computes display_value.
 */
export type ProjectKpiRecord = {
  readonly prompt: { readonly kpi_id: string; readonly prompt: string; readonly revision: number };
  readonly result: {
    readonly status: "resolving" | "ready" | "stale" | "missing_source" | "failed";
    readonly reason_code?: string;
    readonly message?: string;
    readonly snapshot?: {
      readonly project_id: string;
      readonly kpi_id: string;
      readonly prompt_revision: number;
      readonly label: string;
      readonly display_value: string;
      readonly unit: string;
      readonly sources: readonly {
        readonly kind: "native_metric" | "github_metric" | "connected_metric";
        readonly project_id: string;
        readonly connection_id: string;
        readonly metric_key: string;
      }[];
      readonly freshness: {
        readonly calculated_at_ms: number;
        readonly refresh_at_ms: number;
        readonly fresh_until_ms: number;
      };
    };
  };
};
export type PromptedProjectKpis = {
  readonly project_id: string;
  readonly revision: number;
  readonly items: readonly ProjectKpiRecord[];
};
export type ProjectKpiPromptInput = { readonly kpi_id: string; readonly prompt: string };
export type SaveProjectKpiPrompts = (
  prompts: readonly ProjectKpiPromptInput[],
  expectedRevision: number,
) => Promise<boolean>;

/** An edited sentence or an out-of-scope/old result must never reuse its old value. */
export function projectKpiPresentation(
  record: ProjectKpiRecord | undefined,
  projectId: string,
  position: number,
  draftPrompt: string | undefined = record?.prompt.prompt,
) {
  const fallback = {
    label: `KPI ${position}`,
    value: "—",
    source: "",
    calculatedAt: null as number | null,
  };
  if (!record) return { ...fallback, status: "unconfigured", detail: "Not configured" };
  if (draftPrompt?.trim() !== record.prompt.prompt.trim())
    return { ...fallback, status: "changed", detail: "Recalculated after saving" };
  const result = record.result;
  if (result.status !== "ready" && result.status !== "stale")
    return {
      ...fallback,
      status: result.status,
      detail: result.reason_code ?? (result.status === "resolving" ? "Resolving" : result.status),
      message: result.message,
    };
  const snapshot = result.snapshot;
  if (
    !snapshot ||
    snapshot.project_id !== projectId ||
    snapshot.kpi_id !== record.prompt.kpi_id ||
    snapshot.prompt_revision !== record.prompt.revision ||
    !snapshot.sources.length ||
    snapshot.sources.some((source) => source.project_id !== projectId) ||
    !Number.isFinite(snapshot.freshness.calculated_at_ms) ||
    Math.abs(snapshot.freshness.calculated_at_ms) > 8.64e15
  )
    return { ...fallback, status: "failed", detail: "invalid_snapshot" };
  const names = {
    native_metric: "CTOX",
    github_metric: "GitHub",
    connected_metric: "Connected source",
  };
  return {
    label: snapshot.label,
    value: snapshot.display_value,
    source: [...new Set(snapshot.sources.map((source) => names[source.kind]))].join(" + "),
    calculatedAt: snapshot.freshness.calculated_at_ms,
    status: result.status,
    detail: result.status === "stale" ? (result.reason_code ?? "stale") : "",
    message: result.message,
  };
}

/** Preserve stable native IDs while clearing empty sentences; new IDs cannot collide. */
export function projectKpiPromptInputs(
  prompts: readonly string[],
  kpis: PromptedProjectKpis,
): readonly ProjectKpiPromptInput[] {
  const used = new Set(kpis.items.map((item) => item.prompt.kpi_id));
  return prompts.slice(0, 3).flatMap((sentence, index) => {
    const prompt = sentence.trim();
    if (!prompt) return [];
    let kpi_id = kpis.items[index]?.prompt.kpi_id;
    if (!kpi_id) {
      const base = `kpi-${index + 1}`;
      kpi_id = base;
      for (let suffix = 2; used.has(kpi_id); suffix++) kpi_id = `${base}-${suffix}`;
      used.add(kpi_id);
    }
    return [{ kpi_id, prompt }];
  });
}
