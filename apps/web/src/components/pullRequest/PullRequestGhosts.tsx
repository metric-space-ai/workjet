/**
 * Loading states specific to the pull request surface — the first list, a search under way,
 * and a detail panel opening — use bars in the geometry of the content they stand for, pulsing
 * on one composited layer. Diff loading uses the shared diff-panel skeleton instead.
 *
 * Deliberately not the app's shimmer skeleton. The sweep is a `transform` animation per bar —
 * compositor-safe, but a layer for every bar on screen — and its white highlight over the
 * near-white `muted` base all but disappears in light mode. Here one `animate-ghost-pulse` on the
 * container is a single opacity animation however many bars sit under it, and the bars take
 * their tone from `muted-foreground` at low alpha, which reads on both themes.
 */
import { ClockIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "~/lib/utils";

import { Banner } from "../ui/banner";

function GhostBar({ className }: { className?: string | undefined }) {
  return <div aria-hidden className={cn("h-3 rounded bg-muted-foreground/15", className)} />;
}

/** Widths cycle rather than randomize, so the ghost renders the same on every pass. */
const TITLE_WIDTHS = ["w-3/5", "w-2/5", "w-1/2", "w-2/3", "w-2/5", "w-3/5", "w-1/2"];
const META_WIDTHS = ["w-2/5", "w-1/3", "w-2/5", "w-1/4", "w-1/3", "w-2/5", "w-1/3"];

/** Rows in the list's own grid — glyph, title over meta, time over diffstat. */
export function PullRequestListGhost({
  rows = 7,
  caption,
}: {
  rows?: number;
  /** Said where the group headers speak, for the states with something to say — a search. */
  caption?: string;
}) {
  return (
    <div
      role="status"
      aria-label={caption ?? "Pull Requests laden"}
      className="animate-ghost-pulse space-y-0.5"
    >
      {caption ? (
        <p className="px-3 pb-1 text-xs font-medium text-muted-foreground/70">{caption}</p>
      ) : null}
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-3 py-2"
        >
          <GhostBar className="size-4 rounded-full" />
          <div className="min-w-0 space-y-1.5">
            <GhostBar className={cn("h-3.5", TITLE_WIDTHS[index % TITLE_WIDTHS.length])} />
            <GhostBar
              className={cn("bg-muted-foreground/10", META_WIDTHS[index % META_WIDTHS.length])}
            />
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <GhostBar className="w-12" />
            <GhostBar className="w-16 bg-muted-foreground/10" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The summary's own shape: a title, a byline, the facts rows, the description. */
export function PullRequestDetailGhost() {
  return (
    <div
      role="status"
      aria-label="Pull Request lädt"
      className="animate-ghost-pulse space-y-6 px-4 py-5"
    >
      <div className="space-y-2">
        <GhostBar className="h-5 w-4/5" />
        <GhostBar className="w-2/5 bg-muted-foreground/10" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex items-center gap-3">
            <GhostBar className="size-3.5 rounded-full" />
            <GhostBar className="w-20 bg-muted-foreground/10" />
            <GhostBar className={TITLE_WIDTHS[(index + 1) % TITLE_WIDTHS.length]} />
          </div>
        ))}
      </div>
      <div className="space-y-2 pt-1">
        <GhostBar className="w-full bg-muted-foreground/10" />
        <GhostBar className="w-11/12 bg-muted-foreground/10" />
        <GhostBar className="w-4/5 bg-muted-foreground/10" />
        <GhostBar className="w-2/3 bg-muted-foreground/10" />
      </div>
    </div>
  );
}

/** People-shaped: an avatar and a name, in the reviewer picker's own row height. */
export function PullRequestPeopleGhost({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Personen laden" className="animate-ghost-pulse space-y-1 p-1">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-7 items-center gap-2 rounded-md px-2">
          <GhostBar className="size-4 rounded-full" />
          <GhostBar className={META_WIDTHS[index % META_WIDTHS.length]} />
        </div>
      ))}
    </div>
  );
}

/** The timeline's own shape: dots on the rail, a line and a date to each. */
export function PullRequestTimelineGhost({ rows = 6 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Verlauf lädt" className="animate-ghost-pulse px-4 py-5">
      <div className="relative ml-2 border-l border-border/70 pl-5">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="relative pb-5">
            <GhostBar className="absolute -left-[1.55rem] top-1 size-2 rounded-full" />
            <GhostBar className={cn("h-3.5", TITLE_WIDTHS[index % TITLE_WIDTHS.length])} />
            <GhostBar className="mt-1.5 w-16 bg-muted-foreground/10" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** A compact placeholder for the conversation while the core detail is already readable. */
export function PullRequestConversationGhost({ rows = 3 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-label="Unterhaltung lädt"
      className="animate-ghost-pulse space-y-4 py-2"
    >
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-start gap-2">
          <GhostBar className="size-5 shrink-0 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <GhostBar className={META_WIDTHS[index % META_WIDTHS.length]} />
            <GhostBar className="w-full bg-muted-foreground/10" />
            <GhostBar className="w-3/4 bg-muted-foreground/10" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Nach dieser Zeit endet das Laden sichtbar (UI-Vertrag §1.3). */
export const PULL_REQUEST_LIST_LOADING_TIMEOUT_MS = 10_000;

/**
 * Laden mit Ende: höchstens 10 s Platzhalterzeilen, danach EINE Statuszeile
 * mit „Erneut versuchen“, nie ein endloses Skeleton. Ein Klick auf „Erneut
 * versuchen“ fragt neu und startet die Frist von vorn.
 */
export function PullRequestListLoading({
  rows = 7,
  caption,
  onRetry,
  timeoutMs = PULL_REQUEST_LIST_LOADING_TIMEOUT_MS,
}: {
  rows?: number;
  caption?: string;
  onRetry: () => void;
  timeoutMs?: number;
}) {
  const [attempt, setAttempt] = useState(0);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), timeoutMs);
    return () => clearTimeout(timer);
  }, [attempt, timeoutMs]);
  if (slow) {
    return (
      <Banner
        icon={ClockIcon}
        action={{
          label: "Erneut versuchen",
          onClick: () => {
            onRetry();
            setSlow(false);
            setAttempt((value) => value + 1);
          },
        }}
      >
        Pull Requests laden länger als erwartet.
      </Banner>
    );
  }
  return <PullRequestListGhost rows={rows} {...(caption === undefined ? {} : { caption })} />;
}
