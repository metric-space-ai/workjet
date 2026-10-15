import type { WorkjetSupervisorExecutionPage, WorkjetSupervisorJournal } from "@workjet/contracts";
import type { SupervisorPublicReply } from "../../supervisorPublicReplies";
import {
  nativeSupervisorResultText,
  canResumeSupervisorJournal,
} from "../../nativeSupervisorComposer";
import { NativeSupervisorExecutionDetails } from "./NativeSupervisorExecutionDetails";
import { SupervisorMarkdown } from "./SupervisorMarkdown";

export function NativeSupervisorConversation(props: {
  readonly journal: WorkjetSupervisorJournal;
  readonly page: WorkjetSupervisorExecutionPage | null;
  readonly replies: readonly SupervisorPublicReply[];
  readonly historyLimited: boolean;
  readonly error: string | null;
  readonly disabled: boolean;
  readonly onReset: () => void;
  readonly onNext: () => void;
  readonly onRetrySend?: (() => void) | undefined;
}) {
  const { journal } = props;
  const finalText =
    journal.turn?.result != null
      ? nativeSupervisorResultText(journal.turn.result, journal.turn)
      : null;
  const publicAnswer = props.replies
    .filter((reply) => reply.phase !== "commentary")
    .map((reply) => reply.text)
    .join("\n\n");
  return (
    <section
      className="mx-auto w-full max-w-5xl space-y-5 px-4 py-6 text-sm"
      aria-label="Supervisor-Unterhaltung"
    >
      <p className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-xl bg-muted/50 px-4 py-3">
        {journal.intent.goal}
      </p>
      {journal.inputs?.map((entry) => (
        <article
          key={entry.intent.commandId}
          aria-label="Kontext vom Owner"
          className="ml-auto max-w-[85%] rounded-xl bg-muted/50 px-4 py-3"
        >
          <p className="whitespace-pre-wrap break-words">{entry.intent.body}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {entry.receipt ? "Gespeichert" : "Unbestätigt"}
          </p>
        </article>
      ))}
      {props.replies
        .filter((reply) => reply.text !== "" || reply.incomplete || reply.truncated)
        .map((reply) => (
          <article
            key={reply.id}
            aria-label={
              reply.phase === "commentary" ? "Supervisor-Kommentar" : "Supervisor-Antwort"
            }
          >
            <p className="mb-2 text-xs text-muted-foreground">
              {reply.phase === "commentary" ? "Supervisor · Fortschritt" : "Supervisor"}
            </p>
            <SupervisorMarkdown text={reply.text} />
            {(reply.truncated || reply.incomplete) && (
              <p role="status" className="mt-1 text-xs text-muted-foreground">
                {reply.incomplete ? "Antwort unvollständig" : "Auszug gekürzt"}
              </p>
            )}
          </article>
        ))}
      {finalText && finalText !== publicAnswer && (
        <article aria-label="Endergebnis">
          <p className="mb-2 text-xs text-muted-foreground">Supervisor</p>
          <SupervisorMarkdown text={finalText} />
        </article>
      )}
      {journal.turn?.resultTruncated && (
        <p className="text-xs text-muted-foreground">Ergebnis gekürzt</p>
      )}
      <div className="text-xs text-muted-foreground">
        <NativeSupervisorExecutionDetails
          page={props.page}
          error={props.error}
          disabled={props.disabled}
          onReset={props.onReset}
          onNext={props.onNext}
        />
      </div>
      {journal.submission === "not-submitted" && !canResumeSupervisorJournal(journal, null) && (
        <p role="status" className="text-xs text-muted-foreground">
          Nicht gesendet
          {props.onRetrySend ? (
            <>
              {" · "}
              <button
                type="button"
                className="underline underline-offset-2"
                disabled={props.disabled}
                onClick={props.onRetrySend}
              >
                Erneut senden
              </button>
            </>
          ) : null}
        </p>
      )}
      {journal.turn?.errorMessage && (
        <p role="alert" className="text-destructive">
          {journal.turn.errorMessage}
        </p>
      )}
    </section>
  );
}
