/**
 * Welcher Leerzustand gewinnt, und dass jeder genau einen Button hat. Die
 * Komponente wird als Funktion aufgerufen und ihr Baum nach Text gelesen; die
 * Elemente werden nur durchlaufen, nie gerendert.
 */
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Button } from "../ui/button";
import { PULL_REQUEST_LIST_LOADING_TIMEOUT_MS, PullRequestListLoading } from "./PullRequestGhosts";
import { PullRequestListEmptyState } from "./PullRequestListEmptyState";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!isValidElement(node)) return "";
  return textOf((node as ReactElement<{ children?: ReactNode }>).props.children);
}

function countButtons(node: ReactNode): number {
  if (Array.isArray(node)) return node.reduce((sum: number, child) => sum + countButtons(child), 0);
  if (!isValidElement(node)) return 0;
  const self = node.type === Button ? 1 : 0;
  return self + countButtons((node as ReactElement<{ children?: ReactNode }>).props.children);
}

const baseProps = {
  query: "",
  filtered: false,
  searching: false,
  hasProjects: true,
  canLoadMore: false,
  loadingMore: false,
  refreshing: false,
  onClearQuery: () => {},
  onLoadMore: () => {},
  onRefresh: () => {},
};

function tree(props: Partial<typeof baseProps>): ReactNode {
  return PullRequestListEmptyState({ ...baseProps, ...props });
}

function render(props: Partial<typeof baseProps>): string {
  return textOf(tree(props));
}

describe("PullRequestListEmptyState", () => {
  it("fragt zuerst nach einem Projekt, vor Suche und Filter", () => {
    const text = render({ hasProjects: false, searching: true, query: "fix", filtered: true });
    expect(text).toContain("Keine Projekte");
    expect(text).toContain("Projekt hinzufügen");
  });

  it("zeigt bei laufender Suche das Laden mit Frist statt eines Leerzustands", () => {
    const node = tree({ searching: true, query: "fix" });
    expect(isValidElement(node) && node.type === PullRequestListLoading).toBe(true);
  });

  it("hat in jedem Leerzustand genau einen Button", () => {
    for (const props of [
      { hasProjects: false },
      {},
      { filtered: true },
      { query: "fix" },
      { canLoadMore: true },
    ]) {
      expect(countButtons(tree(props))).toBe(1);
    }
  });

  it("bietet nach der Antwort der Hosts genau die passende Aktion", () => {
    expect(render({})).toContain("Erneut prüfen");
    expect(render({ filtered: true })).toContain("Keine Treffer mit Filter");
    expect(render({ query: "fix" })).toContain("Suche löschen");
    expect(render({ canLoadMore: true })).toContain("Mehr laden");
    expect(render({ refreshing: true })).toContain("Prüft …");
  });
});

describe("PullRequestListLoading", () => {
  it("zeigt zuerst Platzhalterzeilen und endet nach 10 s (UI-Vertrag §1.3)", () => {
    expect(PULL_REQUEST_LIST_LOADING_TIMEOUT_MS).toBe(10_000);
    const html = renderToStaticMarkup(<PullRequestListLoading rows={3} onRetry={() => {}} />);
    expect(html).toContain('role="status"');
    expect(html).not.toContain("Erneut versuchen");
  });
});
