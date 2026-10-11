import { useEffect, useState, type ReactNode } from "react";
import { scopeThreadRef } from "@workjet/client-runtime/environment";
import { supervisorTickDueAt, type ScopedThreadRef } from "@workjet/contracts";
import {
  projectOverviewWorkerState,
  projectOverviewWorkerName,
  projectOverviewStatusTone,
  type ProjectOverviewStatus,
  type ProjectOwnerOverview,
} from "../projectOverviewModel";
import { projectOverviewFormat } from "../projectOverviewText";
import "./ProjectOverviewView.css";

const tones = {
  red: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  blue: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
  amber: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  gray: "border-border bg-muted text-muted-foreground",
  green: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
};
function Status({
  status,
  children,
}: {
  readonly status: ProjectOverviewStatus;
  readonly children: ReactNode;
}) {
  const tone = projectOverviewStatusTone(status);
  return (
    <span
      data-workjet-overview-status={tone}
      className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4 ${tones[tone]}`}
    >
      {status === "completed" && <span aria-hidden="true">✓</span>}
      {children}
    </span>
  );
}
function OverviewTick({ data }: { readonly data: ProjectOwnerOverview }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const { text, supervisorTick: tick } = data;
  const next = tick.createdAt
    ? supervisorTickDueAt(tick.createdAt, tick.configuration, tick.state)
    : null;
  const lastLabel = tick.state?.lastControlAt
    ? projectOverviewFormat(text.minutesAgo, {
        minutes: Math.max(0, Math.floor((now - Date.parse(tick.state.lastControlAt)) / 60000)),
      })
    : text.controlNone;
  const nextLabel =
    tick.configuration?.enabled === false
      ? text.controlOff
      : next === null
        ? text.controlMissing
        : next <= now
          ? text.controlDue
          : projectOverviewFormat(text.minutesUntil, { minutes: Math.ceil((next - now) / 60000) });
  return (
    <span
      className="overview-meta-chip"
      data-workjet-supervisor-tick=""
      title={tick.state?.outcome === "skipped-busy" ? text.controlSkipped : undefined}
    >
      {projectOverviewFormat(text.controlLast, { time: lastLabel })} ·{" "}
      {projectOverviewFormat(text.controlNext, { time: nextLabel })}
    </span>
  );
}
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
  const shortDate = (at: number) =>
    new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit" }).format(new Date(at));
  const meetingLabel = data.recurring
    ? new Intl.DateTimeFormat(locale, {
        weekday: "long",
        day: "2-digit",
        month: "2-digit",
        timeZone: "UTC",
      }).format(new Date(data.nextMeetingDate! + "T00:00:00Z")) +
      " · " +
      data.recurring.time
    : text.noNextMeeting;
  const open = (thread: (typeof data.members)[number]) =>
    onOpenChat(scopeThreadRef(thread.environmentId, thread.id));
  return (
    <main
      className="overview-layout mx-auto w-full max-w-[1320px] min-w-0 p-4 text-[13.5px] leading-[1.4] sm:p-6"
      data-workjet-project-overview={data.projectId}
      lang={language}
    >
      <header className="overview-header min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <h1 className="min-w-0 break-words text-[22px] font-semibold tracking-tight">
            {data.title}
          </h1>
          {props.actions && <div className="shrink-0 text-xs">{props.actions}</div>}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="overview-meta-chip">
            {text.nextMeeting}: {meetingLabel}
          </span>
          <span className="overview-meta-chip">
            {data.parents.length} {text.parents}
          </span>
          {data.workers.length > 0 && (
            <span className="overview-meta-chip">
              {data.workers.length} {text.workers}
            </span>
          )}
          {data.disruptions.length > 0 && (
            <Status status="disrupted">
              {data.disruptions.length} {text.disrupted}
            </Status>
          )}
          <OverviewTick data={data} />
        </div>
        {data.summary && <p className="mt-2 text-xs text-muted-foreground">{data.summary}</p>}
      </header>
      <section
        className="overview-meeting min-w-0 self-start rounded-lg border border-border bg-card px-3 py-3"
        aria-labelledby="overview-next-meeting"
        data-workjet-overview-section="meeting"
      >
        <Heading id="overview-next-meeting">{text.nextMeeting}</Heading>
        <p className="text-[17px] font-semibold tabular-nums">{meetingLabel}</p>
        {data.recurring && (
          <p className="mt-1 text-xs text-muted-foreground">{data.recurring.timezone}</p>
        )}
        <button
          type="button"
          onClick={props.onOpenJourFixe}
          disabled={!props.onOpenJourFixe}
          title={props.onOpenJourFixe ? undefined : text.meetingConnectionRequired}
          data-workjet-action="project.jour-fixe.open"
          className="mt-3 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-50"
        >
          {text.join}
        </button>
      </section>
      {(data.decisions.length > 0 ||
        data.disruptions.length > 0 ||
        data.escalations.length > 0 ||
        props.connectionError) && (
        <div className="overview-attention min-w-0 space-y-2">
          {data.decisions.length > 0 && (
            <section
              className="rounded-md border border-blue-500/25 border-l-2 border-l-blue-500 bg-blue-500/5 px-3 py-2"
              data-workjet-overview-section="decisions"
              aria-labelledby="overview-decisions"
            >
              <Heading id="overview-decisions">
                {text.needsYou} · {data.decisions.length}
              </Heading>
              {props.decisions ??
                data.decisions.map((thread) => (
                  <div
                    key={thread.environmentId + ":" + thread.id}
                    className="flex items-center justify-between gap-3 py-1"
                  >
                    <span className="min-w-0 break-words">{thread.title}</span>
                    <button
                      type="button"
                      onClick={() => open(thread)}
                      className="shrink-0 text-xs text-primary hover:underline"
                    >
                      {text.reviewAction}
                    </button>
                  </div>
                ))}
            </section>
          )}
          {props.connectionError && (
            <p className="text-xs text-muted-foreground" data-workjet-overview-connection="">
              {text.unavailableConnection}
            </p>
          )}
          {[
            ...data.disruptions.map((thread) => ({ thread, disrupted: true })),
            ...data.escalations
              .filter((thread) => !data.disruptions.includes(thread))
              .map((thread) => ({ thread, disrupted: false })),
          ].map(({ thread, disrupted }) => {
            const state = projectOverviewWorkerState(thread);
            const tone = disrupted ? "red" : projectOverviewStatusTone(state);
            return (
              <div
                key={thread.environmentId + ":" + thread.id}
                className={`flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-xs ${tones[tone]}`}
                data-workjet-overview-alert={disrupted ? "disruption" : "escalation"}
              >
                <span aria-hidden="true">●</span>
                <span className="min-w-0 break-words">
                  {projectOverviewFormat(disrupted ? text.disruptionLine : text.escalationLine, {
                    name: projectOverviewWorkerName(thread.title, data.title).name,
                    status: text[state],
                  })}
                </span>
                <button
                  type="button"
                  onClick={() => open(thread)}
                  className="ml-auto shrink-0 text-primary hover:underline"
                >
                  {text.details}
                </button>
              </div>
            );
          })}
        </div>
      )}
      <dl
        className="overview-metrics grid min-w-0 grid-cols-2 gap-2.5 min-[980px]:grid-cols-5"
        aria-label={text.metrics}
        data-workjet-overview-kpis=""
      >
        {data.kpis.map((kpi) => (
          <div
            key={kpi.id}
            className={`min-w-0 rounded-lg border border-border bg-card px-3 py-2.5 ${kpi.id === "tokens" ? "col-span-2 min-[980px]:col-span-1" : ""}`}
            data-workjet-overview-kpi={kpi.id}
          >
            <dd
              className={`break-words text-[22px] font-semibold tabular-nums [overflow-wrap:anywhere] ${kpi.value === "—" ? "text-muted-foreground" : ""}`}
            >
              {kpi.id === "tokens" && kpi.value.includes(" (") ? (
                <>
                  {kpi.value.slice(0, kpi.value.indexOf(" ("))}{" "}
                  <span className="whitespace-nowrap text-[11px] font-medium text-muted-foreground">
                    {kpi.value.slice(kpi.value.indexOf(" (") + 1)}
                  </span>
                </>
              ) : (
                kpi.value
              )}
            </dd>
            <dt className="mt-0.5 text-xs text-muted-foreground">{kpi.label}</dt>
            {kpi.note && <dd className="mt-1 text-[11px] text-muted-foreground">{kpi.note}</dd>}
          </div>
        ))}
      </dl>
      <section
        className="overview-goals min-w-0"
        data-workjet-overview-section="goals"
        aria-labelledby="overview-goals"
      >
        <div className="mb-2 flex flex-wrap items-baseline gap-2">
          <Heading id="overview-goals">
            {text.goals}
            {data.recurring ? " · " + meetingLabel : ""}
          </Heading>
          <span className="overview-meta-chip text-[11px] text-muted-foreground">
            {data.confirmed && data.confirmedAt
              ? projectOverviewFormat(text.confirmedGoals, { date: shortDate(data.confirmedAt) })
              : text.workerGoals}
          </span>
        </div>
        {data.goals.length === 0 ? (
          <p className="text-muted-foreground">{text.noGoals}</p>
        ) : (
          <div
            className="overflow-hidden rounded-lg border border-border bg-card"
            role="table"
            aria-label={text.goals}
          >
            <div
              className="overview-goal-columns hidden gap-3 border-b border-border px-2.5 py-1.5 text-xs text-muted-foreground min-[721px]:grid"
              role="row"
            >
              <span role="columnheader">{text.task}</span>
              <span role="columnheader">{text.who}</span>
              <span role="columnheader">{text.status}</span>
            </div>
            {data.goals.map((goal) => (
              <div
                key={goal.id}
                className="overview-goal-columns grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-b border-border px-2.5 py-2 last:border-0"
                role="row"
              >
                <div
                  role="cell"
                  className="col-span-2 min-w-0 break-words [overflow-wrap:anywhere] min-[721px]:col-span-1"
                >
                  <span className="line-clamp-2" title={goal.title}>
                    {goal.title}
                  </span>
                </div>
                <div role="cell" className="min-w-0 text-xs" data-workjet-overview-owner="">
                  {goal.thread ? (
                    <button
                      className="line-clamp-1 max-w-full break-words text-left hover:underline"
                      type="button"
                      onClick={() => open(goal.thread!)}
                      title={goal.owner}
                    >
                      {goal.owner}
                    </button>
                  ) : (
                    <span className="line-clamp-1 break-words">{goal.owner}</span>
                  )}
                  {goal.harness && (
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {goal.harness}
                    </span>
                  )}
                </div>
                <div role="cell" className="min-w-0">
                  <Status status={goal.status}>{goal.state}</Status>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <section
        className="overview-results min-w-0"
        data-workjet-overview-section="results"
        aria-labelledby="overview-results"
      >
        <Heading id="overview-results">{text.results}</Heading>
        {data.merged.length === 0 ? (
          <p className="text-muted-foreground">{text.noResults}</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.merged.map((pr) => (
              <li key={pr.url} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 break-words hover:underline"
                >
                  #{pr.number} {pr.title}
                </a>
                {pr.mergedAt && Number.isFinite(Date.parse(pr.mergedAt)) && (
                  <time dateTime={pr.mergedAt} className="text-xs text-muted-foreground">
                    {date(pr.mergedAt)}
                  </time>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section
        className="overview-history min-w-0"
        data-workjet-overview-section="history"
        aria-labelledby="overview-history"
      >
        <Heading id="overview-history">{text.history}</Heading>
        {data.history.length === 0 ? (
          <p className="text-muted-foreground">{text.noHistory}</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.history.map((event) => (
              <li
                key={event.id}
                className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 py-1.5"
                data-workjet-overview-event={event.id}
              >
                <time
                  dateTime={new Date(event.at).toISOString()}
                  className="text-xs text-muted-foreground"
                >
                  {date(event.at)}
                </time>
                <span className="min-w-0 break-words">{event.sentence}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <aside className="overview-facts min-w-0 self-start" aria-label={text.facts}>
        <dl
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs"
          data-workjet-overview-facts=""
        >
          <dt className="text-muted-foreground">{text.lastMeeting}</dt>
          <dd>{data.lastMeeting ? date(data.lastMeeting.scheduled_at_ms) : text.noLastMeeting}</dd>
          <dt className="text-muted-foreground">{text.ownerDecisions}</dt>
          <dd>
            {data.ownerDecisions.length ? data.ownerDecisions.join(" · ") : text.noOwnerDecisions}
          </dd>
          <dt className="text-muted-foreground">{text.links}</dt>
          <dd className="min-w-0 space-y-1">
            {data.links.length
              ? data.links.map((link) => (
                  <a
                    key={link.url}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block break-words text-primary hover:underline"
                  >
                    {link.label} ↗
                  </a>
                ))
              : text.noLinks}
          </dd>
        </dl>
      </aside>
      <details
        className="overview-diagnosis min-w-0 rounded-lg border border-dashed border-border px-3 py-2"
        data-workjet-overview-section="diagnosis"
      >
        <summary className="cursor-pointer text-xs text-muted-foreground">{text.diagnosis}</summary>
        <div className="mt-3 space-y-3">
          {data.members.map((thread) => {
            const config = thread.workjetConfig;
            const native =
              config.schemaVersion === 2 &&
              (config.team?.role === "supervisor" || config.ctoxCrewChat !== undefined);
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
                      ? config.schemaVersion === 2 && config.team?.role === "supervisor"
                        ? (data.supervisorLumaId ?? text.unknown)
                        : text.unknown
                      : thread.modelSelection.instanceId + " · " + thread.modelSelection.model}
                  </dd>
                  <dt>{text.computer}</dt>
                  <dd className="break-words [overflow-wrap:anywhere]">
                    {native ? text.unknown : thread.environmentId}
                  </dd>
                  <dt>{text.status}</dt>
                  <dd>{text[projectOverviewWorkerState(thread)]}</dd>
                </dl>
                <details className="mt-2">
                  <summary className="cursor-pointer text-muted-foreground">{text.prompt}</summary>
                  <p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                    {config.schemaVersion === 2
                      ? (config.goal?.objective ?? config.team?.goal)
                      : null}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                    {config.managedInstructions}
                  </p>
                </details>
              </div>
            );
          })}
          {props.diagnosis}
        </div>
      </details>
    </main>
  );
}
function Heading({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <h2
      id={id}
      className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase"
    >
      {children}
    </h2>
  );
}
