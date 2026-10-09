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
      aria-label="Supervisor conversation"
    >
      <p className="ml-auto max-w-[85%] whitespace-pre-wrap break-words rounded-xl bg-muted/50 px-4 py-3">
        {journal.intent.goal}
      </p>
      {props.replies
        .filter((reply) => reply.text !== "" || reply.incomplete || reply.truncated)
        .map((reply) => (
          <article
            key={reply.id}
            aria-label={reply.phase === "commentary" ? "Supervisor commentary" : "Supervisor reply"}
          >
            <p className="mb-2 text-xs text-muted-foreground">
              {reply.phase === "commentary" ? "Supervisor · Progress" : "Supervisor"}
            </p>
            <SupervisorMarkdown text={reply.text} />
            {(reply.truncated || reply.incomplete) && (
              <p role="status" className="mt-1 text-xs text-muted-foreground">
                {reply.incomplete
                  ? "Reply incomplete. Reload execution history."
                  : "Stream excerpt truncated; the final task result is authoritative."}
              </p>
            )}
          </article>
        ))}
      {finalText && finalText !== publicAnswer && (
        <article aria-label="Supervisor final result">
          <p className="mb-2 text-xs text-muted-foreground">Supervisor</p>
          <SupervisorMarkdown text={finalText} />
        </article>
      )}
      {journal.turn?.resultTruncated && (
        <p className="text-xs text-muted-foreground">Result truncated</p>
      )}
      <div className="text-xs text-muted-foreground">
        <p>
          {journal.turn
            ? `${journal.turn.status} · Attempt ${journal.turn.attempt}`
            : "Waiting for CTOX receipt"}
        </p>
        {journal.turn?.taskId && (
          <details className="mt-1">
            <summary>Task details</summary>
            <p>Task {journal.turn.taskId}</p>
            <p>Command {journal.turn.commandId}</p>
          </details>
        )}
        {props.page && props.page.public_text_supported !== true && (
          <p role="status" className="mt-1">
            Live reply text is unavailable on this connection. Task history is still available.
          </p>
        )}
        {props.historyLimited && (
          <p role="status" className="mt-1">
            Reply history limit reached. Reload from the start to recover retained text.
          </p>
        )}
        <NativeSupervisorExecutionDetails
          page={props.page}
          error={props.error}
          disabled={props.disabled}
          onReset={props.onReset}
          onNext={props.onNext}
        />
      </div>
      {journal.submission === "not-submitted" && (
        <p role="status" className="text-xs text-muted-foreground">
          {canResumeSupervisorJournal(journal, null)
            ? "Waiting for the task receipt"
            : `Not sent: ${journal.submissionError}`}
        </p>
      )}
      {journal.turn?.errorMessage && (
        <p role="alert" className="text-destructive">
          {journal.turn.errorCode}: {journal.turn.errorMessage}
        </p>
      )}
    </section>
  );
}
