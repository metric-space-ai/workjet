import type { ReactNode } from "react";
import { SupervisorTickStatus } from "./SupervisorTickStatus";
import { scopeThreadRef } from "@workjet/client-runtime/environment";
import type { ScopedThreadRef } from "@workjet/contracts";
import { projectOverviewFormat, type ProjectOverviewLanguage } from "../projectOverviewText";
import {
  projectOverviewStatusTone,
  projectOverviewWorkerName,
  projectOverviewWorkerState,
  type ProjectOverviewStatus,
  type ProjectOwnerOverview,
} from "../projectOverviewModel";
import { Button } from "./ui/button";

const toneClasses: Record<string, string> = {
  red: "border-red-500/40 text-red-400",
  blue: "border-blue-500/40 text-blue-300",
  amber: "border-amber-500/40 text-amber-400",
  green: "border-emerald-500/40 text-emerald-400",
  gray: "border-border text-muted-foreground",
};
const dotClasses: Record<string, string> = {
  red: "bg-red-400",
  blue: "bg-blue-300",
  amber: "bg-amber-400",
  green: "bg-emerald-400",
  gray: "bg-muted-foreground",
};
function StatusChip(props: { readonly status: ProjectOverviewStatus; readonly label: string }) {
  return (
    <span
      className={
        "inline-block rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap " +
        toneClasses[projectOverviewStatusTone(props.status)]
      }
    >
      {props.label}
    </span>
  );
}
function localeOf(language: ProjectOverviewLanguage) {
  return language === "de" ? "de-DE" : "en-GB";
}
export function ProjectOverviewView(props: {
  readonly data: ProjectOwnerOverview;
  readonly onOpenChat: (ref: ScopedThreadRef) => void;
  readonly onOpenJourFixe?: (() => void) | undefined;
  readonly decisions?: ReactNode;
  readonly connectionError?: boolean;
  readonly actions?: ReactNode;
}) {
  const { data, onOpenChat } = props;
  const { text, language } = data;
  const locale = localeOf(language);
  const date = (at: string | number) =>
    new Intl.DateTimeFormat(locale, {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(at));
  const weekday = data.recurring
    ? new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
        new Date(Date.UTC(2026, 0, 4 + data.recurring.weekday)),
      )
    : null;
  const open = (thread: (typeof data.members)[number]) =>
    onOpenChat(scopeThreadRef(thread.environmentId, thread.id));
  return (
    <main
      className="mx-auto grid w-full max-w-[1320px] min-w-0 items-start gap-5 p-4 text-sm sm:p-6 lg:grid-cols-[minmax(0,1fr)_18rem]"
      data-workjet-project-overview={data.projectId}
      lang={language}
    >
      <div className="min-w-0 space-y-4">
        <header>
          <h1 className="break-words text-[22px] font-semibold tracking-tight">{data.title}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
            {data.recurring && weekday !== null && (
              <span>
                {text.nextMeeting}:{" "}
                <span className="text-foreground">
                  {weekday} · {data.recurring.time}
                </span>
              </span>
            )}
            <span>
              {data.parents.length} {data.parents.length === 1 ? text.parentSingular : text.parents}
            </span>
            {data.disruptions.length > 0 && (
              <span className="inline-flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-red-400" />
                {data.disruptions.length} {text.disrupted}
              </span>
            )}
            {props.actions}
          </div>
          {data.summary !== null && (
            <p className="mt-1.5 text-sm leading-6 text-muted-foreground">{data.summary}</p>
          )}
          <SupervisorTickStatus {...data.supervisorTick} language={language} text={text} />
        </header>
        {props.connectionError && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <span className="size-1.5 shrink-0 rounded-full bg-amber-400" />
            {text.unavailableConnection}
          </p>
        )}
        {data.decisions.length > 0 && props.decisions && (
          <section
            data-workjet-overview-section="decisions"
            aria-label={text.needsYou}
            className="rounded-lg border border-blue-500/30 bg-blue-500/5 px-3 py-2.5"
          >
            <h2 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {text.needsYou} · {data.decisions.length}
            </h2>
            {props.decisions}
          </section>
        )}
        {(data.disruptions.length > 0 || data.escalations.length > 0) && (
          <div className="space-y-1.5" aria-label={text.disruptions}>
            {data.disruptions.map((thread) => (
              <p
                key={thread.id}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-1.5 text-[13px]"
              >
                <span className="size-1.5 shrink-0 rounded-full bg-red-400" />
                <span className="min-w-0 break-words">
                  {projectOverviewFormat(text.disruptionLine, {
                    name: projectOverviewWorkerName(thread.title, data.title).name,
                  })}
                </span>
                <Button
                  variant="outline"
                  size="xs"
                  className="ml-auto"
                  onClick={() => open(thread)}
                >
                  {text.openChat}
                </Button>
              </p>
            ))}
            {data.escalations.map((thread) => {
              const status = projectOverviewWorkerState(thread);
              return (
                <p
                  key={thread.id}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-1.5 text-[13px]"
                >
                  <span className="size-1.5 shrink-0 rounded-full bg-amber-400" />
                  <span className="min-w-0 break-words">
                    {projectOverviewFormat(text.escalationLine, {
                      name: projectOverviewWorkerName(thread.title, data.title).name,
                      status: text[status],
                    })}
                  </span>
                  <Button
                    variant="outline"
                    size="xs"
                    className="ml-auto"
                    onClick={() => open(thread)}
                  >
                    {text.openChat}
                  </Button>
                </p>
              );
            })}
          </div>
        )}
        <section data-workjet-overview-section="kpis" aria-labelledby="overview-kpis">
          <Heading id="overview-kpis">{text.metrics}</Heading>
          <dl
            className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5"
            data-workjet-overview-kpis=""
          >
            {data.kpis.map((kpi) => (
              <div
                key={kpi.id}
                className="min-w-0 rounded-lg border border-border bg-card px-3 py-2.5"
                data-workjet-overview-kpi={kpi.id}
              >
                <dd
                  className={
                    "break-words text-[22px] font-semibold tabular-nums [overflow-wrap:anywhere]" +
                    (kpi.value === "—" ? " text-muted-foreground/60" : "")
                  }
                >
                  {kpi.value}
                </dd>
                <dt className="mt-0.5 text-xs text-muted-foreground">{kpi.label}</dt>
                {kpi.note !== null && (
                  <dd className="mt-0.5 text-[11px] text-amber-400">{kpi.note}</dd>
                )}
              </div>
            ))}
          </dl>
        </section>
        <section data-workjet-overview-section="goals" aria-labelledby="overview-goals">
          <Heading id="overview-goals">
            {text.goals}
            <span className="ml-2 rounded-full border border-border px-2 py-px text-[11px] font-normal tracking-normal normal-case">
              {data.confirmed
                ? projectOverviewFormat(text.confirmedGoals, {
                    date: data.confirmedAt ? date(data.confirmedAt) : "—",
                  })
                : text.workerGoals}
            </span>
          </Heading>
          {data.goals.length === 0 ? (
            <p className="rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-muted-foreground">
              {text.noGoals}
            </p>
          ) : (
            <div
              className="overflow-hidden rounded-lg border border-border bg-card"
              role="table"
              aria-label={text.goals}
            >
              <div
                className="hidden grid-cols-[minmax(0,1fr)_11rem_6.5rem] gap-3 border-b border-border px-3 py-1.5 text-xs text-muted-foreground sm:grid"
                role="row"
              >
                <span role="columnheader">{text.task}</span>
                <span role="columnheader">{text.who}</span>
                <span role="columnheader">{text.status}</span>
              </div>
              {data.goals.map((goal) => (
                <div
                  key={goal.id}
                  className="min-w-0 border-b border-border px-3 py-2 last:border-0 sm:grid sm:grid-cols-[minmax(0,1fr)_11rem_6.5rem] sm:gap-3"
                  role="row"
                >
                  <div
                    role="cell"
                    className="break-words leading-5 [overflow-wrap:anywhere] max-sm:mb-1"
                  >
                    <span className="line-clamp-2" title={goal.title}>
                      {goal.title}
                    </span>
                  </div>
                  <div role="cell" className="min-w-0 text-xs text-muted-foreground max-sm:inline">
                    {goal.thread ? (
                      <button
                        className="text-left break-words"
                        type="button"
                        onClick={() => open(goal.thread!)}
                      >
                        {goal.owner}
                      </button>
                    ) : (
                      goal.owner
                    )}
                    {goal.harness !== null && (
                      <span className="block text-[11px] text-muted-foreground/70 max-sm:ml-1.5 max-sm:inline">
                        {goal.harness}
                      </span>
                    )}
                  </div>
                  <div role="cell" className="max-sm:ml-2 max-sm:inline">
                    <StatusChip status={goal.status} label={goal.state} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        <section data-workjet-overview-section="results" aria-labelledby="overview-results">
          <Heading id="overview-results">{text.results}</Heading>
          {data.merged.length === 0 ? (
            <p className="rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-muted-foreground">
              {text.noResults}
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border bg-card px-3">
              {data.merged.map((pr) => (
                <li key={pr.url} className="flex flex-wrap items-baseline gap-x-2 py-2 leading-5">
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 break-words"
                  >
                    #{pr.number} {pr.title}
                  </a>
                  {pr.mergedAt != null && (
                    <time
                      dateTime={new Date(pr.mergedAt).toISOString()}
                      className="ml-auto text-xs text-muted-foreground tabular-nums"
                    >
                      {date(pr.mergedAt)}
                    </time>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <section data-workjet-overview-section="history" aria-labelledby="overview-history">
          <Heading id="overview-history">{text.history}</Heading>
          {data.history.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{text.noHistory}</p>
          ) : (
            <ul>
              {data.history.map((event) => (
                <li
                  key={event.id}
                  className="grid grid-cols-[5.75rem_minmax(0,1fr)] gap-3 border-b border-border py-1.5 last:border-0"
                >
                  <time
                    dateTime={new Date(event.at).toISOString()}
                    className="pt-px text-[11.5px] text-muted-foreground tabular-nums"
                  >
                    {date(event.at)}
                  </time>
                  <span className="min-w-0 break-words text-[13px] leading-5 text-muted-foreground">
                    {event.sentence}
                  </span>
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
          <div
            className="mt-3 overflow-hidden rounded-lg border border-border"
            role="table"
            aria-label={text.diagnosis}
          >
            <div
              className="hidden grid-cols-[minmax(0,1fr)_9rem_7rem_6.5rem] gap-3 border-b border-border px-3 py-1.5 text-xs text-muted-foreground sm:grid"
              role="row"
            >
              <span role="columnheader">Thread</span>
              <span role="columnheader">Harness · Modell</span>
              <span role="columnheader">{text.connection}</span>
              <span role="columnheader">{text.status}</span>
            </div>
            {data.members.map((thread) => {
              const config = thread.workjetConfig;
              const native =
                config.schemaVersion === 2 &&
                (config.team?.role === "supervisor" || config.ctoxCrewChat !== undefined);
              const status = projectOverviewWorkerState(thread);
              return (
                <div
                  key={thread.environmentId + ":" + thread.id}
                  className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-b border-border px-3 py-2 text-xs last:border-0 sm:grid-cols-[minmax(0,1fr)_9rem_7rem_6.5rem]"
                  role="row"
                >
                  <div role="cell" className="min-w-0 break-words font-medium">
                    {thread.title}
                  </div>
                  <div role="cell" className="min-w-0 break-words text-muted-foreground">
                    {native
                      ? "—"
                      : [thread.session?.providerName, thread.modelSelection.model]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                  </div>
                  <div role="cell" className="text-muted-foreground">
                    {thread.session?.status ?? "—"}
                  </div>
                  <div role="cell">
                    <StatusChip status={status} label={text[status]} />
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      </div>
      <aside className="min-w-0 space-y-3 max-lg:order-first">
        <section className="rounded-lg border border-border bg-card px-3.5 py-3">
          <h2 className="text-xs text-muted-foreground">{text.nextMeeting}</h2>
          {data.recurring && weekday !== null ? (
            <p className="mt-1 text-[17px] font-semibold">
              {weekday} · {data.recurring.time}
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                {data.recurring.timezone}
              </span>
            </p>
          ) : (
            <p className="mt-1 text-[17px] font-semibold text-muted-foreground/60">
              {text.noNextMeeting}
            </p>
          )}
          <Button
            size="xs"
            className="mt-2.5"
            onClick={props.onOpenJourFixe}
            disabled={!props.onOpenJourFixe}
            title={props.onOpenJourFixe ? undefined : text.meetingConnectionRequired}
            data-workjet-action="project.jour-fixe.open"
          >
            {text.join}
          </Button>
        </section>
        <section className="rounded-lg border border-border bg-card px-3.5 py-3">
          <h2 className="mb-1.5 text-xs text-muted-foreground">{text.facts}</h2>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{text.lastMeeting}</dt>
            <dd className="min-w-0 break-words">
              {data.lastMeeting ? date(data.lastMeeting.scheduled_at_ms) : text.noLastMeeting}
            </dd>
            <dt className="text-muted-foreground">{text.ownerDecisions}</dt>
            <dd className="min-w-0 break-words">
              {data.ownerDecisions.length ? data.ownerDecisions.join(" · ") : text.noOwnerDecisions}
            </dd>
            <dt className="text-muted-foreground">{text.links}</dt>
            <dd className="min-w-0">
              {data.links.length ? (
                <span className="flex flex-wrap gap-x-3">
                  {data.links.map((link) => (
                    <a
                      key={link.url}
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-words text-primary [overflow-wrap:anywhere]"
                    >
                      {link.label} ↗
                    </a>
                  ))}
                </span>
              ) : (
                text.noLinks
              )}
            </dd>
          </dl>
        </section>
      </aside>
    </main>
  );
}
function Heading({ id, children }: { readonly id: string; readonly children: ReactNode }) {
  return (
    <h2
      id={id}
      className="mb-2 flex flex-wrap items-baseline text-xs font-medium tracking-wide text-muted-foreground uppercase"
    >
      {children}
    </h2>
  );
}
