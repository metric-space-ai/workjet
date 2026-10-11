/**
 * Checks einer Pull Request, inline statt als Popover (drei Orte, keine Popups).
 *
 * `PullRequestChecksChip` ist der Chip mit dem Sammelstatus; ein Klick klappt
 * `PullRequestChecksList` direkt unter der Zeile bzw. dem Kopf auf. Ohne
 * mitgegebene Checks (Listenzeile) liest die Liste das Detail erst beim
 * Aufklappen: eine Seite voller Zeilen wären sonst hundert Anfragen.
 */
import type {
  EnvironmentId,
  PullRequestCheck,
  PullRequestChecksState,
  PullRequestRef,
} from "@workjet/contracts";
import { ChevronDownIcon, ExternalLinkIcon } from "lucide-react";

import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  PullRequestCheckStatusIcon,
  pullRequestCheckStatusLabel,
  pullRequestChecksStatePresentation,
} from "./pullRequestPresentation";

function LazyChecksBody({
  environmentId,
  reference,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
}) {
  const detailQuery = useEnvironmentQuery(
    pullRequestEnvironment.detail({ environmentId, input: reference }),
  );
  if (detailQuery.error !== null) {
    return (
      <p className="text-muted-foreground text-xs" role="status">
        Prüfungen nicht verfügbar
      </p>
    );
  }
  if (detailQuery.data === null) {
    return (
      <p className="text-muted-foreground text-xs" role="status">
        {detailQuery.isPending ? "Prüfungen laden …" : "Keine Prüfungen"}
      </p>
    );
  }
  return <ChecksBody checks={detailQuery.data.checks} />;
}

function ChecksBody({ checks }: { checks: ReadonlyArray<PullRequestCheck> }) {
  if (checks.length === 0) {
    return <p className="text-muted-foreground text-xs">Keine Prüfungen</p>;
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {/* Nach Position und Name: der Host entscheidet, wie viele Läufe einen Namen teilen. */}
      {checks.map((check, index) => (
        <li
          key={`${index}:${check.name}`}
          className="flex min-h-7 items-center gap-2 text-xs"
          data-slot="pull-request-check"
        >
          <PullRequestCheckStatusIcon status={check.status} />
          <span className="min-w-0 flex-1 truncate" title={check.description ?? check.name}>
            {check.name}
          </span>
          <span className="shrink-0 text-muted-foreground">
            {pullRequestCheckStatusLabel(check.status)}
          </span>
          {check.url === null ? null : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`${check.name} öffnen`}
                    onClick={() => void readLocalApi()?.shell.openExternal(check.url ?? "")}
                  />
                }
              >
                <ExternalLinkIcon className="size-3" />
              </TooltipTrigger>
              <TooltipPopup>Öffnen</TooltipPopup>
            </Tooltip>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Chip mit dem Sammelstatus. Ein echter Button; die Liste darunter klappt der
 * Aufrufer über `expanded`/`onToggle` auf.
 */
export function PullRequestChecksChip({
  checksState,
  summary,
  expanded,
  onToggle,
  className,
}: {
  checksState: PullRequestChecksState;
  /** Zählung wie „2 von 5 fehlgeschlagen“, wo die Prüfungen bekannt sind. */
  summary?: string | null;
  expanded: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const presentation = pullRequestChecksStatePresentation(checksState);
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={`Prüfungen: ${summary ?? presentation.label}`}
      data-slot="pull-request-checks-chip"
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-border/70 px-1.5 text-[11px] text-muted-foreground outline-none transition-colors hover:border-foreground/30 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        expanded && "border-foreground/30 text-foreground",
        className,
      )}
    >
      <presentation.Icon aria-hidden className={cn("size-3", presentation.toneClassName)} />
      {/* Bei 420 px nur das Zeichen: der Titel braucht die Breite. */}
      <span className="hidden whitespace-nowrap sm:inline">{summary ?? presentation.label}</span>
      <ChevronDownIcon
        aria-hidden
        className={cn("size-3 transition-transform", expanded ? "rotate-180" : "")}
      />
    </button>
  );
}

/**
 * Die aufgeklappte Liste. Mit `checks` wird nichts gelesen (Detailkopf); ohne
 * sie liest die Liste das Detail selbst (Listenzeile).
 */
export function PullRequestChecksList({
  checks,
  environmentId,
  reference,
  className,
}: {
  checks?: ReadonlyArray<PullRequestCheck>;
  environmentId?: EnvironmentId;
  reference?: PullRequestRef;
  className?: string;
}) {
  return (
    <div className={cn("px-3 pb-2", className)} data-slot="pull-request-checks-list">
      {checks !== undefined ? (
        <ChecksBody checks={checks} />
      ) : environmentId !== undefined && reference !== undefined ? (
        <LazyChecksBody environmentId={environmentId} reference={reference} />
      ) : null}
    </div>
  );
}
