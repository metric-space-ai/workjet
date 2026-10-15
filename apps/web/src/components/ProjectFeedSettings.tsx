import { useEffect, useRef, useState } from "react";
import { SlidersHorizontalIcon, Undo2Icon, XIcon } from "lucide-react";
import type { CtoxWorkjetFeedSettings, ProjectId } from "@workjet/contracts";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { configureWorkjetProject } from "../workjetProjectControl";
import { refreshWorkjetProjectRegistry } from "../workjetProjectRegistry";
import { newCommandId } from "../lib/utils";

/** Feed sources a reader can switch off. */
export type FeedSourceKey = "disruptions" | "results" | "sessions" | "prs" | "meeting" | "setup";
export const FEED_SOURCE_KEYS: readonly FeedSourceKey[] = [
  "disruptions",
  "results",
  "sessions",
  "prs",
  "meeting",
  "setup",
];
export type FeedSourceState = Readonly<Record<FeedSourceKey, boolean>>;
export type FeedDefaultTab = "top" | "latest";
export type FeedPreferences = {
  readonly title: string | null;
  readonly windowDays: 1 | 7 | 30 | null;
  readonly sources: FeedSourceState;
  readonly defaultTab: FeedDefaultTab;
  readonly body: "short" | "full";
  readonly replies: "three" | "all";
  readonly notifyDisruptions: boolean;
};
const ALL_ON: FeedSourceState = {
  disruptions: true,
  results: true,
  sessions: true,
  prs: true,
  meeting: true,
  setup: true,
};
export const DEFAULT_FEED_PREFERENCES: FeedPreferences = {
  title: null,
  windowDays: null,
  sources: ALL_ON,
  defaultTab: "top",
  body: "short",
  replies: "three",
  notifyDisruptions: false,
};
const storageKey = (projectId: string) => `workjet.overview.feed.prefs.${projectId}`;

/** Normalizes stored (instance or device) settings; unknown or broken values fall back. */
export function normalizeFeedPreferences(
  value: Partial<CtoxWorkjetFeedSettings> | null | undefined,
): FeedPreferences {
  const v = value ?? {};
  const title = typeof v.title === "string" && v.title.trim() ? v.title.trim().slice(0, 120) : null;
  return {
    title,
    windowDays:
      v.windowDays === 1 || v.windowDays === 7 || v.windowDays === 30 ? v.windowDays : null,
    sources: { ...ALL_ON, ...v.sources },
    defaultTab: v.defaultTab === "latest" ? "latest" : "top",
    body: v.body === "full" ? "full" : "short",
    replies: v.replies === "all" ? "all" : "three",
    notifyDisruptions: v.notifyDisruptions === true,
  };
}
export function readFeedPreferences(raw: string | null): FeedPreferences {
  try {
    return normalizeFeedPreferences(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_FEED_PREFERENCES;
  }
}
export function feedSettingsWire(prefs: FeedPreferences): CtoxWorkjetFeedSettings {
  return {
    title: prefs.title,
    windowDays: prefs.windowDays,
    sources: { ...prefs.sources },
    defaultTab: prefs.defaultTab,
    body: prefs.body,
    replies: prefs.replies,
    notifyDisruptions: prefs.notifyDisruptions,
  };
}

/** Where the feed settings live: the CTOX instance (per project) or, without one, this device. */
export type FeedPersistence = {
  readonly instanceId: string | null;
  readonly configurationId: ProjectId | null;
  readonly projectTitle: string;
  /** Settings the instance returned with the project, if its core knows them. */
  readonly stored: CtoxWorkjetFeedSettings | null | undefined;
};
export type FeedSaveState = "idle" | "saving" | "instance" | "device";

/** Instant save: every change applies at once and is written; the previous value stays for undo. */
export function useFeedPreferences(projectId: string, persistence?: FeedPersistence) {
  const remote = persistence?.instanceId && persistence.configurationId ? persistence : null;
  const [prefs, setPrefs] = useState<FeedPreferences>(() =>
    remote?.stored
      ? normalizeFeedPreferences(remote.stored)
      : readFeedPreferences(globalThis.localStorage?.getItem(storageKey(projectId)) ?? null),
  );
  const [saved, setSaved] = useState<FeedSaveState>(remote?.stored ? "instance" : "idle");
  const [undo, setUndo] = useState<{ prev: FeedPreferences; label: string } | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 8000);
    return () => clearTimeout(timer);
  }, [undo]);
  const writeLocal = (next: FeedPreferences) => {
    try {
      globalThis.localStorage?.setItem(storageKey(projectId), JSON.stringify(next));
    } catch {
      // A full storage keeps the change for this session only.
    }
  };
  const write = (next: FeedPreferences) => {
    setPrefs(next);
    writeLocal(next);
    if (!remote) {
      setSaved("device");
      return;
    }
    const mine = ++seq.current;
    setSaved("saving");
    void configureWorkjetProject(remote.instanceId!, {
      action: "project.configure",
      commandId: newCommandId(),
      projectId: remote.configurationId!,
      title: remote.projectTitle,
      feedSettings: feedSettingsWire(next),
    })
      .then((result) => {
        if (mine !== seq.current) return;
        const ok =
          result._tag === "completed" &&
          result.response.action === "project.configure" &&
          result.response.project.feedSettings != null;
        setSaved(ok ? "instance" : "device");
        if (ok) refreshWorkjetProjectRegistry(remote.instanceId);
      })
      .catch(() => mine === seq.current && setSaved("device"));
  };
  const change = (next: FeedPreferences, label: string) => {
    setUndo({ prev: prefs, label });
    write(next);
  };
  const revert = () => {
    if (undo) write(undo.prev);
    setUndo(null);
  };
  return { prefs, change, undo, revert, saved } as const;
}

export type FeedSourceRow = {
  readonly key: FeedSourceKey;
  readonly group: string;
  readonly name: string;
  readonly badge: string;
  readonly badgeColor: string;
  readonly count: number;
  readonly chips: readonly string[];
  readonly note?: string | null;
  readonly action?: { readonly label: string; readonly onClick: () => void } | null;
};

type SheetTab = "topic" | "sources" | "editorial" | "delivery";

function RadioRows<T extends string | number | null>(props: {
  readonly name: string;
  readonly legend: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string; readonly hint: string }[];
  readonly onChange: (value: T, label: string) => void;
}) {
  return (
    <fieldset className="mb-4 space-y-1.5">
      <legend className="mb-1.5 text-[14px] font-bold">{props.legend}</legend>
      {props.options.map((option) => (
        <label
          key={String(option.value)}
          className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2.5 text-[14px]"
        >
          <input
            type="radio"
            name={props.name}
            className="size-4 accent-blue-500"
            checked={props.value === option.value}
            onChange={() => props.onChange(option.value, option.label)}
          />
          <span className="font-semibold">{option.label}</span>
          <span className="text-muted-foreground">{option.hint}</span>
        </label>
      ))}
    </fieldset>
  );
}

export function FeedSettingsSheet(props: {
  readonly title: string;
  readonly projectTitle: string;
  readonly language: "de" | "en";
  readonly rows: readonly FeedSourceRow[];
  readonly prefs: FeedPreferences;
  readonly onChange: (next: FeedPreferences, label: string) => void;
  readonly undo: { readonly label: string } | null;
  readonly onUndo: () => void;
  readonly onClose: () => void;
  readonly saved: FeedSaveState;
  readonly instanceName: string | null;
  readonly meeting: string | null;
  readonly onOpenMeetingSettings?: (() => void) | undefined;
}) {
  const de = props.language === "de";
  const { prefs } = props;
  const [tab, setTab] = useState<SheetTab>("sources");
  const [titleDraft, setTitleDraft] = useState(prefs.title ?? "");
  useEffect(() => setTitleDraft(prefs.title ?? ""), [prefs.title]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && props.onClose();
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  });
  const set = <K extends keyof FeedPreferences>(key: K, value: FeedPreferences[K], label: string) =>
    props.onChange({ ...prefs, [key]: value }, label);
  const commitTitle = () => {
    const next = titleDraft.trim() ? titleDraft.trim().slice(0, 120) : null;
    if (next !== prefs.title)
      set(
        "title",
        next,
        de
          ? `Feed-Titel „${next ?? props.projectTitle}“`
          : `Feed title “${next ?? props.projectTitle}”`,
      );
  };
  const groups = [...new Set(props.rows.map((row) => row.group))];
  const allOn = props.rows.every((row) => prefs.sources[row.key]);
  const setAll = (value: boolean) =>
    props.onChange(
      {
        ...prefs,
        sources: Object.fromEntries(FEED_SOURCE_KEYS.map((key) => [key, value])) as FeedSourceState,
      },
      value
        ? de
          ? "Alle Quellen an"
          : "All sources on"
        : de
          ? "Alle Quellen aus"
          : "All sources off",
    );
  const tabs: readonly { readonly value: SheetTab; readonly label: string }[] = [
    { value: "topic", label: de ? "Thema & Rhythmus" : "Topic & rhythm" },
    { value: "sources", label: de ? "Quellen & Accounts" : "Sources & accounts" },
    { value: "editorial", label: de ? "Redaktion" : "Editorial" },
    { value: "delivery", label: de ? "Zustellung" : "Delivery" },
  ];
  const tabClass = (active: boolean) =>
    "rounded-md px-2.5 py-1.5 text-[13px] font-semibold whitespace-nowrap " +
    (active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground");
  const savedText =
    props.saved === "saving"
      ? de
        ? "Speichert …"
        : "Saving …"
      : props.saved === "instance"
        ? de
          ? `Gespeichert auf ${props.instanceName ?? "der Instanz"}`
          : `Saved on ${props.instanceName ?? "the instance"}`
        : props.saved === "device"
          ? de
            ? "Nur auf diesem Gerät gespeichert – der Core der Instanz kennt Feed-Einstellungen noch nicht."
            : "Saved on this device only – the instance core doesn't know feed settings yet."
          : de
            ? "Änderungen gelten sofort und werden gespeichert."
            : "Changes apply at once and are saved.";
  return (
    <div
      role="region"
      aria-label={props.title}
      data-workjet-feed-settings=""
      className="flex w-full max-w-[600px] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card lg:my-3 lg:w-[480px]"
    >
      <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
        <h2 className="text-[17px] font-bold">{props.title}</h2>
        <button
          type="button"
          onClick={props.onClose}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <XIcon aria-hidden className="size-4" />
          {de ? "Schließen" : "Close"}
        </button>
      </header>
      <div role="tablist" className="mx-5 flex flex-wrap gap-1 rounded-lg border border-border p-1">
        {tabs.map((entry) => (
          <button
            key={entry.value}
            type="button"
            role="tab"
            aria-selected={tab === entry.value}
            onClick={() => setTab(entry.value)}
            className={tabClass(tab === entry.value)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto px-5 py-3"
        data-workjet-feed-settings-tab={tab}
      >
        {tab === "topic" ? (
          <>
            <label className="mb-4 block">
              <span className="mb-1.5 block text-[14px] font-bold">
                {de ? "Feed-Titel" : "Feed title"}
              </span>
              <Input
                value={titleDraft}
                maxLength={120}
                placeholder={props.projectTitle}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={commitTitle}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitTitle();
                }}
              />
              <span className="mt-1 block text-[12px] text-muted-foreground">
                {de
                  ? "Leer lassen für den Projektnamen. Gespeichert beim Verlassen des Felds."
                  : "Leave empty for the project name. Saved when you leave the field."}
              </span>
            </label>
            <RadioRows
              name="feed-window"
              legend={de ? "Zeitraum" : "Time window"}
              value={prefs.windowDays}
              options={[
                {
                  value: 1,
                  label: de ? "Heute" : "Today",
                  hint: de ? "letzte 24 Stunden" : "last 24 hours",
                },
                {
                  value: 7,
                  label: de ? "Woche" : "Week",
                  hint: de ? "letzte 7 Tage" : "last 7 days",
                },
                {
                  value: 30,
                  label: de ? "Monat" : "Month",
                  hint: de ? "letzte 30 Tage" : "last 30 days",
                },
                {
                  value: null,
                  label: de ? "Alles" : "All",
                  hint: de ? "ohne Zeitgrenze" : "no limit",
                },
              ]}
              onChange={(value, label) =>
                set("windowDays", value, `${de ? "Zeitraum" : "Window"}: ${label}`)
              }
            />
            <section className="rounded-lg bg-muted/40 px-3 py-2.5 text-[14px]">
              <h3 className="font-bold">{de ? "Rhythmus" : "Rhythm"}</h3>
              <p className="mt-0.5 text-muted-foreground">
                {props.meeting
                  ? (de ? "Regeltermin: " : "Standing meeting: ") + props.meeting
                  : de
                    ? "Kein Regeltermin eingestellt."
                    : "No standing meeting set."}
              </p>
              {props.onOpenMeetingSettings ? (
                <button
                  type="button"
                  onClick={props.onOpenMeetingSettings}
                  className="mt-1.5 rounded-md bg-muted px-2.5 py-1 text-[12px] font-semibold hover:bg-muted/70"
                >
                  {de ? "Regeltermin ändern" : "Change meeting"}
                </button>
              ) : null}
            </section>
          </>
        ) : tab === "sources" ? (
          groups.map((group, index) => (
            <section key={group} className="mb-3">
              <div className="mb-1.5 flex items-center justify-between">
                <h3 className="text-[14px] font-bold">{group}</h3>
                {index === 0 ? (
                  <button
                    type="button"
                    onClick={() => setAll(!allOn)}
                    className="rounded-md bg-muted px-2.5 py-1 text-[12px] font-semibold text-foreground hover:bg-muted/70"
                  >
                    {allOn
                      ? de
                        ? "Alle ausschalten"
                        : "Turn all off"
                      : de
                        ? "Alle einschalten"
                        : "Turn all on"}
                  </button>
                ) : null}
              </div>
              <ul className="space-y-1.5">
                {props.rows
                  .filter((row) => row.group === group)
                  .map((row) => (
                    <li
                      key={row.key}
                      className="rounded-lg bg-muted/40 px-3 py-2.5"
                      data-workjet-feed-source={row.key}
                    >
                      <div className="flex items-center gap-3">
                        <Checkbox
                          id={`feed-source-${row.key}`}
                          checked={prefs.sources[row.key]}
                          onCheckedChange={(value) => {
                            const checked = value === true;
                            props.onChange(
                              { ...prefs, sources: { ...prefs.sources, [row.key]: checked } },
                              `${row.name} ${checked ? (de ? "an" : "on") : de ? "aus" : "off"}`,
                            );
                          }}
                        />
                        <span
                          aria-hidden
                          className={
                            "flex size-7 shrink-0 items-center justify-center rounded-md text-[11px] font-bold text-white " +
                            row.badgeColor
                          }
                        >
                          {row.badge}
                        </span>
                        <label
                          htmlFor={`feed-source-${row.key}`}
                          className="min-w-0 flex-1 text-[14px] font-semibold"
                        >
                          {row.name}
                          <span className="ml-1.5 font-normal text-muted-foreground tabular-nums">
                            {row.count}
                          </span>
                        </label>
                        {row.action ? (
                          <button
                            type="button"
                            onClick={row.action.onClick}
                            className="rounded-md bg-muted px-2.5 py-1 text-[12px] font-semibold hover:bg-muted/70"
                          >
                            {row.action.label}
                          </button>
                        ) : null}
                      </div>
                      {row.note ? (
                        <p className="mt-1 ml-[3.25rem] text-[12px] text-amber-400">{row.note}</p>
                      ) : null}
                      {row.chips.length > 0 ? (
                        <div className="mt-1.5 ml-[3.25rem] flex flex-wrap gap-1">
                          {row.chips.map((chip) => (
                            <span
                              key={chip}
                              className="rounded bg-blue-500/15 px-1.5 py-0.5 text-[12px] text-blue-300"
                            >
                              {chip}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </li>
                  ))}
              </ul>
            </section>
          ))
        ) : tab === "editorial" ? (
          <>
            <RadioRows
              name="feed-default-tab"
              legend={de ? "Beim Öffnen zeigen" : "Show on open"}
              value={prefs.defaultTab}
              options={[
                {
                  value: "top",
                  label: "Top",
                  hint: de ? "Störungen und PRs oben" : "Disruptions and PRs first",
                },
                {
                  value: "latest",
                  label: de ? "Neueste zuerst" : "Newest first",
                  hint: de ? "streng nach Zeit" : "strictly by time",
                },
              ]}
              onChange={(value, label) => set("defaultTab", value, label)}
            />
            <RadioRows
              name="feed-body"
              legend={de ? "Beitragstext" : "Post text"}
              value={prefs.body}
              options={[
                {
                  value: "short",
                  label: de ? "Gekürzt" : "Short",
                  hint: de ? "„Mehr anzeigen“ ab 280 Zeichen" : "“Show more” after 280 characters",
                },
                {
                  value: "full",
                  label: de ? "Vollständig" : "Full",
                  hint: de ? "immer ganzer Text" : "always the whole text",
                },
              ]}
              onChange={(value, label) => set("body", value, `${de ? "Text" : "Text"}: ${label}`)}
            />
            <RadioRows
              name="feed-replies"
              legend={de ? "Threads" : "Threads"}
              value={prefs.replies}
              options={[
                {
                  value: "three",
                  label: de ? "Bis zu 3 Beiträge" : "Up to 3 posts",
                  hint: de ? "Rest über „Thread anzeigen“" : "rest via “Show thread”",
                },
                {
                  value: "all",
                  label: de ? "Alle Beiträge" : "All posts",
                  hint: de ? "ganzer Thread offen" : "whole thread open",
                },
              ]}
              onChange={(value, label) => set("replies", value, `Threads: ${label}`)}
            />
          </>
        ) : (
          <>
            <section className="mb-3 rounded-lg bg-muted/40 px-3 py-2.5 text-[14px]">
              <h3 className="font-bold">{de ? "In Workjet" : "In Workjet"}</h3>
              <p className="mt-0.5 text-muted-foreground">
                {de
                  ? "Der Feed erscheint immer in der Übersicht dieses Projekts."
                  : "The feed always shows in this project's overview."}
              </p>
            </section>
            <div className="mb-3 flex items-start gap-3 rounded-lg bg-muted/40 px-3 py-2.5">
              <Checkbox
                id="feed-notify-disruptions"
                checked={prefs.notifyDisruptions}
                onCheckedChange={(value) => {
                  const checked = value === true;
                  if (
                    checked &&
                    typeof Notification !== "undefined" &&
                    Notification.permission === "default"
                  )
                    void Notification.requestPermission();
                  set(
                    "notifyDisruptions",
                    checked,
                    de
                      ? `Mitteilung bei Störungen ${checked ? "an" : "aus"}`
                      : `Disruption alerts ${checked ? "on" : "off"}`,
                  );
                }}
              />
              <label htmlFor="feed-notify-disruptions" className="text-[14px]">
                <span className="block font-semibold">
                  {de
                    ? "Desktop-Mitteilung bei neuen Störungen"
                    : "Desktop alert for new disruptions"}
                </span>
                <span className="block text-muted-foreground">
                  {de
                    ? "Solange Workjet geöffnet ist, auf diesem Rechner."
                    : "While Workjet is open, on this computer."}
                </span>
              </label>
            </div>
            <section className="rounded-lg border border-dashed border-border px-3 py-2.5 text-[14px] text-muted-foreground">
              <h3 className="font-bold text-foreground">
                {de ? "E-Mail-Zusammenfassung" : "Email digest"}
              </h3>
              <p className="mt-0.5">
                {de
                  ? "Noch nicht verfügbar: braucht den E-Mail-Kanal der Instanz, der noch nicht verbunden ist."
                  : "Not available yet: needs the instance's email channel, which isn't connected."}
              </p>
            </section>
          </>
        )}
      </div>
      <footer
        className="flex min-h-12 items-center justify-between gap-3 border-t border-border px-5 py-2 text-[13px] text-muted-foreground"
        role="status"
        data-workjet-feed-settings-saved={props.saved}
      >
        <span className={props.saved === "device" ? "text-amber-400" : ""}>
          {props.undo ? `${props.undo.label} · ` : ""}
          {savedText}
        </span>
        {props.undo ? (
          <button
            type="button"
            onClick={props.onUndo}
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-muted px-2.5 py-1 font-semibold text-foreground hover:bg-muted/70"
          >
            <Undo2Icon aria-hidden className="size-3.5" />
            {de ? "Rückgängig" : "Undo"}
          </button>
        ) : null}
      </footer>
    </div>
  );
}

export function FeedSettingsButton(props: {
  readonly language: "de" | "en";
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      data-workjet-action="project.feed.settings"
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-semibold text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <SlidersHorizontalIcon aria-hidden className="size-4" />
      {props.language === "de" ? "Einstellungen" : "Settings"}
    </button>
  );
}
