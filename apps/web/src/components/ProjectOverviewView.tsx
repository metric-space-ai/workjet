import { useEffect, useState, type ReactNode } from "react";
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
import {
  ArrowUpRightIcon,
  BookmarkIcon,
  GitPullRequestIcon,
  LinkIcon,
  MessageSquareIcon,
  RefreshCwIcon,
} from "lucide-react";
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
  readonly feedPosts?: readonly CtoxProjectFeedPost[];
  readonly onRecomputeKpis?: (() => void) | undefined;
  /** Shortcuts into the project's settings pages (instant save + undo live there). */
  readonly settingsLinks?: readonly { readonly label: string; readonly onClick: () => void }[];
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
  const { prefs, change, undo, revert } = useFeedPreferences(data.projectId);
  const feed = allFeed.filter((item) => prefs.sources[feedSourceOf(item.kind)]);
  const [tab, setTab] = useState<FeedTab>(prefs.defaultTab);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [marks, toggleMark] = useFeedBookmarks();
  const countOf = (key: FeedSourceKey) =>
    allFeed.filter((item) => feedSourceOf(item.kind) === key).length;
  const live = [...data.supervisors, ...data.parents, ...data.workers].flatMap((thread) => {
    const state = projectOverviewWorkerState(thread);
    return state === "waiting" ? [] : [{ thread, state }];
  });
  const de = language === "de";
  const card = "rounded-2xl bg-muted/50 px-4 py-3";
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
  const tabLabels: Record<FeedTab, string> = {
    top: text.tabTop,
    latest: text.tabLatest,
    prs: text.tabPrs,
    sessions: text.tabSessions,
    disruptions: text.tabDisruptions,
    saved: de ? "Gemerkt" : "Saved",
  };
  const tabCount = (value: FeedTab) => filterTab(feed, value, marks).length;
  const activity = feed.slice(0, 4);
  return (
    <main
      className="relative flex h-full min-h-0 w-full min-w-0 flex-col items-center gap-4 text-[15px] lg:flex-row lg:items-stretch lg:justify-center lg:gap-3 lg:overflow-hidden lg:px-3"
      data-workjet-project-overview={data.projectId}
      lang={language}
    >
      <nav
        aria-label={de ? "Ansichten" : "Views"}
        className="hidden w-[260px] shrink-0 flex-col gap-1 self-start rounded-xl border border-border bg-card p-3 xl:my-3 xl:flex"
        data-workjet-overview-column="views"
      >
        <h2 className="px-2 pt-1 pb-2 text-[17px] font-bold">{de ? "Ansichten" : "Views"}</h2>
        {FEED_TABS.map((value) => (
          <button
            key={value}
            type="button"
            aria-current={tab === value ? "page" : undefined}
            onClick={() => setTab(value)}
            className={
              "flex items-center justify-between rounded-lg px-2.5 py-2 text-left text-[14px] " +
              (tab === value
                ? "bg-blue-500/15 font-semibold text-foreground"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground")
            }
          >
            {tabLabels[value]}
            <span className="tabular-nums text-[13px] text-muted-foreground">
              {tabCount(value)}
            </span>
          </button>
        ))}
        <div className="mt-2 border-t border-border pt-2">
          <FeedSettingsButton language={language} onClick={() => setSettingsOpen(true)} />
        </div>
      </nav>
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
          language={language}
          text={text}
          locale={locale}
          now={now}
          open={open}
          header={
            <div className="px-4 pt-3 pb-1">
              <h1 className="break-words text-[20px] font-bold tracking-tight">{data.title}</h1>
              {data.summary !== null && (
                <p className="mt-0.5 text-[14px] leading-5 text-muted-foreground">{data.summary}</p>
              )}
              {developerMode && (
                <SupervisorTickStatus {...data.supervisorTick} language={language} text={text} />
              )}
              {props.connectionError && (
                <p
                  className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"
                  role="status"
                >
                  <span className="size-1.5 shrink-0 rounded-full bg-amber-400" />
                  {props.connectionMessage ?? text.unavailableConnection}
                </p>
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
          title={`Feed · ${data.title}`}
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
        <h2 className="px-1 text-[20px] font-bold tracking-tight">{text.sideTitle}</h2>
        {activity.length > 0 ? (
          <section className={card} data-workjet-overview-section="activity">
            <h3 className="mb-1 text-[15px] font-bold text-foreground">
              {de ? "Was läuft" : "What's happening"}
            </h3>
            <ul className="divide-y divide-border/60">
              {activity.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    disabled={!item.thread}
                    onClick={() => item.thread && open(item.thread)}
                    className="block w-full py-2 text-left disabled:cursor-default"
                  >
                    <span className="block text-[12px] text-muted-foreground">
                      {item.author} · {relativeTime(item.at, now, locale)}
                    </span>
                    <span className="line-clamp-2 text-[14px] font-semibold text-foreground">
                      {item.headline ?? item.body}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <section className={card} data-workjet-overview-section="live">
          <h3 className="mb-2 text-[15px] font-bold text-foreground">{text.liveTitle}</h3>
          {live.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{text.liveEmpty}</p>
          ) : (
            <ul className="divide-y divide-border/60">
              {live.map(({ thread, state }) => (
                <li key={thread.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 py-2 text-left text-[14px] hover:text-foreground"
                    onClick={() => open(thread)}
                  >
                    <span
                      aria-hidden
                      className={
                        "size-2 shrink-0 rounded-full " +
                        (state === "running"
                          ? "bg-emerald-400"
                          : state === "disrupted"
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
                    <span className="text-[13px] text-muted-foreground">{text[state]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className={card} data-workjet-overview-section="meeting">
          <h3 className="text-[15px] font-bold text-foreground">{text.nextMeeting}</h3>
          {data.recurring && weekday !== null ? (
            <p className="mt-1 text-[14px] font-semibold">
              {weekday} · {data.recurring.time}
              <span className="mt-0.5 block text-[13px] font-normal text-muted-foreground">
                {data.recurring.timezone}
              </span>
            </p>
          ) : (
            <p className="mt-1 text-[14px] text-muted-foreground">{text.noNextMeeting}</p>
          )}
          <Button
            size="sm"
            className="mt-2.5 rounded-full"
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
        <section className={card} data-workjet-overview-section="kpis">
          <h3 className="mb-2 text-[15px] font-bold text-foreground">{text.metrics}</h3>
          {missingKpis ? (
            <div className="space-y-2">
              <p className="text-[13px] text-muted-foreground">{text.kpisMissing}</p>
              {props.onRecomputeKpis ? (
                <Button size="xs" variant="outline" onClick={props.onRecomputeKpis}>
                  <RefreshCwIcon aria-hidden className="size-3.5" />
                  {text.recompute}
                </Button>
              ) : null}
            </div>
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
        {data.goals.length === 0 ? null : (
          <section className={card} data-workjet-overview-section="goals">
            <h3 className="mb-2 text-[15px] font-bold text-foreground">{text.goals}</h3>
            <ul className="space-y-2 text-[13px]">
              {data.goals.map((goal) => (
                <li key={goal.id} className="min-w-0">
                  <p className="line-clamp-2 break-words font-semibold text-foreground">
                    {goal.title}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-muted-foreground">
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
                </li>
              ))}
            </ul>
          </section>
        )}
        <section className={card} data-workjet-overview-section="settings">
          <h3 className="mb-1 text-[15px] font-bold text-foreground">
            {de ? "Projekt & Einstellungen" : "Project & settings"}
          </h3>
          <div className="flex flex-col items-start">
            {(props.settingsLinks ?? []).map((link) => (
              <button
                key={link.label}
                type="button"
                onClick={link.onClick}
                className="py-1.5 text-[14px] font-semibold text-foreground hover:text-blue-400"
              >
                {link.label}
              </button>
            ))}
            {data.links.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 py-1.5 text-[14px] font-semibold text-foreground hover:text-blue-400"
              >
                {link.label}
                <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
              </a>
            ))}
          </div>
          {props.actions ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
              {props.actions}
            </div>
          ) : null}
        </section>
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
  /** Monospace excerpt (error line, diff stat …) shown inside the preview card. */
  readonly code?: string | null;
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
    if ((item.kind === "step" || item.kind === "session") && item.thread && !item.code) {
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
  for (const thread of data.disruptions) {
    const content = disruptionContent({
      name: who(thread).author,
      lastError: thread.session?.lastError,
      language: data.language,
    });
    items.push({
      id: `disruption:${thread.id}`,
      at: threadAt(thread),
      ...who(thread),
      ...content,
      code:
        thread.session?.lastError
          ?.split("\n")
          .find((line) => line.trim())
          ?.slice(0, 160) ?? null,
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
    items.push({
      id: `event:${event.id}`,
      at: event.at,
      ...(event.thread
        ? who(event.thread)
        : pr?.author
          ? { author: pr.author, harness: "GitHub" }
          : { author: text.feedSystem, harness: null }),
      body: event.sentence,
      ...(content ?? {}),
      tone: "normal",
      kind: event.kind === "goal" ? "meeting" : event.kind,
      badge: null,
      thread: event.thread,
      url: content?.sources.some((source) => source.url === event.url) ? undefined : event.url,
    });
  }
  const supervisor = data.supervisors[0];
  if (data.recurring) {
    const de = data.language === "de";
    const day = new Intl.DateTimeFormat(localeOf(data.language), {
      weekday: "long",
      timeZone: "UTC",
    }).format(new Date(Date.UTC(2026, 0, 4 + data.recurring.weekday)));
    const next = data.nextMeetingDate
      ? new Intl.DateTimeFormat(localeOf(data.language), {
          day: "2-digit",
          month: "2-digit",
          timeZone: "UTC",
        }).format(new Date(data.nextMeetingDate + "T00:00:00Z"))
      : null;
    items.push({
      id: "meeting:recurring",
      at: supervisor?.createdAt ?? nowIso,
      author: text.feedSystem,
      harness: de ? "regeltermin" : "standup",
      headline: de
        ? `Regeltermin jeden ${day} um ${data.recurring.time}`
        : `Standing meeting every ${day} at ${data.recurring.time}`,
      body: de
        ? `Der Supervisor berichtet im Regeltermin, was die Worker erledigt haben, und holt dort deine Entscheidungen ab.${next ? ` Nächster Termin: ${next}, ${data.recurring.time} (${data.recurring.timezone}).` : ""}`
        : `The supervisor reports what the workers did and collects your decisions in the standing meeting.${next ? ` Next: ${next}, ${data.recurring.time} (${data.recurring.timezone}).` : ""}`,
      tone: "normal",
      kind: "meeting",
      badge: null,
      thread: undefined,
      url: undefined,
      ...(supervisor ? { groupKey: supervisor.id } : {}),
    });
  }
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
    saved: props.language === "de" ? "Gemerkt" : "Saved",
  };
  const items = filterTab(props.feed, tab, marks);
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
          <div className="pt-3 pr-3 xl:hidden">
            <FeedSettingsButton language={props.language} onClick={props.onOpenSettings} />
          </div>
        </div>
        <div role="tablist" aria-label={text.feedTitle} className="flex">
          {FEED_TABS.filter((value) => value !== "saved").map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className={
                "relative flex flex-1 justify-center px-2 py-3.5 text-[15px] transition-colors hover:bg-muted/40 " +
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
          <p className="px-4 py-8 text-[15px] text-muted-foreground">
            {props.feed.length === 0
              ? text.feedEmpty
              : tab === "saved"
                ? props.language === "de"
                  ? "Noch nichts gemerkt. „Merken“ an einem Beitrag legt ihn hier ab."
                  : "Nothing saved yet. “Save” on a post keeps it here."
                : tab === "sessions"
                  ? text.sessionsEmpty
                  : text.tabEmpty}
          </p>
        ) : (
          <ol>
            {groups.map((group) => {
              const id = group[0]!.id;
              const expanded = expandedThreads.has(id);
              const shown = expanded ? group : group.slice(0, 3);
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
                  {group.length > 3 ? (
                    <button
                      type="button"
                      className="mb-3 ml-[4.25rem] text-[15px] text-blue-400 hover:text-blue-300"
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
                    </button>
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

const KIND_LABEL: Record<FeedItem["kind"], { de: string; en: string }> = {
  disruption: { de: "Störung", en: "Disruption" },
  escalation: { de: "Wartet auf dich", en: "Waiting for you" },
  goal: { de: "Ziel", en: "Goal" },
  pr: { de: "Pull Request", en: "Pull request" },
  step: { de: "Arbeitsschritt", en: "Work step" },
  meeting: { de: "Regeltermin", en: "Standing meeting" },
  setup: { de: "Projekt eingerichtet", en: "Project set up" },
  session: { de: "Sitzung", en: "Session" },
};
const CARD_BANDS: Record<FeedItem["kind"], string> = {
  disruption: "from-[#4a1d24] via-[#2e1820] to-[#1a1418]",
  escalation: "from-[#4a3a1d] via-[#2e2618] to-[#1a1714]",
  goal: "from-[#1f4d4a] via-[#18323a] to-[#141c26]",
  pr: "from-[#1e3a6e] via-[#1b2f55] to-[#151d33]",
  step: "from-[#1e3a6e] via-[#1b2f55] to-[#151d33]",
  meeting: "from-[#3b2a6e] via-[#2a2150] to-[#171630]",
  setup: "from-[#1f4d3a] via-[#18332c] to-[#141c1c]",
  session: "from-[#1e3a6e] via-[#1b2f55] to-[#151d33]",
};

function FeedCard(props: {
  readonly threadLine: boolean;
  readonly item: FeedItem;
  readonly text: ProjectOwnerOverview["text"];
  readonly locale: string;
  readonly now: number;
  readonly replies: number;
  readonly marked: boolean;
  readonly onToggleMark: () => void;
  readonly onOpen: (() => void) | undefined;
}) {
  const { item, text } = props;
  const de = props.locale.startsWith("de");
  const [expanded, setExpanded] = useState(false);
  const long = item.body.length > 280;
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
  const kindLabel = KIND_LABEL[item.kind][de ? "de" : "en"];
  const cardTitle = item.headline ?? preview?.label ?? kindLabel;
  const cardMeta = preview?.url
    ? sourceHost(preview.url)
    : `${kindLabel}${item.thread ? " · " + (de ? "Chat" : "chat") : ""}`;
  const cardInner = (
    <>
      {item.image ? (
        <img
          src={item.image}
          alt=""
          loading="lazy"
          className="block aspect-[2/1] w-full border-b border-border bg-muted object-cover"
        />
      ) : item.excerpt ? (
        <span className="block border-b border-border bg-muted/30 px-3 py-3 text-[14px] leading-5 text-foreground/85 italic">
          „{item.excerpt}“
        </span>
      ) : item.code ? (
        <span
          aria-hidden
          className="block border-b border-border bg-[#0d1117] px-3 py-3 font-mono text-[12.5px] leading-5 break-all text-red-300/90"
        >
          {item.code}
        </span>
      ) : (
        <span
          aria-hidden
          className={"block h-[120px] bg-gradient-to-br " + CARD_BANDS[item.kind]}
        ></span>
      )}
      <span className="block px-3 py-2.5">
        <span className="block text-[13px] text-muted-foreground">
          {cardMeta}
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
        <span className="block text-[15px] break-words text-foreground">{cardTitle}</span>
      </span>
    </>
  );
  const cardClass =
    "mt-3 block w-full overflow-hidden rounded-2xl border border-border text-left hover:bg-muted/20";
  const actionClass =
    "inline-flex items-center gap-1.5 rounded-full py-1 hover:text-foreground focus-visible:text-foreground";
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
            "flex size-10 items-center justify-center rounded-full text-[14px] font-bold text-white " +
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
        <p className="flex flex-wrap items-baseline gap-x-1 text-[15px] leading-5">
          <span className="font-bold text-foreground">{item.author}</span>
          {item.harness ? <span className="text-muted-foreground">@{item.harness}</span> : null}
          <span className="text-muted-foreground">·</span>
          <time dateTime={item.at} className="text-muted-foreground tabular-nums">
            {relativeTime(item.at, props.now, props.locale)}
          </time>
          {item.badge ? (
            <span className="ml-1 rounded-full bg-red-500/15 px-2 py-px text-[12px] font-semibold text-red-400">
              {item.badge}
            </span>
          ) : null}
        </p>
        <p className="mt-1 text-[15px] break-words leading-[1.4] whitespace-pre-line text-foreground [overflow-wrap:anywhere]">
          {long && !expanded ? `${item.body.slice(0, 280).trimEnd()} …` : item.body}
          {long ? (
            <button
              type="button"
              className="ml-1 text-blue-400 hover:text-blue-300"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? text.feedLess : text.feedMore}
            </button>
          ) : null}
        </p>
        {item.openItems && item.openItems.length > 0 ? (
          <ul className="mt-1 space-y-0.5 text-[15px] text-muted-foreground">
            {item.openItems.map((entry) => (
              <li key={entry}>
                {text.feedOpen}: {entry}
              </li>
            ))}
          </ul>
        ) : null}
        {preview?.url ? (
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
                className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-[13px] text-foreground hover:bg-muted/70"
              >
                <span aria-hidden className={"size-2.5 rounded-sm " + SOURCE_COLORS[source.type]} />
                {source.label}
              </a>
            ))}
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-10 gap-y-1 text-[13px] text-muted-foreground">
          {props.onOpen ? (
            <button
              type="button"
              onClick={props.onOpen}
              className={
                actionClass + " " + (item.tone === "disrupted" ? "font-semibold text-red-400" : "")
              }
            >
              <MessageSquareIcon aria-hidden className="size-[18px]" />
              {item.actionLabel ?? text.openChat}
              {props.replies > 0 ? <span className="tabular-nums">{props.replies}</span> : null}
            </button>
          ) : null}
          {linked.length > 0 ? (
            <span className={actionClass}>
              <LinkIcon aria-hidden className="size-[18px]" />
              {de ? "Quellen" : "Sources"}
              <span className="tabular-nums">{linked.length}</span>
            </span>
          ) : null}
          {prUrl ? (
            <a href={prUrl} target="_blank" rel="noopener noreferrer" className={actionClass}>
              <GitPullRequestIcon aria-hidden className="size-[18px]" />
              {text.feedOpenPr}
            </a>
          ) : null}
          <button
            type="button"
            aria-pressed={props.marked}
            onClick={props.onToggleMark}
            className={actionClass + (props.marked ? " text-blue-400" : "")}
          >
            <BookmarkIcon
              aria-hidden
              className={"size-[18px]" + (props.marked ? " fill-current" : "")}
            />
            {props.marked ? text.feedMarked : text.feedMark}
          </button>
        </div>
      </div>
    </li>
  );
}
