import { useEffect, useState } from "react";
import { SlidersHorizontalIcon, Undo2Icon, XIcon } from "lucide-react";
import { Checkbox } from "./ui/checkbox";

/** Feed sources a reader can switch off; stored per project on this device. */
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
  readonly sources: FeedSourceState;
  readonly defaultTab: FeedDefaultTab;
};
const ALL_ON: FeedSourceState = {
  disruptions: true,
  results: true,
  sessions: true,
  prs: true,
  meeting: true,
  setup: true,
};
const storageKey = (projectId: string) => `workjet.overview.feed.prefs.${projectId}`;

export function readFeedPreferences(raw: string | null): FeedPreferences {
  try {
    const parsed = raw ? (JSON.parse(raw) as Partial<FeedPreferences>) : {};
    return {
      sources: { ...ALL_ON, ...parsed.sources },
      defaultTab: parsed.defaultTab === "latest" ? "latest" : "top",
    };
  } catch {
    return { sources: ALL_ON, defaultTab: "top" };
  }
}

/** Instant save: every change is written at once; the previous value stays for undo. */
export function useFeedPreferences(projectId: string) {
  const [prefs, setPrefs] = useState<FeedPreferences>(() =>
    readFeedPreferences(globalThis.localStorage?.getItem(storageKey(projectId)) ?? null),
  );
  const [undo, setUndo] = useState<{ prev: FeedPreferences; label: string } | null>(null);
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 8000);
    return () => clearTimeout(timer);
  }, [undo]);
  const write = (next: FeedPreferences) => {
    setPrefs(next);
    try {
      globalThis.localStorage?.setItem(storageKey(projectId), JSON.stringify(next));
    } catch {
      // Local convenience only; a full storage keeps the change for this session.
    }
  };
  const change = (next: FeedPreferences, label: string) => {
    setUndo({ prev: prefs, label });
    write(next);
  };
  const revert = () => {
    if (undo) write(undo.prev);
    setUndo(null);
  };
  return { prefs, change, undo, revert } as const;
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

export function FeedSettingsSheet(props: {
  readonly title: string;
  readonly language: "de" | "en";
  readonly rows: readonly FeedSourceRow[];
  readonly prefs: FeedPreferences;
  readonly onChange: (next: FeedPreferences, label: string) => void;
  readonly undo: { readonly label: string } | null;
  readonly onUndo: () => void;
  readonly onClose: () => void;
}) {
  const de = props.language === "de";
  const [tab, setTab] = useState<"sources" | "display">("sources");
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && props.onClose();
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  });
  const groups = [...new Set(props.rows.map((row) => row.group))];
  const allOn = props.rows.every((row) => props.prefs.sources[row.key]);
  const setAll = (value: boolean) =>
    props.onChange(
      {
        ...props.prefs,
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
  const tabClass = (active: boolean) =>
    "rounded-md px-2.5 py-1.5 text-[13px] font-semibold " +
    (active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground");
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
      <div role="tablist" className="mx-5 flex gap-1 rounded-lg border border-border p-1">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "sources"}
          onClick={() => setTab("sources")}
          className={tabClass(tab === "sources")}
        >
          {de ? "Quellen & Accounts" : "Sources & accounts"}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "display"}
          onClick={() => setTab("display")}
          className={tabClass(tab === "display")}
        >
          {de ? "Darstellung" : "Display"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {tab === "sources" ? (
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
                          checked={props.prefs.sources[row.key]}
                          onCheckedChange={(value) => {
                            const checked = value === true;
                            props.onChange(
                              {
                                ...props.prefs,
                                sources: { ...props.prefs.sources, [row.key]: checked },
                              },
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
        ) : (
          <fieldset className="space-y-2">
            <legend className="mb-2 text-[14px] font-bold">
              {de ? "Beim Öffnen zeigen" : "Show on open"}
            </legend>
            {(["top", "latest"] as const).map((value) => (
              <label
                key={value}
                className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-2.5 text-[14px]"
              >
                <input
                  type="radio"
                  name="feed-default-tab"
                  className="size-4 accent-blue-500"
                  checked={props.prefs.defaultTab === value}
                  onChange={() =>
                    props.onChange(
                      { ...props.prefs, defaultTab: value },
                      value === "top" ? "Top" : de ? "Neueste" : "Latest",
                    )
                  }
                />
                <span className="font-semibold">
                  {value === "top" ? "Top" : de ? "Neueste zuerst" : "Newest first"}
                </span>
                <span className="text-muted-foreground">
                  {value === "top"
                    ? de
                      ? "Störungen und PRs oben"
                      : "Disruptions and PRs first"
                    : de
                      ? "streng nach Zeit"
                      : "strictly by time"}
                </span>
              </label>
            ))}
          </fieldset>
        )}
      </div>
      <footer
        className="flex min-h-12 items-center justify-between gap-3 border-t border-border px-5 py-2 text-[13px] text-muted-foreground"
        role="status"
      >
        {props.undo ? (
          <>
            <span>
              {de ? "Gespeichert" : "Saved"}: {props.undo.label}
            </span>
            <button
              type="button"
              onClick={props.onUndo}
              className="inline-flex items-center gap-1 rounded-md bg-muted px-2.5 py-1 font-semibold text-foreground hover:bg-muted/70"
            >
              <Undo2Icon aria-hidden className="size-3.5" />
              {de ? "Rückgängig" : "Undo"}
            </button>
          </>
        ) : (
          <span>
            {de
              ? "Änderungen gelten sofort und werden auf diesem Gerät gespeichert."
              : "Changes apply at once and are saved on this device."}
          </span>
        )}
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
      {props.language === "de" ? "Quellen" : "Sources"}
    </button>
  );
}
