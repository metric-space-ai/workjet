import { useEffect, useRef, useState } from "react";
import { SlidersHorizontalIcon, Undo2Icon, XIcon, type LucideIcon } from "lucide-react";
import type { CtoxWorkjetFeedSettings, ProjectId } from "@workjet/contracts";
import { Checkbox } from "./ui/checkbox";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Segment } from "./ui/segment";
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
  readonly icon: LucideIcon;
  readonly chips: readonly string[];
  readonly note?: string | null;
  readonly action?: { readonly label: string; readonly onClick: () => void } | null;
};

type SheetTab = "topic" | "sources" | "delivery";

function RadioRows<T extends string | number | null>(props: {
  readonly name: string;
  readonly legend: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string; readonly hint: string }[];
  readonly onChange: (value: T, label: string) => void;
}) {
  return (
    <fieldset className="mb-4 space-y-1">
      <legend className="mb-1.5 text-[13.5px] font-bold">{props.legend}</legend>
      {props.options.map((option) => (
        <label
          key={String(option.value)}
          className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2 text-[13.5px]"
        >
          <input
            type="radio"
            name={props.name}
            className="size-4 accent-primary"
            checked={props.value === option.value}
            onChange={() => props.onChange(option.value, option.label)}
          />
          <span className="font-semibold">{option.label}</span>
          {option.hint ? (
            <span className="text-[12px] text-muted-foreground">{option.hint}</span>
          ) : null}
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
    { value: "topic", label: de ? "Thema" : "Topic" },
    { value: "sources", label: de ? "Quellen" : "Sources" },
    { value: "delivery", label: de ? "Zustellung" : "Delivery" },
  ];
  // Only a save that did not reach the instance gets a line; everything else saves silently.
  const deviceOnly = props.saved === "device";
  const closeLabel = de ? "Schließen" : "Close";
  return (
    <div
      role="region"
      aria-label={props.title}
      data-workjet-feed-settings=""
      className="flex w-full max-w-[600px] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card lg:my-3 lg:w-[480px]"
    >
      <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-2">
        <h2 className="min-w-0 truncate text-[13.5px] font-bold">{props.title}</h2>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={props.onClose}
        >
          <XIcon aria-hidden className="size-4" />
        </Button>
      </header>
      <Segment
        aria-label={props.title}
        className="mx-5"
        fill
        value={tab}
        options={tabs}
        onChange={setTab}
      />
      <div
        className="min-h-0 flex-1 overflow-y-auto px-5 py-3"
        data-workjet-feed-settings-tab={tab}
      >
        {tab === "topic" ? (
          <>
            <label className="mb-4 block">
              <span className="mb-1.5 block text-[13.5px] font-bold">
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
            <RadioRows
              name="feed-default-tab"
              legend={de ? "Beim Öffnen" : "On open"}
              value={prefs.defaultTab}
              options={[
                {
                  value: "top",
                  label: de ? "Wichtig" : "Top",
                  hint: de ? "Störungen und PRs oben" : "disruptions and PRs first",
                },
                {
                  value: "latest",
                  label: de ? "Neueste" : "Latest",
                  hint: de ? "nach Zeit" : "by time",
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
                  hint: de ? "ab 280 Zeichen" : "after 280 characters",
                },
                {
                  value: "full",
                  label: de ? "Vollständig" : "Full",
                  hint: de ? "ganzer Text" : "whole text",
                },
              ]}
              onChange={(value, label) => set("body", value, `${de ? "Text" : "Text"}: ${label}`)}
            />
            <RadioRows
              name="feed-replies"
              legend={de ? "Verlauf" : "History"}
              value={prefs.replies}
              options={[
                {
                  value: "three",
                  label: de ? "Bis zu 3 Beiträge" : "Up to 3 posts",
                  hint: "",
                },
                {
                  value: "all",
                  label: de ? "Alle Beiträge" : "All posts",
                  hint: "",
                },
              ]}
              onChange={(value, label) =>
                set("replies", value, `${de ? "Verlauf" : "History"}: ${label}`)
              }
            />
            <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
              <span className="font-bold">{de ? "Regeltermin" : "Standing meeting"}</span>
              {props.meeting ? (
                <span className="text-muted-foreground">{props.meeting}</span>
              ) : null}
              {props.onOpenMeetingSettings ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={props.onOpenMeetingSettings}
                >
                  {props.meeting ? (de ? "Ändern" : "Change") : de ? "Festlegen" : "Set"}
                </Button>
              ) : null}
            </div>
          </>
        ) : tab === "sources" ? (
          groups.map((group, index) => (
            <section key={group} className="mb-3">
              <div className="mb-1.5 flex items-center justify-between">
                <h3 className="text-[13.5px] font-bold">{group}</h3>
                {index === 0 ? (
                  <Button type="button" size="xs" variant="outline" onClick={() => setAll(!allOn)}>
                    {allOn
                      ? de
                        ? "Alle ausschalten"
                        : "Turn all off"
                      : de
                        ? "Alle einschalten"
                        : "Turn all on"}
                  </Button>
                ) : null}
              </div>
              <ul className="space-y-1">
                {props.rows
                  .filter((row) => row.group === group)
                  .map((row) => {
                    const Icon = row.icon;
                    return (
                      <li
                        key={row.key}
                        className="rounded-lg bg-muted/40 px-3 py-2"
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
                          <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                          <label
                            htmlFor={`feed-source-${row.key}`}
                            className="min-w-0 flex-1 text-[13.5px] font-semibold"
                          >
                            {row.name}
                          </label>
                          {row.note ? (
                            <span className="text-[12px] text-muted-foreground">{row.note}</span>
                          ) : null}
                          {row.action ? (
                            <Button
                              type="button"
                              size="xs"
                              variant="outline"
                              onClick={row.action.onClick}
                            >
                              {row.action.label}
                            </Button>
                          ) : null}
                        </div>
                        {row.chips.length > 0 ? (
                          <div className="mt-1.5 ml-[3.25rem] flex flex-wrap gap-1">
                            {row.chips.map((chip) => (
                              <span
                                key={chip}
                                className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                              >
                                {chip}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
              </ul>
            </section>
          ))
        ) : (
          <div className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2">
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
            <label htmlFor="feed-notify-disruptions" className="text-[13.5px] font-semibold">
              {de ? "Mitteilung bei Störungen" : "Alert on disruptions"}
            </label>
          </div>
        )}
      </div>
      {props.undo || deviceOnly ? (
        <footer
          className="flex min-h-11 items-center justify-between gap-3 border-t border-border px-5 py-2 text-[12px] text-muted-foreground"
          role="status"
          data-workjet-feed-settings-saved={props.saved}
        >
          <span className={deviceOnly ? "text-warning-foreground" : ""}>
            {props.undo
              ? props.undo.label
              : de
                ? "Nur auf diesem Gerät gespeichert"
                : "Saved on this device only"}
          </span>
          {props.undo ? (
            <Button type="button" size="xs" variant="outline" onClick={props.onUndo}>
              <Undo2Icon aria-hidden className="size-3.5" />
              {de ? "Rückgängig" : "Undo"}
            </Button>
          ) : null}
        </footer>
      ) : null}
    </div>
  );
}

export function FeedSettingsButton(props: {
  readonly language: "de" | "en";
  readonly onClick: () => void;
}) {
  const label = props.language === "de" ? "Feed-Einstellungen" : "Feed settings";
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      aria-label={label}
      title={label}
      onClick={props.onClick}
      data-workjet-action="project.feed.settings"
    >
      <SlidersHorizontalIcon aria-hidden className="size-4" />
    </Button>
  );
}
