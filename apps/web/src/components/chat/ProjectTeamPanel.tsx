import { useState } from "react";
import type { ModelSelection, ProjectId, ThreadId, WorkjetThreadConfig } from "@workjet/contracts";

type TeamThread = {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workjetConfig: WorkjetThreadConfig;
  readonly modelSelection: ModelSelection;
};

export function ProjectTeamPanel(props: {
  readonly thread: TeamThread;
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
  if (!team) {
    const supervisor = props.threads.find(
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
      </section>
    );
  }
  const parent = props.threads.find((thread) => thread.id === team.parentThreadId);
  const children = props.threads.filter((thread) => {
    const member = thread.workjetConfig.schemaVersion === 2 ? thread.workjetConfig.team : undefined;
    return member?.projectId === team.projectId && member.parentThreadId === props.thread.id;
  });
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
    <section aria-label="Project team" className="border-b px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="capitalize">{team.role}</strong>
        {team.role === "specialist" ? <span>{team.domain}</span> : null}
        <span>
          {props.thread.modelSelection.instanceId} · {props.thread.modelSelection.model}
        </span>
        {team.parentThreadId ? (
          <button type="button" onClick={() => props.onOpen(team.parentThreadId!)}>
            Parent: {parent?.title ?? team.parentThreadId}
          </button>
        ) : null}
      </div>
      <p className="mt-1">Goal: {team.goal}</p>
      <details className="mt-2">
        <summary>Adjust goal</summary>
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
      {children.length ? (
        <ul className="mt-2 flex flex-wrap gap-3">
          {children.map((child) => (
            <li key={child.id}>
              <button type="button" onClick={() => props.onOpen(child.id)}>
                {child.title}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
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
