import { useEffect, useRef, useState, type ReactNode } from "react";
import { SupervisorTickStatus } from "./SupervisorTickStatus";
import { scopeThreadRef } from "@workjet/client-runtime/environment";
import type { ScopedThreadRef } from "@workjet/contracts";
import { projectOverviewFormat, type ProjectOverviewLanguage } from "../projectOverviewText";
import {
  projectOverviewAttentionRank,
  projectOverviewSideSections,
  projectOverviewStatusTone,
  projectOverviewWorkerName,
  projectOverviewWorkerState,
  sortByAttention,
  type ProjectOverviewSideSection,
  type ProjectOverviewStatus,
  type ProjectOwnerOverview,
} from "../projectOverviewModel";
import { BookmarkIcon, GitPullRequestIcon, MessageSquareIcon, RefreshCwIcon } from "lucide-react";
import {
  ctoxPostContent,
  disruptionContent,
  mergedPrContent,
  runningContent,
  stepContent,
  type CtoxProjectFeedPost,
  type ProjectFeedSource,
} from "../projectFeedContent";
import { useClientSettings } from "../hooks/useSettings";
import { plainPreview } from "../projectFeedContent";
import {
  FeedSettingsButton,
  FeedSettingsSheet,
  useFeedPreferences,
  type FeedPersistence,
  type FeedSourceKey,
  type FeedSourceRow,
} from "./ProjectFeedSettings";
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

/** Pause before the n-th silent re-read: 15 s, 30 s, 60 s … capped at five minutes. */
export function silentRetryDelayMs(attempt: number): number {
  return Math.min(15_000 * 2 ** attempt, 300_000);
}

/** A failed read is retried quietly in the background; the overview shows no status line. */
function useSilentRetry(failed: boolean, retry: (() => void) | undefined) {
  const attempt = useRef(0);
  useEffect(() => {
    if (!failed) {
      attempt.current = 0;
      return;
    }
    if (!retry) return;
    const timer = setTimeout(() => {
      attempt.current += 1;
      retry();
    }, silentRetryDelayMs(attempt.current));
    return () => clearTimeout(timer);
  }, [failed, retry]);
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
  /** Why the overview data is missing (core outdated, timeout …); diagnostics only, never shown. */
  readonly connectionMessage?: string | null;
  readonly feedPosts?: readonly CtoxProjectFeedPost[];
  readonly onRecomputeKpis?: (() => void) | undefined;
  /** Shortcuts into the project's settings pages (instant save + undo live there). */
  readonly settingsLinks?: readonly { readonly label: string; readonly onClick: () => void }[];
  /** Where feed settings are saved (CTOX instance per project, else this device). */
  readonly feedPersistence?: FeedPersistence;
  readonly instanceName?: string | null;
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
  const allFeed = buildFeed(data, now, props.feedPosts);
  const { prefs, change, undo, revert, saved } = useFeedPreferences(
    data.projectId,
    props.feedPersistence,
  );
  const windowStart = prefs.windowDays === null ? null : now - prefs.windowDays * 86_400_000;
  const feed = allFeed.filter(
    (item) =>
      prefs.sources[feedSourceOf(item.kind)] &&
      (windowStart === null || Date.parse(item.at) >= windowStart),
  );
  // Zustellung: desktop alert for disruptions that appear while the overview is open.
  const seenDisruptions = useRef<Set<string> | null>(null);
  useEffect(() => {
    const ids = allFeed.filter((item) => item.kind === "disruption").map((item) => item.id);
    if (seenDisruptions.current === null) {
      seenDisruptions.current = new Set(ids);
      return;
    }
    for (const id of ids) {
      if (seenDisruptions.current.has(id)) continue;
      seenDisruptions.current.add(id);
      const item = allFeed.find((entry) => entry.id === id);
      if (
        prefs.notifyDisruptions &&
        item &&
        typeof Notification !== "undefined" &&
        Notification.permission === "granted"
      )
        new Notification(item.headline ?? item.author, { body: item.body.slice(0, 180) });
    }
  });
  useSilentRetry(props.connectionError === true, props.onRecomputeKpis);
  const [tab, setTab] = useState<FeedTab>(prefs.defaultTab);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [marks, toggleMark] = useFeedBookmarks();
  const countOf = (key: FeedSourceKey) =>
    allFeed.filter((item) => feedSourceOf(item.kind) === key).length;
  // One row per worker and state: several chats of the same worker in the same state are one entry.
  const liveSeen = new Set<string>();
  const live = sortByAttention(
    [...data.supervisors, ...data.parents, ...data.workers].flatMap((thread) => {
      const state = projectOverviewWorkerState(thread, now);
      const key = `${projectOverviewWorkerName(thread.title, data.title).name}\u0000${state}`;
      if (state === "waiting" || liveSeen.has(key)) return [];
      liveSeen.add(key);
      return [{ thread, state }];
    }),
    (row) => projectOverviewAttentionRank(row.state),
  );
  const de = language === "de";
  const card = "rounded-2xl bg-muted/50 px-4 py-3";
  // One entry per goal text; several owners of the same goal sit under it.
  const goalGroups: { title: string; goals: (typeof data.goals)[number][] }[] = [];
  for (const goal of data.goals) {
    const group = goalGroups.find((entry) => entry.title === goal.title);
    if (group?.goals.some((entry) => entry.owner === goal.owner && entry.state === goal.state))
      continue;
    if (group) group.goals.push(goal);
    else goalGroups.push({ title: goal.title, goals: [goal] });
  }
  // Goals that need the owner (disrupted, stuck) lead the list.
  const sortedGoalGroups = sortByAttention(goalGroups, (group) =>
    Math.min(...group.goals.map((goal) => projectOverviewAttentionRank(goal.status))),
  );
  const weekdayShort = data.recurring
    ? new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" })
        .format(new Date(Date.UTC(2026, 0, 4 + data.recurring.weekday)))
        .replace(/\.$/u, "")
    : null;
  const localTimeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const canJoin = props.onOpenJourFixe !== undefined && !joinLocked;
  const sideSection: Record<ProjectOverviewSideSection, ReactNode> = {
    live: (
      <section key="live" className={card} data-workjet-overview-section="live">
        <h3 className="mb-2 text-[15px] font-bold text-foreground">{text.liveTitle}</h3>
        <ul className="divide-y divide-border/60">
          {live.map(({ thread, state }) => (
            <li key={thread.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 py-2 text-left text-[14px] hover:text-foreground"
                onClick={() => open(thread)}
                data-workjet-overview-live={state}
              >
                <span
                  aria-hidden
                  className={
                    "size-2 shrink-0 rounded-full " +
                    (state === "running"
                      ? "bg-emerald-400"
                      : state === "disrupted" || state === "stuck"
                        ? "bg-red-400"
                        : "bg-amber-400")
                  }
                />
                <span className="min-w-0 flex-1 break-words font-semibold">
                  {localizedWorkerName(
                    projectOverviewWorkerName(thread.title, data.title).name,
                    language,
                  )}
                </span>
                <span
                  className={
                    "text-[13px] " +
                    (state === "disrupted" || state === "stuck"
                      ? "text-red-400"
                      : "text-muted-foreground")
                  }
                >
                  {text[state]}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    ),
    goals: (
      <section key="goals" className={card} data-workjet-overview-section="goals">
        <h3 className="mb-2 text-[15px] font-bold text-foreground">{text.goals}</h3>
        <ul className="space-y-2 text-[13px]">
          {sortedGoalGroups.map((group) => (
            <li key={group.title} className="min-w-0" data-workjet-overview-goal="">
              <p className="line-clamp-2 break-words font-semibold text-foreground">
                {group.title}
              </p>
              {group.goals.map((goal) => (
                <p
                  key={goal.id}
                  className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-muted-foreground"
                >
                  {goal.thread ? (
                    <button
                      type="button"
                      className="hover:text-foreground"
                      onClick={() => open(goal.thread!)}
                    >
                      {goal.owner}
                    </button>
                  ) : (
                    <span>{goal.owner}</span>
                  )}
                  <StatusChip status={goal.status} label={goal.state} />
                </p>
              ))}
            </li>
          ))}
        </ul>
      </section>
    ),
    kpis: (
      <section key="kpis" className={card} data-workjet-overview-section="kpis">
        <h3 className="mb-2 text-[15px] font-bold text-foreground">{text.metrics}</h3>
        {missingKpis ? (
          <Button size="xs" variant="outline" onClick={props.onRecomputeKpis}>
            <RefreshCwIcon aria-hidden className="size-3.5" />
            {text.recompute}
          </Button>
        ) : (
          <dl
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 text-[14px]"
            data-workjet-overview-kpis=""
          >
            {data.kpis
              .filter((kpi) => kpi.value !== "—")
              .map((kpi) => (
                <div key={kpi.id} className="contents" data-workjet-overview-kpi={kpi.id}>
                  <dt className="min-w-0 break-words text-muted-foreground">
                    {kpi.label}
                    {kpi.note !== null && (
                      <span className="block text-[12px] text-amber-400">{kpi.note}</span>
                    )}
                  </dt>
                  <dd className="text-right font-bold tabular-nums">{kpi.value}</dd>
                </div>
              ))}
          </dl>
        )}
      </section>
    ),
    meeting: (
      <section
        key="meeting"
        className={card + " flex flex-wrap items-center gap-x-3 gap-y-2"}
        data-workjet-overview-section="meeting"
      >
        {data.recurring && weekdayShort !== null ? (
          <p className="min-w-0 flex-1 text-[14px]">
            <span className="font-bold text-foreground">{text.nextMeeting}</span>
            {" · "}
            <span className="font-semibold tabular-nums">
              {weekdayShort} {data.recurring.time}
            </span>
            {data.recurring.timezone !== localTimeZone ? (
              <span className="text-muted-foreground"> · {data.recurring.timezone}</span>
            ) : null}
          </p>
        ) : null}
        {canJoin ? (
          <Button
            size="sm"
            className="rounded-full"
            onClick={props.onOpenJourFixe}
            data-workjet-action="project.jour-fixe.open"
          >
            {text.join}
          </Button>
        ) : null}
      </section>
    ),
  };
  const sideOrder = projectOverviewSideSections({
    live: live.length > 0,
    goals: sortedGoalGroups.length > 0,
    kpis: !(missingKpis && !props.onRecomputeKpis),
    meeting: data.recurring !== null || canJoin,
  });
  const workerNames = [...data.parents, ...data.workers].map((thread) =>
    localizedWorkerName(projectOverviewWorkerName(thread.title, data.title).name, language),
  );
  const repo = data.links.find((link) => /github\.com/.test(link.url));
  const sourceRows: FeedSourceRow[] = [
    {
      key: "disruptions",
      group: "CTOX",
      name: de ? "Störungen & Rückfragen" : "Disruptions & questions",
      badge: "!",
      badgeColor: "bg-red-600",
      count: countOf("disruptions"),
      chips: [],
    },
    {
      key: "results",
      group: "CTOX",
      name: de ? "Worker-Ergebnisse & Ziele" : "Worker results & goals",
      badge: "W",
      badgeColor: "bg-blue-600",
      count: countOf("results"),
      chips: workerNames.slice(0, 6),
    },
    {
      key: "sessions",
      group: "CTOX",
      name: de ? "Sitzungen" : "Sessions",
      badge: "S",
      badgeColor: "bg-teal-600",
      count: countOf("sessions"),
      chips: [],
    },
    {
      key: "meeting",
      group: "CTOX",
      name: de ? "Regeltermin & Entscheidungen" : "Standing meeting & decisions",
      badge: "RT",
      badgeColor: "bg-violet-600",
      count: countOf("meeting"),
      chips: data.recurring && weekday ? [`${weekday} · ${data.recurring.time}`] : [],
    },
    {
      key: "setup",
      group: "CTOX",
      name: de ? "Projekt-Setup" : "Project setup",
      badge: "P",
      badgeColor: "bg-emerald-600",
      count: countOf("setup"),
      chips: [],
    },
    {
      key: "prs",
      group: "GitHub",
      name: de ? "Gemergte Pull Requests" : "Merged pull requests",
      badge: "GH",
      badgeColor: "bg-zinc-700",
      count: countOf("prs"),
      chips: repo ? [repo.url.replace(/^https:\/\/github\.com\//, "")] : [],
      note: repo
        ? null
        : de
          ? "Kein Repository verknüpft – PRs erscheinen, sobald eins verknüpft ist."
          : "No repository linked – PRs appear once one is linked.",
      action: props.settingsLinks?.[0]
        ? { label: de ? "Verknüpfen" : "Link", onClick: props.settingsLinks[0].onClick }
        : null,
    },
  ];
  return (
    <main
      className="relative flex h-full min-h-0 w-full min-w-0 flex-col items-center gap-4 text-[15px] lg:flex-row lg:items-stretch lg:justify-center lg:gap-3 lg:overflow-hidden lg:px-3"
      data-workjet-project-overview={data.projectId}
      lang={language}
    >
      <div
        className="flex min-h-[70vh] w-full max-w-[600px] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card lg:my-3 lg:min-h-0 lg:overflow-y-auto"
        data-workjet-overview-column="feed"
      >
        <FeedSection
          feed={feed}
          tab={tab}
          onTab={setTab}
          marks={marks}
          onToggleMark={toggleMark}
          onOpenSettings={() => setSettingsOpen(true)}
          threadMode={prefs.replies}
          fullBody={prefs.body === "full"}
          language={language}
          text={text}
          locale={locale}
          now={now}
          open={open}
          header={
            <div className="px-4 pt-3 pb-1">
              <h1 className="break-words text-[20px] font-bold tracking-tight">
                {prefs.title ?? data.title}
              </h1>
              {data.summary !== null && (
                <p className="mt-0.5 text-[14px] leading-5 text-muted-foreground">{data.summary}</p>
              )}
              {developerMode && (
                <SupervisorTickStatus {...data.supervisorTick} language={language} text={text} />
              )}
            </div>
          }
          decisions={
            data.decisions.length > 0 && props.decisions ? (
              <section
                data-workjet-overview-section="decisions"
                aria-label={text.needsYou}
                className="mx-4 my-3 rounded-2xl border border-blue-500/30 bg-blue-500/5 px-4 py-3"
              >
                <h2 className="mb-2 text-[13px] font-semibold text-muted-foreground">
                  {text.needsYou}
                </h2>
                {props.decisions}
              </section>
            ) : null
          }
        />
      </div>
      {settingsOpen ? (
        <FeedSettingsSheet
          title={`Feed · ${prefs.title ?? data.title}`}
          projectTitle={data.title}
          saved={saved}
          instanceName={props.instanceName ?? null}
          meeting={
            data.recurring && weekday
              ? `${weekday} · ${data.recurring.time} (${data.recurring.timezone})`
              : null
          }
          onOpenMeetingSettings={props.settingsLinks?.[0]?.onClick}
          language={language}
          rows={sourceRows}
          prefs={prefs}
          onChange={change}
          undo={undo}
          onUndo={revert}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}
      <aside
        style={settingsOpen ? { display: "none" } : undefined}
        className="flex w-full max-w-[600px] shrink-0 flex-col gap-3 rounded-xl border border-border bg-card p-4 lg:my-3 lg:mr-3 lg:w-[320px] lg:self-start lg:overflow-y-auto"
        data-workjet-overview-column="side"
      >
        {sideOrder.map((section) => sideSection[section])}
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
  readonly headline?: string;
  readonly openItems?: readonly string[];
  readonly sources?: readonly ProjectFeedSource[];
  readonly actionLabel?: string | null;
  /** Raw error text; shown only behind "Details". */
  readonly details?: string | null;
  /** Further chats of the same worker with the same error, folded into this card. */
  readonly alsoThreads?: readonly ProjectOwnerOverview["members"][number][];
  /** Posts with the same key form one thread with a connecting line. */
  readonly groupKey?: string;
  /** Session excerpt shown as quote inside the preview card. */
  readonly excerpt?: string | null;
  /** Real preview image (GitHub's PR card image). */
  readonly image?: string | null;
  /** Diff size line, e.g. "+120 −30 · 4 Dateien". */
  readonly stats?: string | null;
};

export function feedSourceOf(kind: FeedItem["kind"]): FeedSourceKey {
  switch (kind) {
    case "disruption":
    case "escalation":
      return "disruptions";
    case "pr":
      return "prs";
    case "session":
      return "sessions";
    case "meeting":
      return "meeting";
    case "setup":
      return "setup";
    default:
      return "results";
  }
}

/** GitHub's rendered card image for a PR URL (owner/repo/pull/n), or null. */
export function githubPrImage(url: string | undefined): string | null {
  const match = url ? /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.exec(url) : null;
  return match
    ? `https://opengraph.githubassets.com/1/${match[1]}/${match[2]}/pull/${match[3]}`
    : null;
}

function diffStats(pr: ProjectOwnerOverview["merged"][number], de: boolean): string | null {
  if (pr.additions == null || pr.deletions == null) return null;
  const files =
    pr.changedFiles == null
      ? ""
      : ` · ${pr.changedFiles} ${de ? (pr.changedFiles === 1 ? "Datei" : "Dateien") : pr.changedFiles === 1 ? "file" : "files"}`;
  return `+${pr.additions} −${pr.deletions}${files}`;
}

function withPreviews(data: ProjectOwnerOverview, items: FeedItem[]): FeedItem[] {
  const de = data.language === "de";
  return items.map((item) => {
    if (item.kind === "pr") {
      const urls = [item.url, ...(item.sources ?? []).map((source) => source.url)];
      const pr = data.merged.find((entry) => urls.includes(entry.url));
      const url = pr?.url ?? urls.find((entry) => entry && githubPrImage(entry));
      return { ...item, image: githubPrImage(url), stats: pr ? diffStats(pr, de) : null };
    }
    if ((item.kind === "step" || item.kind === "session") && item.thread) {
      const excerpt = plainPreview(item.thread.latestAssistantMessagePreview, 240);
      return excerpt && excerpt !== item.body ? { ...item, excerpt } : item;
    }
    return item;
  });
}

function buildFeed(
  data: ProjectOwnerOverview,
  now: number,
  posts: readonly CtoxProjectFeedPost[] = [],
): FeedItem[] {
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
  // Same worker, same error: one card (#586).
  const disruptionCards = new Map<string, FeedItem>();
  for (const thread of data.disruptions) {
    const author = who(thread);
    const lastError = thread.session?.lastError ?? null;
    const key = `${author.author}\u0000${lastError?.trim() ?? ""}`;
    const existing = disruptionCards.get(key);
    if (existing) {
      const newer = Date.parse(threadAt(thread)) > Date.parse(existing.at);
      disruptionCards.set(key, {
        ...existing,
        ...(newer ? { at: threadAt(thread), thread } : {}),
        alsoThreads: [...(existing.alsoThreads ?? []), newer ? existing.thread! : thread],
      });
      continue;
    }
    disruptionCards.set(key, {
      id: `disruption:${thread.id}`,
      at: threadAt(thread),
      ...author,
      ...disruptionContent({ name: author.author, lastError, language: data.language }),
      tone: "disrupted",
      kind: "disruption",
      badge: text.feedDisruption,
      thread,
      url: undefined,
    });
  }
  items.push(...disruptionCards.values());
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
  for (const thread of [...data.supervisors, ...data.parents, ...data.workers])
    if (thread.planProgress && projectOverviewWorkerState(thread) === "running")
      items.push({
        id: `running:${thread.id}`,
        at: thread.latestTurn?.startedAt ?? nowIso,
        ...who(thread),
        ...runningContent({
          name: who(thread).author,
          step: thread.planProgress.step,
          done: thread.planProgress.completedSteps,
          total: thread.planProgress.totalSteps,
          language: data.language,
        }),
        tone: "normal",
        kind: "step",
        badge: null,
        thread,
        url: undefined,
      });
  for (const post of posts)
    items.push({
      id: `post:${post.post_id}`,
      at: new Date(post.occurred_at_ms).toISOString(),
      author: post.author_label,
      harness: post.harness,
      ...ctoxPostContent(post),
      tone: post.kind === "disruption" ? "disrupted" : "normal",
      kind:
        post.kind === "pr_merged"
          ? "pr"
          : post.kind === "disruption"
            ? "disruption"
            : post.kind === "session_completed"
              ? "session"
              : post.kind === "goal_changed"
                ? "goal"
                : "meeting",
      badge: post.kind === "disruption" ? text.feedDisruption : null,
      thread: post.author_thread
        ? data.members.find((member) => member.id === post.author_thread)
        : undefined,
      url: undefined,
    });
  const covered = new Set(posts.flatMap((post) => post.sources.map((source) => source.ref)));
  for (const event of data.feed) {
    if (event.url && covered.has(event.url)) continue;
    const pr =
      event.kind === "pr" ? data.merged.find((entry) => entry.url === event.url) : undefined;
    const goalOf =
      event.thread?.workjetConfig.schemaVersion === 2 ? event.thread.workjetConfig.goal : null;
    const content =
      pr !== undefined
        ? mergedPrContent({
            number: pr.number,
            title: pr.title,
            url: pr.url,
            body: pr.body ?? null,
            language: data.language,
          })
        : event.kind === "step" && event.thread
          ? stepContent({
              name: who(event.thread).author,
              preview: event.thread.latestAssistantMessagePreview,
              goal: goalOf?.objective ?? null,
              goalDone: goalOf?.status === "complete",
              language: data.language,
            })
          : null;
    // A finished step without a summary, "meeting completed" or "to-dos confirmed" carry no
    // readable content of their own; a post appears only with real content.
    if (content === null && event.kind !== "setup") continue;
    items.push({
      id: `event:${event.id}`,
      at: event.at,
      ...(event.thread
        ? who(event.thread)
        : pr?.author
          ? { author: pr.author, harness: "GitHub" }
          : { author: text.feedSystem, harness: null }),
      body: event.sentence,
      ...content,
      tone: "normal",
      kind: event.kind === "goal" ? "meeting" : event.kind,
      badge: null,
      thread: event.thread,
      url: content?.sources.some((source) => source.url === event.url) ? undefined : event.url,
    });
  }
  const supervisor = data.supervisors[0];
  for (const item of items)
    if (!item.groupKey && !item.thread && item.kind === "setup" && supervisor)
      (item as { groupKey?: string }).groupKey = supervisor.id;
  const shown = new Set([
    ...covered,
    ...items.flatMap((item) => [
      ...(item.url ? [item.url] : []),
      ...(item.sources ?? []).flatMap((source) => (source.url ? [source.url] : [])),
    ]),
  ]);
  for (const pr of data.merged) {
    if (shown.has(pr.url) || !pr.mergedAt || !Number.isFinite(Date.parse(pr.mergedAt))) continue;
    items.push({
      id: `pr:${pr.url}`,
      at: pr.mergedAt,
      author: pr.author ?? "GitHub",
      harness: "GitHub",
      ...mergedPrContent({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        body: pr.body ?? null,
        language: data.language,
      }),
      tone: "normal",
      kind: "pr",
      badge: null,
      thread: undefined,
      url: undefined,
    });
  }
  return withPreviews(data, items).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function localizedWorkerName(name: string, language: ProjectOverviewLanguage) {
  return language === "de" && /^project supervisor$/i.test(name) ? "Projekt-Supervisor" : name;
}

function relativeTime(at: string, now: number, locale: string) {
  // Server clocks run a few seconds ahead; a post is never "in 3 seconds".
  const diff = Math.min(0, (Date.parse(at) - now) / 1000);
  if (!Number.isFinite(diff)) return "";
  if (diff > -45) return locale.startsWith("de") ? "gerade eben" : "just now";
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86400), "day");
}

type FeedTab = "top" | "latest" | "prs" | "sessions" | "disruptions" | "saved";
const FEED_TABS: readonly FeedTab[] = ["top", "latest", "prs", "sessions", "disruptions", "saved"];

function filterTab(feed: readonly FeedItem[], tab: FeedTab, marks: ReadonlySet<string>) {
  switch (tab) {
    case "top":
      return [...feed].sort((a, b) => weight(b) - weight(a));
    case "latest":
      return [...feed];
    case "prs":
      return feed.filter((item) => item.kind === "pr");
    case "sessions":
      return feed.filter((item) => item.kind === "session" || item.kind === "step");
    case "disruptions":
      return feed.filter((item) => item.kind === "disruption" || item.kind === "escalation");
    case "saved":
      return feed.filter((item) => marks.has(item.id));
  }
}

const AVATAR_COLORS = [
  "bg-emerald-600",
  "bg-blue-600",
  "bg-orange-500",
  "bg-violet-600",
  "bg-pink-600",
  "bg-teal-600",
  "bg-amber-600",
];
function avatarColor(item: FeedItem) {
  if (item.tone === "disrupted") return "bg-red-600";
  let hash = 0;
  for (const char of item.author) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}
const SOURCE_COLORS: Record<ProjectFeedSource["type"], string> = {
  pr: "bg-emerald-500",
  commit: "bg-slate-400",
  session: "bg-blue-500",
  file: "bg-orange-500",
  meeting: "bg-violet-500",
  url: "bg-sky-500",
};
const BOOKMARKS_KEY = "workjet.overview.feed.bookmarks";
function useFeedBookmarks() {
  const [marks, setMarks] = useState<ReadonlySet<string>>(() => {
    try {
      return new Set(JSON.parse(globalThis.localStorage?.getItem(BOOKMARKS_KEY) ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const toggle = (id: string) =>
    setMarks((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        globalThis.localStorage?.setItem(BOOKMARKS_KEY, JSON.stringify([...next].slice(-200)));
      } catch {
        // Bookmarks are a local convenience; a full storage only loses the mark.
      }
      return next;
    });
  return [marks, toggle] as const;
}

function FeedSection(props: {
  readonly feed: readonly FeedItem[];
  readonly text: ProjectOwnerOverview["text"];
  readonly locale: string;
  readonly now: number;
  readonly open: (thread: ProjectOwnerOverview["members"][number]) => void;
  readonly header?: ReactNode;
  readonly decisions?: ReactNode;
  readonly tab: FeedTab;
  readonly onTab: (tab: FeedTab) => void;
  readonly marks: ReadonlySet<string>;
  readonly onToggleMark: (id: string) => void;
  readonly onOpenSettings: () => void;
  readonly threadMode: "three" | "all";
  readonly fullBody: boolean;
  readonly language: ProjectOverviewLanguage;
}) {
  const { text, tab, marks } = props;
  const setTab = props.onTab;
  const toggleMark = props.onToggleMark;
  const [expandedThreads, setExpandedThreads] = useState<ReadonlySet<string>>(() => new Set());
  const label: Record<FeedTab, string> = {
    top: text.tabTop,
    latest: text.tabLatest,
    prs: text.tabPrs,
    sessions: text.tabSessions,
    disruptions: text.tabDisruptions,
    saved: text.feedMarked,
  };
  const items = filterTab(props.feed, tab, marks);
  // One filter row: a tab appears only when it would show something (the current one stays).
  const visibleTabs = FEED_TABS.filter(
    (value) =>
      value === "top" ||
      value === "latest" ||
      value === tab ||
      filterTab(props.feed, value, marks).length > 0,
  );
  // Posts about the same chat (or the supervisor's setup) form one thread, ordered by the
  // first post's rank; follow-ups hang below it with a connecting line.
  const groupOf = new Map<string, FeedItem[]>();
  const groups: FeedItem[][] = [];
  for (const item of items) {
    const key = item.groupKey ?? item.thread?.id;
    const existing = key ? groupOf.get(key) : undefined;
    if (existing) existing.push(item);
    else {
      const group = [item];
      groups.push(group);
      if (key) groupOf.set(key, group);
    }
  }
  return (
    <section
      data-workjet-overview-section="feed"
      aria-label={text.feedTitle}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="sticky top-0 z-10 border-b border-border bg-card/90 backdrop-blur">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">{props.header}</div>
          <div className="pt-3 pr-3">
            <FeedSettingsButton language={props.language} onClick={props.onOpenSettings} />
          </div>
        </div>
        <div role="tablist" aria-label={text.feedTitle} className="flex overflow-x-auto">
          {visibleTabs.map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={
                "relative flex flex-1 shrink-0 justify-center px-3 py-3.5 text-[13.5px] whitespace-nowrap transition-colors hover:bg-muted/40 " +
                (tab === value ? "font-bold text-foreground" : "font-medium text-muted-foreground")
              }
            >
              <span className="relative">
                {label[value]}
                {tab === value ? (
                  <span
                    aria-hidden
                    className="absolute -inset-x-1 -bottom-3.5 h-1 rounded-full bg-blue-500"
                  />
                ) : null}
              </span>
            </button>
          ))}
        </div>
      </div>
      {props.decisions}
      <div className="min-h-0 flex-1">
        {groups.length === 0 ? (
          <p className="px-4 py-8 text-[15px] font-semibold text-muted-foreground">
            {props.feed.length === 0
              ? text.feedEmpty
              : tab === "saved"
                ? text.savedEmpty
                : tab === "sessions"
                  ? text.sessionsEmpty
                  : text.tabEmpty}
          </p>
        ) : (
          <ol>
            {groups.map((group) => {
              const id = group[0]!.id;
              const expanded = expandedThreads.has(id);
              const shown = expanded || props.threadMode === "all" ? group : group.slice(0, 3);
              return (
                <li key={id} className="border-b border-border pt-3">
                  <ol>
                    {shown.map((item, index) => (
                      <FeedCard
                        key={item.id}
                        item={item}
                        text={text}
                        locale={props.locale}
                        now={props.now}
                        replies={index === 0 ? group.length - 1 : 0}
                        fullBody={props.fullBody}
                        threadLine={index < shown.length - 1}
                        marked={marks.has(item.id)}
                        onToggleMark={() => toggleMark(item.id)}
                        onOpen={(() => {
                          const target = item.thread ?? group.find((entry) => entry.thread)?.thread;
                          return target ? () => props.open(target) : undefined;
                        })()}
                      />
                    ))}
                  </ol>
                  {group.length > 3 && props.threadMode !== "all" ? (
                    <Button
                      size="xs"
                      variant="outline"
                      className="mb-3 ml-[4.25rem]"
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
                      {expanded ? text.hideThread : text.showThread}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </div>
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

function sourceHost(url: string) {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function FeedCard(props: {
  readonly threadLine: boolean;
  readonly item: FeedItem;
  readonly text: ProjectOwnerOverview["text"];
  readonly locale: string;
  readonly now: number;
  readonly replies: number;
  readonly fullBody: boolean;
  readonly marked: boolean;
  readonly onToggleMark: () => void;
  readonly onOpen: (() => void) | undefined;
}) {
  const { item, text } = props;
  const [expanded, setExpanded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const long = !props.fullBody && item.body.length > 280;
  const initials =
    item.author
      .split(/[\s-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("") || "·";
  const linked = (item.sources ?? []).filter((source) => source.url);
  const preview = linked.find((source) => source.type === "pr") ?? linked[0];
  const chips = linked.filter((source) => source !== preview);
  const prUrl = item.url ?? (preview?.type === "pr" ? preview.url : undefined);
  const image = item.image && !imageFailed ? item.image : null;
  // A preview card appears only with real content: an image, a quote or a linked source.
  const hasCard = image !== null || Boolean(item.excerpt) || Boolean(preview?.url);
  const cardTitle = item.headline ?? preview?.label ?? null;
  const cardInner = (
    <>
      {image ? (
        <img
          src={image}
          alt=""
          loading="lazy"
          onError={() => setImageFailed(true)}
          className="block aspect-[2/1] w-full border-b border-border bg-muted object-cover"
        />
      ) : item.excerpt ? (
        <span className="block border-b border-border bg-muted/30 px-3 py-3 text-[13.5px] leading-5 text-foreground/85 italic">
          „{item.excerpt}“
        </span>
      ) : null}
      {preview?.url || cardTitle ? (
        <span className="block px-3 py-2.5">
          {preview?.url ? (
            <span className="block text-[12px] text-muted-foreground">
              {sourceHost(preview.url)}
              {item.stats ? (
                <span className="ml-2 font-mono text-[12px]">
                  <span className="text-emerald-400">{item.stats.split(" ")[0]}</span>{" "}
                  <span className="text-red-400">{item.stats.split(" ")[1]}</span>
                  {item.stats.split(" ").slice(2).join(" ")
                    ? " " + item.stats.split(" ").slice(2).join(" ")
                    : ""}
                </span>
              ) : null}
            </span>
          ) : null}
          {cardTitle ? (
            <span className="block text-[13.5px] break-words text-foreground">{cardTitle}</span>
          ) : null}
        </span>
      ) : null}
    </>
  );
  const cardClass =
    "mt-2 block w-full overflow-hidden rounded-xl border border-border text-left hover:bg-muted/20";
  return (
    <li
      className="relative flex gap-3 px-4"
      data-workjet-feed-item={item.id}
      data-workjet-feed-tone={item.tone}
    >
      <div className="flex w-10 shrink-0 flex-col items-center">
        <span
          aria-hidden
          className={
            "flex size-10 items-center justify-center rounded-full text-[13.5px] font-bold text-white " +
            avatarColor(item)
          }
        >
          {initials}
        </span>
        {props.threadLine ? (
          <span
            aria-hidden
            className="my-1 w-0.5 flex-1 rounded-full bg-muted-foreground/35"
            data-workjet-feed-threadline=""
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1 pb-3">
        <p className="flex flex-wrap items-baseline gap-x-1 text-[13.5px] leading-5">
          <span className="font-bold text-foreground">{item.author}</span>
          {item.harness ? <span className="text-muted-foreground">@{item.harness}</span> : null}
          <span className="text-muted-foreground">·</span>
          <time dateTime={item.at} className="text-muted-foreground tabular-nums">
            {relativeTime(item.at, props.now, props.locale)}
          </time>
          {item.badge ? (
            <span className="ml-1 rounded-full bg-red-500/15 px-2 py-px text-[11px] font-semibold text-red-400">
              {item.badge}
            </span>
          ) : null}
        </p>
        {item.headline && !hasCard ? (
          <p className="mt-1 text-[13.5px] font-semibold break-words text-foreground">
            {item.headline}
          </p>
        ) : null}
        {item.body ? (
          <p className="mt-1 text-[13.5px] break-words leading-[1.4] whitespace-pre-line text-foreground [overflow-wrap:anywhere]">
            {long && !expanded ? `${item.body.slice(0, 280).trimEnd()} …` : item.body}
          </p>
        ) : null}
        {long ? (
          <Button
            size="xs"
            variant="outline"
            className="mt-1"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? text.feedLess : text.feedMore}
          </Button>
        ) : null}
        {item.openItems && item.openItems.length > 0 ? (
          <ul className="mt-1 space-y-0.5 text-[13.5px] text-muted-foreground">
            {item.openItems.map((entry) => (
              <li key={entry}>
                {text.feedOpen}: {entry}
              </li>
            ))}
          </ul>
        ) : null}
        {!hasCard ? null : preview?.url ? (
          <a href={preview.url} target="_blank" rel="noopener noreferrer" className={cardClass}>
            {cardInner}
          </a>
        ) : props.onOpen ? (
          <button type="button" onClick={props.onOpen} className={cardClass}>
            {cardInner}
          </button>
        ) : (
          <div className={cardClass}>{cardInner}</div>
        )}
        {chips.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {chips.map((source) => (
              <a
                key={source.url}
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-[12px] text-foreground hover:bg-muted/70"
              >
                <span aria-hidden className={"size-2.5 rounded-sm " + SOURCE_COLORS[source.type]} />
                {source.label}
              </a>
            ))}
          </div>
        ) : null}
        {item.details ? (
          <details
            className="mt-1.5 text-[12px] text-muted-foreground"
            data-workjet-feed-details=""
          >
            <summary className="w-fit cursor-pointer select-none hover:text-foreground">
              {text.feedDetails}
            </summary>
            <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-muted/40 px-2 py-1.5 font-mono text-[12px] whitespace-pre-wrap [overflow-wrap:anywhere]">
              {item.details}
            </pre>
          </details>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {props.onOpen ? (
            <Button size="sm" variant="outline" onClick={props.onOpen}>
              <MessageSquareIcon aria-hidden className="size-3.5" />
              {item.actionLabel ?? text.openChat}
              {props.replies > 0 ? (
                <span className="text-muted-foreground tabular-nums">{props.replies}</span>
              ) : null}
            </Button>
          ) : null}
          {prUrl ? (
            <Button
              size="sm"
              variant="outline"
              render={<a href={prUrl} target="_blank" rel="noopener noreferrer" />}
            >
              <GitPullRequestIcon aria-hidden className="size-3.5" />
              {text.feedOpenPr}
            </Button>
          ) : null}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-pressed={props.marked}
            aria-label={props.marked ? text.feedMarked : text.feedMark}
            title={props.marked ? text.feedMarked : text.feedMark}
            onClick={props.onToggleMark}
            className={"ml-auto" + (props.marked ? " text-blue-400" : " text-muted-foreground")}
          >
            <BookmarkIcon
              aria-hidden
              className={"size-4" + (props.marked ? " fill-current" : "")}
            />
          </Button>
        </div>
      </div>
    </li>
  );
}
