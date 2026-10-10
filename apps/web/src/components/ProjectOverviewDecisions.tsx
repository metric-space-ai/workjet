import { useState } from "react";
import * as Option from "effect/Option";
import type { EnvironmentThreadShell } from "@workjet/client-runtime/state/models";
import { scopeThreadRef } from "@workjet/client-runtime/environment";
import type { ScopedThreadRef } from "@workjet/contracts";
import { useEnvironmentThread, threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  type PendingUserInput,
} from "../session-logic";
import {
  buildPendingUserInputAnswers,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { PROJECT_OVERVIEW_TEXT, type ProjectOverviewLanguage } from "../projectOverviewText";

const chip =
  "rounded-full border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50";
export function ProjectOverviewQuestion(props: {
  readonly pending: PendingUserInput;
  readonly language: ProjectOverviewLanguage;
  readonly onAnswer: (answers: Record<string, string | string[]>) => Promise<boolean>;
}) {
  const text = PROJECT_OVERVIEW_TEXT[props.language];
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const answers = buildPendingUserInputAnswers(props.pending.questions, drafts);
  return (
    <form
      className="space-y-2"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!answers || busy) return;
        setBusy(true);
        setFailed(false);
        try {
          setFailed(!(await props.onAnswer(answers)));
        } catch {
          setFailed(true);
        } finally {
          setBusy(false);
        }
      }}
    >
      {props.pending.questions.map((question) => (
        <fieldset key={question.id} disabled={busy} className="min-w-0 space-y-2">
          <legend className="break-words leading-5">{question.question}</legend>
          <div className="flex flex-wrap gap-1.5">
            {question.options.map((option) => (
              <button
                key={option.label}
                type="button"
                aria-pressed={
                  drafts[question.id]?.selectedOptionLabels?.includes(option.label) ?? false
                }
                className={chip}
                title={option.description}
                onClick={() =>
                  setDrafts((previous) => ({
                    ...previous,
                    [question.id]: togglePendingUserInputOptionSelection(
                      question,
                      previous[question.id],
                      option.label,
                    ),
                  }))
                }
              >
                {option.label}
              </button>
            ))}
          </div>
          <input
            aria-label={question.question}
            placeholder={text.answer}
            value={drafts[question.id]?.customAnswer ?? ""}
            className="w-full min-w-0 rounded border border-input bg-transparent px-2 py-1 text-sm"
            onChange={(event) =>
              setDrafts((previous) => ({
                ...previous,
                [question.id]: { customAnswer: event.target.value },
              }))
            }
          />
        </fieldset>
      ))}
      <button type="submit" disabled={!answers || busy} className={chip}>
        {busy ? text.saving : text.answer}
      </button>
      {failed && (
        <p role="alert" className="text-xs text-muted-foreground">
          {text.saveFailed}
        </p>
      )}
    </form>
  );
}
export function ProjectOverviewDecisions(props: {
  readonly thread: EnvironmentThreadShell;
  readonly language: ProjectOverviewLanguage;
  readonly onOpenChat: (ref: ScopedThreadRef) => void;
}) {
  const { thread, language } = props;
  const text = PROJECT_OVERVIEW_TEXT[language];
  const state = useEnvironmentThread(thread.environmentId, thread.id);
  const activities = Option.getOrNull(state.data)?.activities ?? [];
  const approvals = derivePendingApprovals(activities);
  const inputs = derivePendingUserInputs(activities);
  const answer = useAtomCommand(threadEnvironment.respondToUserInput, { reportFailure: false });
  const open = () => props.onOpenChat(scopeThreadRef(thread.environmentId, thread.id));
  return (
    <div className="min-w-0 space-y-3 border-b border-border py-2 last:border-0">
      <p className="text-xs text-muted-foreground">{thread.title}</p>
      {inputs.map((pending) => (
        <ProjectOverviewQuestion
          key={pending.requestId}
          pending={pending}
          language={language}
          onAnswer={async (answers) => {
            const result = await answer({
              environmentId: thread.environmentId,
              input: { threadId: thread.id, requestId: pending.requestId, answers },
            });
            return result._tag === "Success";
          }}
        />
      ))}
      {approvals.map((approval) => (
        <div key={approval.requestId} className="space-y-2">
          <p>
            {language === "de"
              ? approval.requestKind === "file-read"
                ? "Darf dieser Worker eine Datei lesen?"
                : approval.requestKind === "file-change"
                  ? "Darf dieser Worker Dateien ändern?"
                  : "Darf dieser Worker die angeforderte Aktion ausführen?"
              : approval.requestKind === "file-read"
                ? "May this worker read a file?"
                : approval.requestKind === "file-change"
                  ? "May this worker change files?"
                  : "May this worker perform the requested action?"}
          </p>
          <button type="button" className={chip} onClick={open}>
            {language === "de" ? "Aktion prüfen und entscheiden" : "Review action and decide"}
          </button>
        </div>
      ))}
      {inputs.length === 0 && approvals.length === 0 && (
        <p className="text-muted-foreground">
          {state.status === "live" || state.error._tag === "Some"
            ? text.unknown
            : text.decisionUnavailable}
        </p>
      )}
      <button type="button" className="text-xs text-primary hover:underline" onClick={open}>
        {text.details}
      </button>
    </div>
  );
}
