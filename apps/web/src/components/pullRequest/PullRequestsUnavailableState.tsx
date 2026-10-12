import { RefreshCwIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";

/**
 * Fehlerzustand (UI-Vertrag §1.3): Titel, eine Statuszeile mit der Meldung
 * des Aufrufers und höchstens ein Button.
 */
export function PullRequestsUnavailableState({
  title = "Pull Requests nicht geladen",
  error,
  onRetry,
}: {
  title?: string;
  error: string;
  onRetry?: () => void;
}) {
  return (
    <Empty className="px-4 py-16 md:px-4">
      <EmptyHeader>
        <EmptyTitle className="text-[22px]">{title}</EmptyTitle>
        {/* Die Meldung des Aufrufers, auf zwei Zeilen begrenzt. */}
        <EmptyDescription className="line-clamp-2" title={error}>
          {error}
        </EmptyDescription>
      </EmptyHeader>
      {onRetry ? (
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RefreshCwIcon className="size-3.5" />
            Erneut versuchen
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
