import type { PullRequestMergeability, PullRequestState } from "@workjet/contracts";
import { memo, useState } from "react";

import { cn } from "~/lib/utils";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";
import { formatRelativeTimeLabel } from "~/timestampFormat";

import { Row, type RowStatus } from "../ui/row";
import { PullRequestChecksChip, PullRequestChecksList } from "./PullRequestChecksPopover";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { openOnHostLabel, showPullRequestLinkContextMenu } from "./pullRequestLinkContextMenu";
import { PullRequestDiffStat, resolvePullRequestState } from "./pullRequestPresentation";

/**
 * Statuspunkt der Zeile: offen grün, Entwurf gelb (in Arbeit), Konflikt rot,
 * zusammengeführt oder geschlossen grau (erledigt).
 */
export function pullRequestRowStatus(input: {
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly mergeability?: PullRequestMergeability | undefined;
}): RowStatus {
  if (input.state !== "open") return "off";
  if (input.isDraft) return "busy";
  if (input.mergeability === "conflicting") return "error";
  return "ok";
}

/**
 * Eine PR als Zeile (UI-Vertrag §1.2): Statuspunkt, Nummer und Titel, Branch
 * als Meta, Checks als Chip. Der Name ist der Button, der die PR öffnet; der
 * Checks-Chip klappt die Checks inline unter der Zeile auf.
 */
function PullRequestRowImpl({
  entry,
  selected,
  showProjectTitle,
  showProvider,
  environmentLabel,
  matchedElsewhere,
  onSelect,
}: {
  entry: EnvironmentPullRequestEntry;
  selected: boolean;
  showProjectTitle: boolean;
  /** Nur bei mehreren Hosts; der Host steht dann in der Meta-Zeile. */
  showProvider: boolean;
  /** Der Server, von dem die Zeile kommt, wenn die Liste mehrere umfasst. */
  environmentLabel?: string;
  /** Die Suche traf etwas, das die Zeile nicht zeigt (Beschreibung, Kommentar). */
  matchedElsewhere?: boolean;
  onSelect: (entry: EnvironmentPullRequestEntry) => void;
}) {
  const [checksOpen, setChecksOpen] = useState(false);
  const status = pullRequestRowStatus(entry);
  const statusLabel = resolvePullRequestState({
    state: entry.state,
    isDraft: entry.isDraft,
    ...(entry.mergeability ? { mergeability: entry.mergeability } : {}),
    baseBranch: entry.baseBranch,
  }).label;
  const metaParts = [
    entry.headBranch,
    showProvider ? getSourceControlPresentationForKind(entry.provider).providerName : null,
    showProjectTitle ? entry.repository : null,
    environmentLabel ?? null,
    entry.author?.login ?? null,
  ].filter((part): part is string => part !== null && part.length > 0);

  return (
    <div
      className={cn(
        "rounded-lg transition-colors",
        // Zeilen außerhalb des Sichtfelds überspringen Stil, Layout und Malen.
        "[contain-intrinsic-block-size:52px] [content-visibility:auto]",
        selected ? "bg-accent" : "hover:bg-accent/60",
      )}
      data-slot="pull-request-row"
      data-selected={selected ? "true" : undefined}
    >
      <Row
        className="relative"
        status={status}
        statusLabel={statusLabel}
        name={
          <button
            type="button"
            aria-current={selected ? "true" : undefined}
            onClick={() => onSelect(entry)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void showPullRequestLinkContextMenu({
                url: entry.url,
                openLabel: openOnHostLabel(entry.provider),
                position: { x: event.clientX, y: event.clientY },
              });
            }}
            title={entry.title}
            className="min-w-0 max-w-full truncate text-left outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-1 focus-visible:after:ring-ring"
          >
            <span className="mr-1.5 font-normal text-muted-foreground tabular-nums">
              #{entry.number}
            </span>
            {entry.title}
          </button>
        }
        meta={
          <span className="font-mono text-[12px]" title={metaParts.join(" · ")}>
            {metaParts.join(" · ")}
          </span>
        }
        chips={
          <>
            {entry.reviewDecision === "approved" ? (
              <span className="hidden rounded-full border border-emerald-500/40 px-1.5 text-[11px] text-emerald-600 sm:inline dark:text-emerald-400/90">
                Freigegeben
              </span>
            ) : entry.reviewDecision === "changes-requested" ? (
              <span className="hidden rounded-full border border-amber-500/40 px-1.5 text-[11px] text-amber-600 sm:inline dark:text-amber-400/90">
                Änderungen
              </span>
            ) : null}
            {matchedElsewhere ? (
              <span className="hidden rounded-full border border-border/60 px-1.5 text-[11px] text-muted-foreground sm:inline">
                Treffer im Text
              </span>
            ) : null}
            {entry.checksState === undefined ? null : (
              <PullRequestChecksChip
                className="relative z-10"
                checksState={entry.checksState}
                expanded={checksOpen}
                onToggle={() => setChecksOpen((open) => !open)}
              />
            )}
            <span className="hidden flex-col items-end text-[11px] text-muted-foreground tabular-nums sm:flex">
              <span>{formatRelativeTimeLabel(entry.updatedAt)}</span>
              <PullRequestDiffStat additions={entry.additions} deletions={entry.deletions} />
            </span>
          </>
        }
      />
      {checksOpen && entry.checksState !== undefined ? (
        <PullRequestChecksList
          className="pl-8"
          environmentId={entry.environmentId}
          reference={{
            projectId: entry.projectId,
            repository: entry.repository,
            number: entry.number,
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Memoisiert: die Liste rendert bei jedem Tastendruck der Suche neu; eine
 * Zeile mit unveränderter PR, Auswahl und Trefferlage hat nichts Neues.
 */
export const PullRequestRow = memo(PullRequestRowImpl);
