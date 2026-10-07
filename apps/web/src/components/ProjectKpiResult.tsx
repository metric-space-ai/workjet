import { projectKpiPresentation, type ProjectKpiRecord } from "../projectKpis";

export function ProjectKpiResult({
  record,
  projectId,
  position,
  draftPrompt,
}: {
  readonly record: ProjectKpiRecord | undefined;
  readonly projectId: string;
  readonly position: number;
  readonly draftPrompt: string;
}) {
  const result = projectKpiPresentation(record, projectId, position, draftPrompt);
  const calculatedAt = result.calculatedAt === null ? null : new Date(result.calculatedAt);
  return (
    <div
      role="status"
      className="min-w-0 break-words text-xs leading-5 [overflow-wrap:anywhere]"
      title={result.message ?? result.detail}
      data-workjet-kpi-result={result.status}
    >
      {calculatedAt ? (
        <>
          <strong className="font-semibold text-foreground">{result.value}</strong>
          <span className="text-muted-foreground"> · {result.source} · </span>
          <time className="text-muted-foreground" dateTime={calculatedAt.toISOString()}>
            {calculatedAt.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          </time>
          {result.status === "stale" && <span className="text-amber-500"> · {result.detail}</span>}
        </>
      ) : (
        <span
          className={
            result.status === "failed" || result.status === "missing_source"
              ? "text-destructive"
              : "text-muted-foreground"
          }
        >
          {result.detail}
        </span>
      )}
    </div>
  );
}
