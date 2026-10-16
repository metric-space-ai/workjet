import type { CtoxWorkjetProjectFeedPost } from "@workjet/contracts";
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

/** A post written by the CTOX supervisor (ctox.workjet.project_feed.v1, metric-space-ai/ctox#686). */
export type CtoxProjectFeedPost = CtoxWorkjetProjectFeedPost;

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

/**
 * A disruption in one plain sentence plus one action; the raw error stays in `details`
 * (never rendered in the feed; listed under Einstellungen › Diagnose).
 */
export function disruptionContent(input: {
  readonly name: string;
  readonly lastError: string | null | undefined;
  readonly language: ProjectOverviewLanguage;
}): ProjectFeedContent & { readonly actionLabel: string | null; readonly details: string | null } {
  const de = input.language === "de";
  const raw = input.lastError?.trim() || null;
  const plain = projectOverviewSessionError(raw ?? "", input.language);
  return {
    headline: de ? `${input.name} hängt` : `${input.name} is stuck`,
    body: plain.text,
    openItems: [],
    sources: [],
    actionLabel: plain.action,
    details: raw,
  };
}

/** A finished step is a post only with a real summary; without one there is nothing to read. */
export function stepContent(input: {
  readonly name: string;
  readonly preview: string | null | undefined;
  readonly goal: string | null;
  readonly goalDone: boolean;
  readonly language: ProjectOverviewLanguage;
}): ProjectFeedContent | null {
  const de = input.language === "de";
  const summary = plainPreview(input.preview);
  if (summary === null) return null;
  return {
    headline: de
      ? `${input.name} hat einen Arbeitsschritt abgeschlossen`
      : `${input.name} finished a work step`,
    body: summary,
    openItems:
      input.goal && !input.goalDone ? [de ? `Ziel: ${input.goal}` : `Goal: ${input.goal}`] : [],
    sources: [{ type: "session", label: de ? "Sitzung" : "Session" }],
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

/** First one or two sentences of a PR description, without markdown, checklists or templates. */
export function prSummaryFromBody(body: string | null | undefined): string | null {
  if (!body) return null;
  const cleaned = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .split("\n")
    .filter((line) => !/^\s*(#{1,6}\s|[-*]\s*\[[ xX]\]|>|\|)/.test(line))
    .filter((line) => !/^\s*(closes|fixes|resolves|refs?)\s+#\d+/i.test(line))
    .join("\n");
  const plain = plainPreview(cleaned, 2000);
  if (!plain) return null;
  const sentences = (plain.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [plain]).filter(
    (sentence) => !/^\s*(closes|fixes|resolves|refs?)\s+#?\d+[.!?]?\s*$/i.test(sentence),
  );
  const summary = sentences.slice(0, 2).join("").trim();
  return summary.length > 320 ? `${summary.slice(0, 319).trimEnd()}…` : summary || null;
}

export function mergedPrContent(input: {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly body?: string | null;
  readonly language: ProjectOverviewLanguage;
}): ProjectFeedContent {
  return {
    headline: `#${input.number} ${input.title}`,
    // Without a summary the PR card (title + link) is the content; no filler sentence.
    body: prSummaryFromBody(input.body) ?? "",
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
