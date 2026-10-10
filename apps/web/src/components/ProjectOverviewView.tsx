import type { ReactNode } from "react";
import { scopeThreadRef } from "@workjet/client-runtime/environment";
import type { ScopedThreadRef } from "@workjet/contracts";
import { projectOverviewWorkerState, type ProjectOwnerOverview } from "../projectOverviewModel";

export function ProjectOverviewView(props: {
  readonly data: ProjectOwnerOverview;
  readonly onOpenChat: (ref: ScopedThreadRef) => void;
  readonly onOpenJourFixe?: (() => void) | undefined;
  readonly decisions?: ReactNode;
  readonly connectionError?: boolean;
  readonly diagnosis?: ReactNode;
  readonly actions?: ReactNode;
}) {
  const { data, onOpenChat } = props;
  const { text, language } = data;
  const locale = language === "de" ? "de-DE" : "en-GB";
  const date = (at: string | number) =>
    new Intl.DateTimeFormat(locale, {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(at));
  const open = (thread: (typeof data.members)[number]) =>
    onOpenChat(scopeThreadRef(thread.environmentId, thread.id));
  return (
    <main
      className="mx-auto grid w-full max-w-[1320px] min-w-0 items-start gap-5 p-4 text-sm sm:p-6 lg:grid-cols-[minmax(0,1fr)_18rem]"
      data-workjet-project-overview={data.projectId}
      lang={language}
    >
      <div className="min-w-0 space-y-5">
        <header>
          <h1 className="break-words text-[22px] font-semibold tracking-tight">{data.title}</h1>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{data.summary}</p>
          {props.actions}
        </header>
        <dl
          className="grid min-w-0 grid-cols-2 gap-2 xl:grid-cols-4"
          aria-label={language === "de" ? "Kennzahlen" : "Project metrics"}
          data-workjet-overview-kpis=""
        >
          {data.kpis.map((kpi) => (
            <div
              key={kpi.id}
              className="min-w-0 rounded-lg border border-border bg-card px-3 py-2.5"
              data-workjet-overview-kpi={kpi.id}
            >
              {kpi.value !== null && (
                <dd className="break-words text-2xl font-semibold tabular-nums [overflow-wrap:anywhere]">
                  {kpi.value}
                </dd>
              )}
              <dt className="text-xs font-medium text-muted-foreground">{kpi.label}</dt>
              <dd className="mt-1.5 text-xs leading-5 text-muted-foreground">{kpi.explanation}</dd>
            </div>
          ))}
        </dl>
        <section data-workjet-overview-section="decisions" aria-labelledby="overview-decisions">
          <Heading id="overview-decisions">
            {text.needsYou}
            {data.decisions.length > 0 ? " · " + data.decisions.length : ""}
          </Heading>
          {props.decisions ?? (
            <p className="text-muted-foreground">
              {data.decisions.length ? text.decisionUnavailable : text.noDecisions}
            </p>
          )}
          {(props.connectionError || data.disruptions.length > 0) && (
            <div className="mt-3 space-y-2" aria-label={text.disruptions}>
              {props.connectionError && (
                <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-400" />
                  {text.unavailableConnection}
                </p>
              )}
              {data.disruptions.map((thread) => (
                <p
                  key={thread.id}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground"
                >
                  <span>
                    {language === "de"
                      ? thread.title +
                        " kann gerade nicht weiterarbeiten. Bitte prüfe die gemeldete Störung im Chat."
                      : thread.title +
                        " cannot continue right now. Please check the reported issue in its chat."}
                  </span>
                  <button
                    type="button"
                    onClick={() => open(thread)}
                    className="text-primary hover:underline"
                  >
                    {text.details}
                  </button>
                </p>
              ))}
            </div>
          )}
        </section>
        <section data-workjet-overview-section="goals" aria-labelledby="overview-goals">
          <Heading id="overview-goals">{text.goals}</Heading>
          <p className="mb-2 text-xs leading-5 text-muted-foreground">
            {data.confirmed ? text.confirmedGoals : text.workerGoals}
          </p>
          {data.goals.length === 0 ? (
            <p className="text-muted-foreground">{text.noGoals}</p>
          ) : (
            <div
              className="overflow-hidden rounded-lg border border-border bg-card"
              role="table"
              aria-label={text.goals}
            >
              <div
                className="hidden grid-cols-[minmax(0,1fr)_9rem_6rem] gap-3 border-b border-border px-3 py-1.5 text-xs text-muted-foreground sm:grid"
                role="row"
              >
                <span role="columnheader">{text.task}</span>
                <span role="columnheader">{text.who}</span>
                <span role="columnheader">{text.status}</span>
              </div>
              {data.goals.map((goal) => (
                <div
                  key={goal.id}
                  className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-b border-border px-3 py-2 last:border-0 sm:grid-cols-[minmax(0,1fr)_9rem_6rem]"
                  role="row"
                >
                  <div
                    role="cell"
                    className="col-span-2 break-words leading-5 [overflow-wrap:anywhere] sm:col-span-1"
                  >
                    <span className="line-clamp-2" title={goal.title}>
                      {goal.title}
                    </span>
                  </div>
                  <div role="cell" className="min-w-0 break-words text-xs text-muted-foreground">
                    {goal.thread ? (
                      <button
                        className="text-left hover:underline"
                        type="button"
                        onClick={() => open(goal.thread!)}
                      >
                        {goal.owner}
                      </button>
                    ) : (
                      goal.owner
                    )}
                  </div>
                  <div role="cell">
                    <span className="inline-block whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                      {goal.state}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        <section data-workjet-overview-section="results" aria-labelledby="overview-results">
          <Heading id="overview-results">{text.results}</Heading>
          {data.merged.length === 0 ? (
            <p className="text-muted-foreground">{text.noResults}</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.merged.map((pr) => (
                <li key={pr.url} className="py-2 leading-5">
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                  >
                    {language === "de"
                      ? "PR #" + pr.number + " „" + pr.title + "“ wurde gemergt."
                      : "PR #" + pr.number + " “" + pr.title + "” was merged."}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section data-workjet-overview-section="history" aria-labelledby="overview-history">
          <Heading id="overview-history">{text.history}</Heading>
          {data.history.length === 0 ? (
            <p className="text-muted-foreground">{text.noHistory}</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.history.map((event) => (
                <li key={event.id} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3 py-1.5">
                  <time
                    dateTime={new Date(event.at).toISOString()}
                    className="text-xs text-muted-foreground"
                  >
                    {date(event.at)}
                  </time>
                  <span className="min-w-0 break-words leading-5">{event.sentence}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <details
          className="min-w-0 rounded-lg border border-dashed border-border px-3 py-2.5"
          data-workjet-overview-section="diagnosis"
        >
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {text.diagnosis}
          </summary>
          <div className="mt-3 space-y-3">
            {data.members.map((thread) => {
              const config = thread.workjetConfig;
              const native =
                config.schemaVersion === 2 &&
                (config.team?.role === "supervisor" || config.ctoxCrewChat !== undefined);
              const state = projectOverviewWorkerState(thread);
              return (
                <div
                  key={thread.environmentId + ":" + thread.id}
                  className="min-w-0 border-b border-border pb-3 text-xs last:border-0"
                >
                  <p className="font-medium">{thread.title}</p>
                  <dl className="mt-1 grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-muted-foreground">
                    <dt>{text.actual}</dt>
                    <dd className="break-words [overflow-wrap:anywhere]">
                      {native
                        ? text.nativeRoute
                        : thread.session
                          ? [thread.session.providerName, thread.session.providerInstanceId]
                              .filter(Boolean)
                              .join(" · ")
                          : text.noSession}
                    </dd>
                    <dt>{text.saved}</dt>
                    <dd className="break-words [overflow-wrap:anywhere]">
                      {native
                        ? (data.supervisorLumaId ?? text.unknown)
                        : thread.modelSelection.instanceId + " · " + thread.modelSelection.model}
                    </dd>
                    <dt>{text.computer}</dt>
                    <dd className="break-words [overflow-wrap:anywhere]">{thread.environmentId}</dd>
                    <dt>{text.status}</dt>
                    <dd>{text[state]}</dd>
                  </dl>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-muted-foreground">
                      {text.prompt}
                    </summary>
                    <p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                      {config.schemaVersion === 2 ? config.team?.goal : null}
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                      {config.managedInstructions}
                    </p>
                  </details>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-muted-foreground">{text.raw}</summary>
                    <pre className="mt-1 overflow-x-auto text-[11px]">
                      {JSON.stringify(
                        {
                          branch: thread.branch,
                          latestTurn: thread.latestTurn,
                          sessionStatus: thread.session?.status,
                          lastError: thread.session?.lastError,
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </div>
              );
            })}
            {props.diagnosis}
          </div>
        </details>
      </div>
      <aside className="min-w-0 space-y-3">
        <Card title={text.nextMeeting}>
          {data.recurring ? (
            <p className="text-base font-medium">
              {new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
                new Date(Date.UTC(2026, 0, 4 + data.recurring.weekday)),
              )}{" "}
              · {data.recurring.time}
              <span className="mt-1 block text-xs font-normal text-muted-foreground">
                {data.recurring.timezone}
              </span>
            </p>
          ) : (
            <p className="text-muted-foreground">{text.noNextMeeting}</p>
          )}
          {props.onOpenJourFixe && (
            <button
              type="button"
              onClick={props.onOpenJourFixe}
              data-workjet-action="project.jour-fixe.open"
              className="mt-3 rounded-md border border-border bg-primary px-3 py-1.5 text-xs text-primary-foreground"
            >
              {text.join}
            </button>
          )}
        </Card>
        <Card title={text.lastMeeting}>
          {data.lastMeeting ? (
            <p>{date(data.lastMeeting.scheduled_at_ms)}</p>
          ) : (
            <p className="text-muted-foreground">{text.noLastMeeting}</p>
          )}
        </Card>
        <Card title={text.ownerDecisions}>
          {data.ownerDecisions.length ? (
            <ul className="space-y-1">
              {data.ownerDecisions.map((sentence) => (
                <li key={sentence}>{sentence}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">{text.noOwnerDecisions}</p>
          )}
        </Card>
        <Card title={text.links}>
          {data.links.length ? (
            <ul className="space-y-1">
              {data.links.map((link) => (
                <li key={link.url}>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-words text-primary hover:underline [overflow-wrap:anywhere]"
                  >
                    {link.label} ↗
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">{text.noLinks}</p>
          )}
        </Card>
      </aside>
    </main>
  );
}
function Heading({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <h2 id={id} className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </h2>
  );
}
function Card({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card px-3 py-3">
      <h2 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}
