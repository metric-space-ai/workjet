import type { ProjectOverviewLanguage } from "./projectOverviewText";
import { projectOverviewSessionError } from "./projectOverviewText";

/** One readable feed message: who says what, with sources and what is still open. */
export type ProjectFeedContent = {
  readonly headline: string;
  readonly body: string;
  readonly openItems: readonly string[];
  readonly sources: readonly ProjectFeedSource[];
};
export type ProjectFeedSource = {
  readonly type: "pr" | "commit" | "session" | "file" | "meeting" | "url";
  readonly label: string;
  readonly url?: string;
};

/**
 * A post written by the CTOX supervisor (ctox.workjet.project_feed.v1,
 * metric-space-ai/ctox#686). Rendered as-is when a core delivers it.
 */
export type CtoxProjectFeedPost = {
  readonly post_id: string;
  readonly kind:
    | "pr_merged"
    | "session_completed"
    | "disruption"
    | "disruption_resolved"
    | "jour_fixe"
    | "goal_changed"
    | "owner_note";
  readonly author_kind: "supervisor" | "worker" | "owner";
  readonly author_thread: string | null;
  readonly author_label: string;
  readonly harness: string | null;
  readonly headline: string;
  readonly body: string;
  readonly open_items: readonly string[] | null;
  readonly sources: readonly { type: ProjectFeedSource["type"]; label: string; ref: string }[];
  readonly thread_ref: string | null;
  readonly occurred_at_ms: number;
};

/** Plain readable text from an assistant preview: no markdown marks, bounded. */
export function plainPreview(raw: string | null | undefined, max = 420): string | null {
  if (!raw) return null;
  const text = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function disruptionContent(input: {
  readonly name: string;
  readonly lastError: string | null | undefined;
  readonly language: ProjectOverviewLanguage;
}): ProjectFeedContent & { readonly actionLabel: string | null } {
  const de = input.language === "de";
  const plain = input.lastError
    ? projectOverviewSessionError(input.lastError, input.language)
    : null;
  const login = plain?.action != null;
  const why = plain?.text ?? (de ? "Der letzte Lauf ist abgebrochen." : "The last run stopped.");
  const todo = login
    ? de
      ? "Du meldest dich einmal im Chat an (/login); danach läuft er weiter."
      : "Sign in once in the chat (/login); it continues afterwards."
    : de
      ? "Öffne den Chat und starte den Schritt neu oder gib eine Anweisung."
      : "Open the chat and restart the step or give an instruction.";
  return {
    headline: de ? `${input.name} hängt` : `${input.name} is stuck`,
    body: `${why} ${todo}`,
    openItems: [],
    sources: [],
    actionLabel: plain?.action ?? null,
  };
}

export function stepContent(input: {
  readonly name: string;
  readonly preview: string | null | undefined;
  readonly goal: string | null;
  readonly goalDone: boolean;
  readonly language: ProjectOverviewLanguage;
}): ProjectFeedContent {
  const de = input.language === "de";
  const summary = plainPreview(input.preview);
  return {
    headline: de
      ? `${input.name} hat einen Arbeitsschritt abgeschlossen`
      : `${input.name} finished a work step`,
    body:
      summary ??
      (de
        ? "Der Schritt ist abgeschlossen; eine Zusammenfassung liegt noch nicht vor."
        : "The step is done; no summary is available yet."),
    openItems:
      input.goal && !input.goalDone ? [de ? `Ziel: ${input.goal}` : `Goal: ${input.goal}`] : [],
    sources: [{ type: "session", label: de ? "Session" : "Session" }],
  };
}

export function runningContent(input: {
  readonly name: string;
  readonly step: string;
  readonly done: number;
  readonly total: number;
  readonly language: ProjectOverviewLanguage;
}): ProjectFeedContent {
  const de = input.language === "de";
  return {
    headline: de ? `${input.name} arbeitet gerade` : `${input.name} is working`,
    body:
      input.total > 0
        ? de
          ? `Schritt ${Math.min(input.done + 1, input.total)} von ${input.total}: ${input.step}`
          : `Step ${Math.min(input.done + 1, input.total)} of ${input.total}: ${input.step}`
        : input.step,
    openItems: [],
    sources: [],
  };
}

export function mergedPrContent(input: {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly language: ProjectOverviewLanguage;
}): ProjectFeedContent {
  const de = input.language === "de";
  return {
    headline: `#${input.number} ${input.title}`,
    body: de
      ? "Nach main gemergt. Eine Zusammenfassung schreibt der Supervisor, sobald CTOX Feed-Posts liefert."
      : "Merged to main. The supervisor writes a summary once CTOX delivers feed posts.",
    openItems: [],
    sources: [{ type: "pr", label: `PR #${input.number}`, url: input.url }],
  };
}

export function ctoxPostContent(post: CtoxProjectFeedPost): ProjectFeedContent {
  return {
    headline: post.headline,
    body: post.body,
    openItems: post.open_items ?? [],
    sources: post.sources.map((source) => ({
      type: source.type,
      label: source.label,
      ...(/^https?:\/\//.test(source.ref) ? { url: source.ref } : {}),
    })),
  };
}
