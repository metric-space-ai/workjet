import { useEffect, useState, type ReactNode } from "react";
import { SupervisorTickStatus } from "./SupervisorTickStatus";
import { scopeThreadRef } from "@workjet/client-runtime/environment";
import type { ScopedThreadRef } from "@workjet/contracts";
import {
  projectOverviewFormat,
  projectOverviewSessionError,
  type ProjectOverviewLanguage,
} from "../projectOverviewText";
import {
  projectOverviewStatusTone,
  projectOverviewWorkerName,
  projectOverviewWorkerState,
  type ProjectOverviewStatus,
  type ProjectOwnerOverview,
} from "../projectOverviewModel";
import {
  ArrowUpRightIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useClientSettings } from "../hooks/useSettings";
import { Button } from "./ui/button";

const toneClasses: Record<string, string> = {
  red: "border-red-500/40 text-red-400",
  blue: "border-blue-500/40 text-blue-300",
  amber: "border-amber-500/40 text-amber-400",
  green: "border-emerald-500/40 text-emerald-400",
  gray: "border-border text-muted-foreground",
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

/** Beitreten frühestens fünf Minuten vor dem geplanten Beginn. */
export const JOUR_FIXE_JOIN_LEAD_MS = 5 * 60_000;
/** Am Termintag bleibt der Knopf nach dem Beginn offen; die Wiederholung zählt erst danach weiter. */
const MEETING_DAY_WINDOW_MS = 12 * 3_600_000;

/** Minutentakt für die Zeitsperre des Beitreten-Knopfs. */
function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function zonedDay(timeZone: string, now: number): { date: string; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const value = (key: string) => Number(parts.find((part) => part.type === key)?.value);
  const day = new Date(Date.UTC(value("year"), value("month") - 1, value("day")));
  return {
    date: `${value("year")}-${String(value("month")).padStart(2, "0")}-${String(value("day")).padStart(2, "0")}`,
    weekday: day.getUTCDay() || 7,
  };
}

/** Kalendertag plus Uhrzeit in der Terminzone als UTC-Zeitpunkt (zwei Iterationen für Sommerzeit). */
function zonedStartMs(date: string, time: string, timeZone: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const guess = Date.UTC(year!, month! - 1, day!, hour, minute);
  let ms = guess;
  for (let round = 0; round < 2; round += 1) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const value = (key: string) => Number(parts.find((part) => part.type === key)?.value);
    const shown = Date.UTC(
      value("year"),
      value("month") - 1,
      value("day"),
      value("hour"),
      value("minute"),
    );
    ms = ms - (shown - guess);
  }
  return ms;
}

type JourFixeRecurring = NonNullable<ProjectOwnerOverview["recurring"]>;

/** Vor Beginn − 5 min zeigt der Knopf nur die Uhrzeit; danach ist er am Termintag aktiv. */
export function jourFixeJoinLocked(
  recurring: JourFixeRecurring | null,
  nextMeetingDate: string | null,
  now: number,
): boolean {
  if (!recurring) return false;
  const today = zonedDay(recurring.timezone, now);
  if (today.weekday === recurring.weekday) {
    const startToday = zonedStartMs(today.date, recurring.time, recurring.timezone);
    if (now >= startToday - JOUR_FIXE_JOIN_LEAD_MS && now <= startToday + MEETING_DAY_WINDOW_MS)
      return false;
  }
  if (nextMeetingDate === null) return false;
  return (
    now < zonedStartMs(nextMeetingDate, recurring.time, recurring.timezone) - JOUR_FIXE_JOIN_LEAD_MS
  );
}
export function ProjectOverviewView(props: {
  readonly data: ProjectOwnerOverview;
  readonly onOpenChat: (ref: ScopedThreadRef) => void;
  readonly onOpenJourFixe?: (() => void) | undefined;
  readonly decisions?: ReactNode;
  readonly connectionError?: boolean;
  /** Why the overview data is missing (core outdated, timeout …), if known. */
  readonly connectionMessage?: string | null;
  readonly actions?: ReactNode;
  readonly onRecomputeKpis?: (() => void) | undefined;
}) {
  const { data, onOpenChat } = props;
  const { text, language } = data;
  const locale = localeOf(language);
  const now = useMinuteNow();
  const joinLocked = jourFixeJoinLocked(data.recurring, data.nextMeetingDate, now);
  const weekday = data.recurring
    ? new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(
        new Date(Date.UTC(2026, 0, 4 + data.recurring.weekday)),
      )
    : null;
  const open = (thread: (typeof data.members)[number]) =>
    onOpenChat(scopeThreadRef(thread.environmentId, thread.id));
  const developerMode = useClientSettings((settings) => settings.developerMode);
  const missingKpis = data.kpis.every((kpi) => kpi.value === "—");
  const feed = buildFeed(data, now);
  const live = [...data.supervisors, ...data.parents, ...data.workers].flatMap((thread) => {
    const state = projectOverviewWorkerState(thread);
    return state === "waiting" ? [] : [{ thread, state }];
  });
  return (
    <main
      className="mx-auto grid w-full max-w-[1100px] min-w-0 items-start gap-5 p-4 text-[13.5px] sm:p-6 lg:grid-cols-[minmax(0,1fr)_280px]"
      data-workjet-project-overview={data.projectId}
      lang={language}
    >
      <div className="min-w-0 space-y-3">
        <header>
          <h1 className="break-words text-[22px] font-semibold tracking-tight">{data.title}</h1>
          {data.summary !== null && (
            <p className="mt-1 text-[13.5px] leading-6 text-muted-foreground">{data.summary}</p>
          )}
          {developerMode && (
            <SupervisorTickStatus {...data.supervisorTick} language={language} text={text} />
          )}
        </header>
        {props.connectionError && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
            <span className="size-1.5 shrink-0 rounded-full bg-amber-400" />
            {props.connectionMessage ?? text.unavailableConnection}
          </p>
        )}
        {data.decisions.length > 0 && props.decisions && (
          <section
            data-workjet-overview-section="decisions"
            aria-label={text.needsYou}
            className="rounded-lg border border-blue-500/30 bg-blue-500/5 px-3 py-2.5"
          >
            <h2 className="mb-2 text-xs font-medium text-muted-foreground">{text.needsYou}</h2>
            {props.decisions}
          </section>
        )}
        <FeedSection feed={feed} text={text} locale={locale} now={now} open={open} />
      </div>
      <aside className="min-w-0 space-y-3">
        <section
          className="rounded-lg border border-border bg-card px-3.5 py-3"
          data-workjet-overview-section="live"
        >
          <h2 className="mb-1.5 text-xs text-muted-foreground">{text.liveTitle}</h2>
          {live.length === 0 ? (
            <p className="text-xs text-muted-foreground">{text.liveEmpty}</p>
          ) : (
            <ul className="space-y-1">
              {live.map(({ thread, state }) => (
                <li key={thread.id}>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="h-auto w-full justify-start gap-2 px-1 py-1 text-left whitespace-normal"
                    onClick={() => open(thread)}
                  >
                    <span
                      aria-hidden
                      className={
                        "size-1.5 shrink-0 rounded-full " +
                        (state === "running"
                          ? "bg-emerald-400"
                          : state === "disrupted"
                            ? "bg-red-400"
                            : "bg-amber-400")
                      }
                    />
                    <span className="min-w-0 flex-1 break-words">
                      {localizedWorkerName(
                        projectOverviewWorkerName(thread.title, data.title).name,
                        language,
                      )}
                    </span>
                    <span className="text-muted-foreground">{text[state]}</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="rounded-lg border border-border bg-card px-3.5 py-3">
          <h2 className="text-xs text-muted-foreground">{text.nextMeeting}</h2>
          {data.recurring && weekday !== null ? (
            <p className="mt-1 font-semibold">
              {weekday} · {data.recurring.time}
              <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                {data.recurring.timezone}
              </span>
            </p>
          ) : (
            <p className="mt-1 text-muted-foreground">{text.noNextMeeting}</p>
          )}
          <Button
            size="xs"
            className="mt-2.5"
            onClick={props.onOpenJourFixe}
            disabled={!props.onOpenJourFixe || joinLocked}
            data-workjet-action="project.jour-fixe.open"
          >
            {joinLocked && data.recurring ? data.recurring.time : text.join}
          </Button>
          {!props.onOpenJourFixe ? (
            <p className="mt-1 text-xs text-muted-foreground">{text.meetingConnectionRequired}</p>
          ) : null}
        </section>
        <section
          className="rounded-lg border border-border bg-card px-3.5 py-3"
          data-workjet-overview-section="kpis"
        >
          <h2 className="mb-1.5 text-xs text-muted-foreground">{text.metrics}</h2>
          {missingKpis ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{text.kpisMissing}</p>
              {props.onRecomputeKpis ? (
                <Button size="xs" variant="outline" onClick={props.onRecomputeKpis}>
                  <RefreshCwIcon aria-hidden className="size-3.5" />
                  {text.recompute}
                </Button>
              ) : null}
            </div>
          ) : (
            <dl
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 text-xs"
              data-workjet-overview-kpis=""
            >
              {data.kpis
                .filter((kpi) => kpi.value !== "—")
                .map((kpi) => (
                  <div key={kpi.id} className="contents" data-workjet-overview-kpi={kpi.id}>
                    <dt className="min-w-0 break-words text-muted-foreground">
                      {kpi.label}
                      {kpi.note !== null && (
                        <span className="block text-[11px] text-amber-400">{kpi.note}</span>
                      )}
                    </dt>
                    <dd className="text-right font-semibold tabular-nums">{kpi.value}</dd>
                  </div>
                ))}
            </dl>
          )}
        </section>
        {data.goals.length === 0 ? null : (
          <section
            className="rounded-lg border border-border bg-card px-3.5 py-3"
            data-workjet-overview-section="goals"
          >
            <h2 className="mb-1.5 text-xs text-muted-foreground">{text.goals}</h2>
            {data.goals.length === 0 ? (
              <p className="text-xs text-muted-foreground">{text.noGoals}</p>
            ) : (
              <ul className="space-y-2 text-xs">
                {data.goals.map((goal) => (
                  <li key={goal.id} className="min-w-0">
                    <p className="line-clamp-2 break-words text-foreground">{goal.title}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
                      <span>{text.who}:</span>
                      {goal.thread ? (
                        <Button
                          variant="ghost"
                          size="xs"
                          className="h-auto p-0 text-xs"
                          onClick={() => open(goal.thread!)}
                        >
                          {goal.owner}
                        </Button>
                      ) : (
                        <span>{goal.owner}</span>
                      )}
                      <span>· {text.status}:</span>
                      <StatusChip status={goal.status} label={goal.state} />
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {props.actions ? (
          <section className="rounded-lg border border-border bg-card px-3.5 py-3">
            <h2 className="mb-1.5 text-xs text-muted-foreground">{text.projectActions}</h2>
            <div className="flex flex-wrap items-center gap-2">{props.actions}</div>
          </section>
        ) : null}
        {data.links.length ? (
          <div className="flex flex-wrap gap-1.5 px-1">
            {data.links.map((link) => (
              <Button
                key={link.url}
                variant="outline"
                size="xs"
                render={<a href={link.url} target="_blank" rel="noopener noreferrer" />}
              >
                {link.label}
                <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
              </Button>
            ))}
          </div>
        ) : null}
      </aside>
    </main>
  );
}

type FeedItem = {
  readonly id: string;
  readonly at: string;
  readonly author: string;
  readonly harness: string | null;
  readonly body: string;
  readonly tone: "normal" | "disrupted" | "waiting";
  readonly kind:
    | "disruption"
    | "escalation"
    | "goal"
    | "pr"
    | "step"
    | "meeting"
    | "setup"
    | "session";
  readonly badge: string | null;
  readonly thread: ProjectOwnerOverview["members"][number] | undefined;
  readonly url: string | undefined;
};

function buildFeed(data: ProjectOwnerOverview, now: number): FeedItem[] {
  const { text } = data;
  const nowIso = new Date(now).toISOString();
  const threadAt = (thread: ProjectOwnerOverview["members"][number]) =>
    thread.latestTurn?.completedAt ?? thread.latestTurn?.startedAt ?? thread.createdAt ?? nowIso;
  const who = (thread: ProjectOwnerOverview["members"][number]) => {
    const name = projectOverviewWorkerName(thread.title, data.title);
    return {
      author: localizedWorkerName(name.name, data.language),
      harness: name.harness ?? thread.session?.providerName ?? null,
    };
  };
  const items: FeedItem[] = [];
  for (const thread of data.disruptions) {
    const error = thread.session?.lastError;
    items.push({
      id: `disruption:${thread.id}`,
      at: threadAt(thread),
      ...who(thread),
      body: error ? projectOverviewSessionError(error, data.language).text : text.disrupted,
      tone: "disrupted",
      kind: "disruption",
      badge: text.feedDisruption,
      thread,
      url: undefined,
    });
  }
  for (const thread of data.escalations) {
    items.push({
      id: `escalation:${thread.id}`,
      at: threadAt(thread),
      ...who(thread),
      body: projectOverviewFormat(text.escalationLine, {
        name: who(thread).author,
        status: text[projectOverviewWorkerState(thread)],
      }),
      tone: "waiting",
      kind: "escalation",
      badge: null,
      thread,
      url: undefined,
    });
  }
  for (const goal of data.goals)
    if (goal.thread)
      items.push({
        id: `goal:${goal.id}`,
        at: threadAt(goal.thread),
        author: goal.owner,
        harness: goal.harness,
        body: projectOverviewFormat(text.feedGoal, { title: goal.title, state: goal.state }),
        tone: "normal",
        kind: "goal",
        badge: null,
        thread: goal.thread,
        url: undefined,
      });
  for (const event of data.feed)
    items.push({
      id: `event:${event.id}`,
      at: event.at,
      ...(event.thread ? who(event.thread) : { author: text.feedSystem, harness: null }),
      body: event.sentence,
      tone: "normal",
      kind: event.kind === "goal" ? "meeting" : event.kind,
      badge: null,
      thread: event.thread,
      url: event.url,
    });
  return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function localizedWorkerName(name: string, language: ProjectOverviewLanguage) {
  return language === "de" && /^project supervisor$/i.test(name) ? "Projekt-Supervisor" : name;
}

function relativeTime(at: string, now: number, locale: string) {
  const diff = (Date.parse(at) - now) / 1000;
  if (!Number.isFinite(diff)) return "";
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

type FeedTab = "top" | "latest" | "prs" | "sessions" | "disruptions";
const FEED_TABS: readonly FeedTab[] = ["top", "latest", "prs", "sessions", "disruptions"];

function FeedSection(props: {
  readonly feed: readonly FeedItem[];
  readonly text: ProjectOwnerOverview["text"];
  readonly locale: string;
  readonly now: number;
  readonly open: (thread: ProjectOwnerOverview["members"][number]) => void;
}) {
  const { text } = props;
  const [tab, setTab] = useState<FeedTab>("top");
  const [expandedThreads, setExpandedThreads] = useState<ReadonlySet<string>>(() => new Set());
  const label: Record<FeedTab, string> = {
    top: text.tabTop,
    latest: text.tabLatest,
    prs: text.tabPrs,
    sessions: text.tabSessions,
    disruptions: text.tabDisruptions,
  };
  const items =
    tab === "top"
      ? [...props.feed].sort((a, b) => weight(b) - weight(a))
      : tab === "latest"
        ? props.feed
        : tab === "prs"
          ? props.feed.filter((item) => item.kind === "pr")
          : tab === "sessions"
            ? props.feed.filter((item) => item.kind === "session")
            : props.feed.filter((item) => item.kind === "disruption" || item.kind === "escalation");
  // Related cards (same chat) form one thread: first card shows, the rest on request.
  const groups: FeedItem[][] = [];
  for (const item of items) {
    const key = item.thread?.id;
    const last = groups.at(-1);
    if (key && last && last[0]!.thread?.id === key) last.push(item);
    else groups.push([item]);
  }
  return (
    <section
      data-workjet-overview-section="feed"
      aria-label={text.feedTitle}
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      <div role="tablist" aria-label={text.feedTitle} className="flex border-b border-border">
        {FEED_TABS.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={
              "flex-1 px-2 py-2.5 text-xs font-medium transition-colors " +
              (tab === value
                ? "border-b-2 border-primary text-foreground"
                : "border-b-2 border-transparent text-muted-foreground hover:text-foreground")
            }
          >
            {label[value]}
          </button>
        ))}
      </div>
      {groups.length === 0 ? (
        <p className="px-3.5 py-4 text-muted-foreground">
          {props.feed.length === 0
            ? text.feedEmpty
            : tab === "sessions"
              ? text.sessionsEmpty
              : text.tabEmpty}
        </p>
      ) : (
        <ol className="divide-y divide-border">
          {groups.map((group) => {
            const id = group[0]!.id;
            const expanded = expandedThreads.has(id);
            const shown = expanded ? group : group.slice(0, 1);
            return (
              <li key={id} className="py-1">
                <ol>
                  {shown.map((item, index) => (
                    <FeedCard
                      key={item.id}
                      item={item}
                      text={text}
                      locale={props.locale}
                      now={props.now}
                      threadLine={index < shown.length - 1 || (group.length > 1 && !expanded)}
                      onOpen={item.thread ? () => props.open(item.thread!) : undefined}
                    />
                  ))}
                </ol>
                {group.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="ml-[3.6rem] h-auto p-0 pb-2"
                    aria-expanded={expanded}
                    onClick={() =>
                      setExpandedThreads((current) => {
                        const next = new Set(current);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return next;
                      })
                    }
                  >
                    {expanded ? text.hideThread : `${text.showThread} (${group.length})`}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function weight(item: FeedItem) {
  const base =
    item.kind === "disruption"
      ? 5
      : item.kind === "escalation"
        ? 4
        : item.kind === "pr"
          ? 3
          : item.kind === "meeting" || item.kind === "goal"
            ? 2
            : 1;
  return base * 1e13 + Date.parse(item.at);
}

function FeedCard(props: {
  readonly threadLine: boolean;
  readonly item: FeedItem;
  readonly text: ProjectOwnerOverview["text"];
  readonly locale: string;
  readonly now: number;
  readonly onOpen: (() => void) | undefined;
}) {
  const { item, text } = props;
  const [expanded, setExpanded] = useState(false);
  const long = item.body.length > 220;
  const initial =
    item.author
      .split(/[\s-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("") || "·";
  return (
    <li
      className="relative flex gap-3 px-3.5 py-2.5"
      data-workjet-feed-item={item.id}
      data-workjet-feed-tone={item.tone}
    >
      <span
        aria-hidden
        className={
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold " +
          (item.tone === "disrupted"
            ? "bg-red-500/15 text-red-400"
            : item.tone === "waiting"
              ? "bg-amber-500/15 text-amber-400"
              : "bg-muted text-muted-foreground")
        }
      >
        {initial}
      </span>
      {props.threadLine ? (
        <span aria-hidden className="absolute top-12 bottom-0 left-[1.85rem] w-px bg-border" />
      ) : null}
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
          <span className="font-semibold text-[13.5px] text-foreground">{item.author}</span>
          {item.harness ? <span className="text-muted-foreground">{item.harness}</span> : null}
          <span className="text-muted-foreground">·</span>
          <time dateTime={item.at} className="text-muted-foreground tabular-nums">
            {relativeTime(item.at, props.now, props.locale)}
          </time>
          {item.badge ? (
            <span className="rounded-full border border-red-500/40 px-1.5 text-[11px] text-red-400">
              {item.badge}
            </span>
          ) : null}
        </p>
        <p className="mt-0.5 break-words leading-5 whitespace-pre-line [overflow-wrap:anywhere]">
          {long && !expanded ? `${item.body.slice(0, 220).trimEnd()}…` : item.body}
          {long ? (
            <Button
              variant="ghost"
              size="xs"
              className="ml-1 h-auto p-0 align-baseline"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? text.feedLess : text.feedMore}
            </Button>
          ) : null}
        </p>
        {props.onOpen || item.url ? (
          <div className="mt-1.5 flex flex-wrap gap-2">
            {props.onOpen ? (
              <Button size="xs" variant="outline" onClick={props.onOpen}>
                <MessageSquareIcon aria-hidden className="size-3.5" />
                {item.kind === "disruption" || item.kind === "escalation"
                  ? text.openChat
                  : text.chipSession}
              </Button>
            ) : null}
            {item.url ? (
              <Button
                size="xs"
                variant="outline"
                render={<a href={item.url} target="_blank" rel="noopener noreferrer" />}
              >
                <GitPullRequestIcon aria-hidden className="size-3.5" />
                {text.feedOpenPr}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
