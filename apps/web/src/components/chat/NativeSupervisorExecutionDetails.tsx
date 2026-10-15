import type { WorkjetSupervisorExecutionPage } from "@workjet/contracts";

export function NativeSupervisorExecutionDetails(props: {
  readonly page: WorkjetSupervisorExecutionPage | null;
  readonly error: string | null;
  readonly disabled: boolean;
  readonly onNext: () => void;
  readonly onReset: () => void;
}) {
  if (props.page === null && props.error === null) return null;
  return (
    <details className="mt-2 text-xs text-muted-foreground">
      <summary>Ausführungsverlauf</summary>
      {props.page?.attempt && (
        <div className="mt-1 break-all">
          <p>Versuchs-ID {props.page.attempt.attempt_id}</p>
          {props.page.attempt.run_id && <p>Run-ID {props.page.attempt.run_id}</p>}
        </div>
      )}
      {props.page &&
        (props.page.events.length === 0 ? (
          <p className="mt-1">Noch keine Ereignisse</p>
        ) : (
          <ol className="mt-2 space-y-1" aria-label="Ereignisse">
            {props.page.events.map((event) => (
              <li key={event.id} className="whitespace-pre-wrap break-words">
                {event.sequence}. {event.title || event.kind}
              </li>
            ))}
          </ol>
        ))}
      {props.error && (
        <p role="status" className="mt-1">
          {props.error}
        </p>
      )}
      <div className="mt-2 flex gap-3">
        <button type="button" disabled={props.disabled} onClick={props.onReset}>
          Neu laden
        </button>
        {props.page?.has_more && (
          <button type="button" disabled={props.disabled} onClick={props.onNext}>
            Mehr laden
          </button>
        )}
      </div>
    </details>
  );
}
