import { projectKpiPresentation, type ProjectKpiRecord } from "../projectKpis";
import { workjetUiLanguage } from "../workjetProjectControl";

/** UI language, not the browser locale; 24-hour clock in de and en (European default). */
export function formatKpiTime(value: Date, language: "de" | "en" = workjetUiLanguage()): string {
  return value.toLocaleTimeString(language === "en" ? "en-GB" : "de-DE", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

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
          {result.label ? <span className="text-muted-foreground">{result.label}: </span> : null}
          <strong className="font-semibold text-foreground">{result.value}</strong>
          <span className="text-muted-foreground"> · {result.source} · </span>
          <time className="text-muted-foreground" dateTime={calculatedAt.toISOString()}>
            {formatKpiTime(calculatedAt)}
          </time>
          {result.status === "stale" && <span className="text-warning-foreground"> · {result.detail}</span>}
        </>
      ) : result.detail.trim() === "" || result.detail === "—" ? null : (
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
