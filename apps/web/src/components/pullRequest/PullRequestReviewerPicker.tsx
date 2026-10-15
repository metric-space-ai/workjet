/**
 * Review anfragen: ein einfaches Auswahlmenü (drei Orte, keine Popups). Ein
 * Eintrag je Person oder Team, Haken = bereits angefragt. Die Liste wird erst
 * gelesen, wenn das Menü aufgeht.
 */
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestReviewerCandidate,
} from "@workjet/contracts";
import { UserPlusIcon } from "lucide-react";
import { useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";

export function PullRequestReviewerPicker({
  environmentId,
  reference,
  allowed,
  onRequested,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  /** Falsch, wo der Host die Anfrage dieses Kontos ablehnen würde. */
  allowed: boolean;
  /** Das Detail trägt die Angefragten und wird danach neu gelesen. */
  onRequested: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  // Gemountet bei geschlossenem Menü; der Host wird erst beim Öffnen gefragt.
  const candidatesQuery = useEnvironmentQuery(
    open ? pullRequestEnvironment.reviewerCandidates({ environmentId, input: reference }) : null,
  );
  const requestReviewers = useAtomCommand(pullRequestEnvironment.requestReviewers, {
    reportFailure: false,
  });
  const candidates = candidatesQuery.data?.candidates ?? [];

  const toggle = async (candidate: PullRequestReviewerCandidate) => {
    if (pending !== null) return;
    setPending(candidate.id);
    const result = await requestReviewers({
      environmentId,
      input: {
        ...reference,
        reviewers: [{ id: candidate.id, kind: candidate.kind }],
        requested: !candidate.isRequested,
      },
    });
    setPending(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: candidate.isRequested
          ? `Anfrage an ${candidate.login} nicht zurückgezogen`
          : `Review von ${candidate.login} nicht angefragt`,
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: candidate.isRequested
        ? `Anfrage an ${candidate.login} zurückgezogen`
        : `Review von ${candidate.login} angefragt`,
    });
    onRequested();
    candidatesQuery.refresh();
  };

  if (!allowed) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Button size="icon-xs" variant="ghost" disabled aria-label="Prüfung anfragen">
              <UserPlusIcon className="size-3.5" />
            </Button>
          }
        />
        <TooltipPopup side="bottom">Nur mit Schreibrecht</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label="Prüfung anfragen" />}
            />
          }
        >
          <UserPlusIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Prüfung anfragen</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" side="bottom" className="max-h-80 min-w-56">
        {candidatesQuery.isPending ? (
          <MenuItem disabled>Lädt …</MenuItem>
        ) : candidatesQuery.error !== null ? (
          <MenuItem disabled>Nicht verfügbar</MenuItem>
        ) : candidates.length === 0 ? (
          <MenuItem disabled>Niemand verfügbar</MenuItem>
        ) : (
          candidates.map((candidate) => (
            <MenuCheckboxItem
              key={`${candidate.kind}:${candidate.id}`}
              checked={candidate.isRequested}
              disabled={pending !== null}
              closeOnClick={false}
              onCheckedChange={() => void toggle(candidate)}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">
                  {candidate.name ? `${candidate.name} (${candidate.login})` : candidate.login}
                </span>
                {candidate.kind === "team" ? (
                  <span className="shrink-0 text-muted-foreground text-xs">Team</span>
                ) : null}
              </span>
            </MenuCheckboxItem>
          ))
        )}
      </MenuPopup>
    </Menu>
  );
}
