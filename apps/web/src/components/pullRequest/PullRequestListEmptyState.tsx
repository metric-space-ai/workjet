/**
 * Leerzustand der PR-Liste (UI-Vertrag §1.3): Titel mit höchstens vier
 * Wörtern und genau ein Button. Kein Absatz, keine Illustration.
 *
 * Reihenfolge: ohne Projekt hilft weder Suche noch Filter; eine laufende Suche
 * zeigt die Platzhalterzeilen mit Frist; danach Suche, Filter, leer.
 */
import { PlusIcon, RefreshCwIcon, SearchIcon } from "lucide-react";

import { openCommandPalette } from "../../commandPaletteBus";
import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "../ui/empty";
import { PullRequestListLoading } from "./PullRequestGhosts";

function shortQuery(query: string): string {
  return query.length > 32 ? `${query.slice(0, 32)}…` : query;
}

export function PullRequestListEmptyState({
  query,
  filtered,
  searching,
  hasProjects,
  canLoadMore,
  loadingMore,
  refreshing,
  onClearQuery,
  onLoadMore,
  onRefresh,
}: {
  /** Der Suchtext, damit der Titel sagt, wonach gesucht wurde. */
  query: string;
  /** Ein Status-, Beteiligungs- oder Projektfilter schränkt die Liste ein. */
  filtered: boolean;
  /** Eine Suche läuft; die Zeilen auf dem Schirm sind die vorige Antwort. */
  searching: boolean;
  /** Ob es überhaupt ein Projekt gibt; ohne Projekt gibt es keinen Host zu fragen. */
  hasProjects: boolean;
  canLoadMore: boolean;
  loadingMore: boolean;
  /** Ein erneutes Lesen läuft schon, von hier oder aus dem Kopf. */
  refreshing: boolean;
  onClearQuery: () => void;
  onLoadMore: () => void;
  onRefresh: () => void;
}) {
  if (!hasProjects) {
    return (
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyTitle className="text-[22px]">Keine Projekte</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" onClick={() => openCommandPalette({ open: "add-project" })}>
            <PlusIcon className="size-3.5" />
            Projekt hinzufügen
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  if (searching) {
    return (
      <PullRequestListLoading
        rows={5}
        caption={`Suche „${shortQuery(query)}“`}
        onRetry={onRefresh}
      />
    );
  }

  if (query.length > 0) {
    return (
      <Empty className="py-16">
        <EmptyHeader>
          <EmptyTitle className="text-[22px]">Kein Treffer: „{shortQuery(query)}“</EmptyTitle>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={onClearQuery}>
            <SearchIcon className="size-3.5" />
            Suche löschen
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <Empty className="py-16">
      <EmptyHeader>
        <EmptyTitle className="text-[22px]">
          {filtered ? "Keine Treffer mit Filter" : "Keine Pull Requests"}
        </EmptyTitle>
      </EmptyHeader>
      <EmptyContent>
        {canLoadMore ? (
          <Button size="sm" variant="outline" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? "Lädt …" : "Mehr laden"}
          </Button>
        ) : (
          <Button size="sm" variant="outline" disabled={refreshing} onClick={onRefresh}>
            <RefreshCwIcon className="size-3.5" />
            {refreshing ? "Prüft …" : "Erneut prüfen"}
          </Button>
        )}
      </EmptyContent>
    </Empty>
  );
}
