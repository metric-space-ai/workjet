import { useState } from "react";
import type { ModelSelection, ProjectId, ThreadId, WorkjetThreadConfig } from "@workjet/contracts";

type TeamThread = {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workjetConfig: WorkjetThreadConfig;
  readonly modelSelection: ModelSelection;
  readonly archivedAt?: string | null | undefined;
  readonly deletedAt?: string | null | undefined;
};

export function ProjectTeamPanel(props: {
  readonly thread: TeamThread;
  readonly compact?: boolean;
  readonly threads: ReadonlyArray<TeamThread>;
  readonly onOpen: (threadId: ThreadId) => void;
  readonly onAddSpecialist: (domain: string, goal: string) => Promise<boolean>;
  readonly onSaveGoal: (goal: string) => Promise<boolean>;
  readonly onCreateSupervisor: () => Promise<boolean>;
}) {
  const config = props.thread.workjetConfig;
  const team = config.schemaVersion === 2 ? config.team : undefined;
  const [domain, setDomain] = useState("");
  const [goal, setGoal] = useState("");
  const [editedGoal, setEditedGoal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const members = props.threads.filter((thread) => {
    const member = thread.workjetConfig.schemaVersion === 2 ? thread.workjetConfig.team : undefined;
    return (
      thread.projectId === props.thread.projectId &&
      member?.projectId === thread.projectId &&
      member.threadId === thread.id &&
      thread.archivedAt == null &&
      thread.deletedAt == null
    );
  });
  const directory = (
    <div className="mt-3 grid gap-3 sm:grid-cols-3" aria-label="Project Lumas">
      {(
        [
          ["supervisor", "Supervisor", "border-primary/50", "No supervisor yet."],
          ["specialist", "Fach-Lumas", "border-emerald-500/50", "No Fach-Lumas yet."],
          ["worker", "One-time PR threads", "border-amber-500/50", "No one-time PR threads yet."],
        ] as const
      ).map(([role, label, accent, empty]) => {
        const group = members.filter(
          (member) =>
            member.workjetConfig.schemaVersion === 2 && member.workjetConfig.team?.role === role,
        );
        return (
          <section
            key={role}
            aria-label={label}
            data-workjet-team-group={role}
            className={`min-w-0 rounded-md border-l-2 bg-muted/30 p-3 ${accent}`}
          >
            <h3 className="font-medium">{label}</h3>
            {group.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">{empty}</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {group.map((member) => {
                  const membership =
                    member.workjetConfig.schemaVersion === 2
                      ? member.workjetConfig.team
                      : undefined;
                  if (!membership) return null;
                  const owner = members.find(
                    (candidate) => candidate.id === membership.parentThreadId,
                  );
                  return (
                    <li key={member.id}>
                      <button
                        type="button"
                        aria-current={member.id === props.thread.id ? "page" : undefined}
                        onClick={() => props.onOpen(member.id)}
                        className="block max-w-full break-words text-left underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-ring"
                      >
                        {member.title}
                      </button>
                      {membership.role === "specialist" ? (
                        <p className="text-xs text-muted-foreground">{membership.domain}</p>
                      ) : null}
                      {owner ? (
                        <p className="text-xs text-muted-foreground">Parent: {owner.title}</p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
  if (!team) {
    const supervisor = members.find(
      (thread) =>
        thread.projectId === props.thread.projectId &&
        thread.workjetConfig.schemaVersion === 2 &&
        thread.workjetConfig.team?.role === "supervisor",
    );
    return (
      <section aria-label="Project team" className="border-b px-4 py-2 text-sm">
        {supervisor ? (
          <button type="button" onClick={() => props.onOpen(supervisor.id)}>
            Open project supervisor
          </button>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void props
                .onCreateSupervisor()
                .then((saved) => {
                  if (!saved)
                    setError(
                      "Could not create the project supervisor. Reload the project before retrying.",
                    );
                })
                .catch(() => setError("Could not create the project supervisor."))
                .finally(() => setBusy(false));
            }}
          >
            Create project supervisor
          </button>
        )}
        {error ? <p role="alert">{error}</p> : null}
        {props.compact ? null : directory}
      </section>
    );
  }
  const parent = members.find((thread) => thread.id === team.parentThreadId);
  const perform = async (action: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (!(await action())) setError("The team change could not be saved. Please try again.");
    } catch {
      setError("The team change could not be saved. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Project team" className={props.compact ? "flex flex-wrap items-start gap-x-4 gap-y-1 border-b px-4 py-2 text-xs" : "border-b px-4 py-2 text-sm"} data-workjet-team-toolbar={props.compact ? "compact" : undefined}>
      <div className="flex flex-wrap items-center gap-2">
        <strong className="capitalize">{team.role}</strong>
        {team.role === "specialist" ? <span>{team.domain}</span> : null}
        {props.compact ? null : <span>
          {props.thread.modelSelection.instanceId} · {props.thread.modelSelection.model}
        </span>}
        {team.parentThreadId ? (
          <button type="button" onClick={() => props.onOpen(team.parentThreadId!)}>
            Parent: {parent?.title ?? team.parentThreadId}
          </button>
        ) : null}
      </div>
      {props.compact ? null : <p className="mt-1">Goal: {team.goal}</p>}
      <details className="mt-1">
        <summary className="text-xs text-muted-foreground">Project goal</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void perform(async () => {
              const saved = await props.onSaveGoal((editedGoal ?? team.goal).trim());
              if (saved) setEditedGoal(null);
              return saved;
            });
          }}
        >
          <textarea
            aria-label="Team goal"
            maxLength={4096}
            required
            value={editedGoal ?? team.goal}
            onChange={(event) => setEditedGoal(event.target.value)}
            className="mt-2 w-full rounded border p-2"
          />
          <button type="submit" disabled={busy || !(editedGoal ?? team.goal).trim()}>
            Save goal
          </button>
        </form>
      </details>
      {props.compact ? null : directory}
      {team.role === "supervisor" ? (
        <details className="mt-2">
          <summary>Add domain specialist</summary>
          <form
            className="mt-2 grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(async () => {
                const saved = await props.onAddSpecialist(domain.trim(), goal.trim());
                if (saved) {
                  setDomain("");
                  setGoal("");
                }
                return saved;
              });
            }}
          >
            <input
              aria-label="Specialist domain"
              required
              maxLength={256}
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              className="rounded border p-2"
            />
            <textarea
              aria-label="Specialist goal"
              required
              maxLength={4096}
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              className="rounded border p-2"
            />
            <button type="submit" disabled={busy || !domain.trim() || !goal.trim()}>
              Add specialist
            </button>
          </form>
        </details>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
