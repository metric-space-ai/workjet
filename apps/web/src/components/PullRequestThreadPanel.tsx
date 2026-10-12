import type { EnvironmentId, ThreadId } from "@workjet/contracts";
import { isAtomCommandInterrupted } from "@workjet/client-runtime/state/runtime";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  readCachedPullRequestResolution,
  usePreparePullRequestThreadAction,
  usePullRequestResolution,
} from "~/lib/sourceControlActions";
import { cn } from "~/lib/utils";
import { parsePullRequestReference } from "~/pullRequestReference";
import { getSourceControlPresentation } from "~/sourceControlPresentation";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";

interface PullRequestThreadPanelProps {
  open: boolean;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  cwd: string | null;
  initialReference: string | null;
  onOpenChange: (open: boolean) => void;
  onPrepared: (input: { branch: string; worktreePath: string | null }) => Promise<void> | void;
}

/**
 * PR auschecken als Inhalt der rechten Leiste (inline, kein Dialog):
 * Referenz eingeben, aufgelösten PR sehen, „Lokal“ oder „Worktree“.
 */
export function PullRequestThreadPanel({
  open,
  environmentId,
  threadId,
  cwd,
  initialReference,
  onOpenChange,
  onPrepared,
}: PullRequestThreadPanelProps) {
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState(initialReference ?? "");
  const [referenceDirty, setReferenceDirty] = useState(false);
  const [preparingMode, setPreparingMode] = useState<"local" | "worktree" | null>(null);
  const [debouncedReference, referenceDebouncer] = useDebouncedValue(
    reference,
    { wait: 450 },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const { data: gitStatus } = useEnvironmentQuery(
    cwd === null
      ? null
      : vcsEnvironment.status({
          environmentId,
          input: { cwd },
        }),
  );
  const sourceControlPresentation = useMemo(
    () => getSourceControlPresentation(gitStatus?.sourceControlProvider),
    [gitStatus?.sourceControlProvider],
  );
  const terminology = sourceControlPresentation.terminology;
  const SourceControlIcon = sourceControlPresentation.Icon;

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      referenceInputRef.current?.focus();
      referenceInputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  const parsedReference = parsePullRequestReference(reference);
  const parsedDebouncedReference = parsePullRequestReference(debouncedReference);
  const sourceControlScope = useMemo(
    () => ({
      environmentId,
      cwd,
    }),
    [cwd, environmentId],
  );
  const pullRequestResolution = usePullRequestResolution({
    ...sourceControlScope,
    reference: open ? parsedDebouncedReference : null,
  });
  const cachedPullRequest = useMemo(() => {
    return (
      readCachedPullRequestResolution({
        ...sourceControlScope,
        reference: parsedReference,
      })?.pullRequest ?? null
    );
  }, [parsedReference, sourceControlScope]);
  const preparePullRequestThreadAction = usePreparePullRequestThreadAction(sourceControlScope);

  const liveResolvedPullRequest =
    parsedReference !== null && parsedReference === parsedDebouncedReference
      ? (pullRequestResolution.data?.pullRequest ?? null)
      : null;
  const resolvedPullRequest = liveResolvedPullRequest ?? cachedPullRequest;
  const isResolving =
    open &&
    parsedReference !== null &&
    resolvedPullRequest === null &&
    (referenceDebouncer.state.isPending ||
      parsedReference !== parsedDebouncedReference ||
      pullRequestResolution.isPending ||
      pullRequestResolution.isFetching);
  const statusTone = useMemo(() => {
    switch (resolvedPullRequest?.state) {
      case "merged":
        return "text-violet-600 dark:text-violet-300/90";
      case "closed":
        return "text-zinc-500 dark:text-zinc-400/80";
      case "open":
        return "text-emerald-600 dark:text-emerald-300/90";
      default:
        return "text-muted-foreground";
    }
  }, [resolvedPullRequest?.state]);

  const handleConfirm = useCallback(
    async (mode: "local" | "worktree") => {
      if (!parsedReference) {
        setReferenceDirty(true);
        return;
      }
      if (!parsedReference || !resolvedPullRequest || !cwd) {
        return;
      }
      setPreparingMode(mode);
      const result = await preparePullRequestThreadAction.run({
        reference: parsedReference,
        mode,
        ...(mode === "worktree" ? { threadId } : {}),
      });
      setPreparingMode(null);
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          preparePullRequestThreadAction.resetError();
        }
        return;
      }
      await onPrepared({
        branch: result.value.branch,
        worktreePath: result.value.worktreePath,
      });
      onOpenChange(false);
    },
    [
      cwd,
      onOpenChange,
      onPrepared,
      parsedReference,
      preparePullRequestThreadAction,
      resolvedPullRequest,
      threadId,
    ],
  );

  const validationMessage = !referenceDirty
    ? null
    : reference.trim().length === 0
      ? "Link, Befehl oder #123 eingeben"
      : parsedReference === null
        ? "Link, Befehl, 123 oder #123"
        : null;
  const errorMessage =
    validationMessage ??
    (resolvedPullRequest === null && pullRequestResolution.error
      ? pullRequestResolution.error
      : preparePullRequestThreadAction.error instanceof Error
        ? preparePullRequestThreadAction.error.message
        : preparePullRequestThreadAction.error
          ? "Vorbereiten fehlgeschlagen"
          : null);
  const busy = preparePullRequestThreadAction.isPending;
  const confirmDisabled = !cwd || !resolvedPullRequest || isResolving || busy;
  const stateLabel =
    resolvedPullRequest?.state === "merged"
      ? "gemergt"
      : resolvedPullRequest?.state === "closed"
        ? "geschlossen"
        : resolvedPullRequest?.state === "open"
          ? "offen"
          : (resolvedPullRequest?.state ?? "");

  if (!open) return null;
  return (
    <section
      aria-label={`${terminology.shortLabel} auschecken`}
      className="flex min-w-0 flex-col gap-3 p-3"
      data-pull-request-checkout-panel="true"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          onOpenChange(false);
        }
      }}
    >
      <div className="flex items-center gap-2 font-medium text-[13.5px]">
        <SourceControlIcon className="size-4" />
        {terminology.shortLabel} auschecken
      </div>
      <Input
        ref={referenceInputRef}
        aria-label={terminology.shortLabel}
        placeholder="Link, Befehl oder #42"
        value={reference}
        onChange={(event) => {
          setReferenceDirty(true);
          setReference(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter") {
            return;
          }
          event.preventDefault();
          if (!isResolving && !busy) {
            void handleConfirm("local");
          }
        }}
      />

      {resolvedPullRequest ? (
        <div className="flex min-w-0 items-start justify-between gap-3 rounded-lg border px-3 py-2">
          <div className="min-w-0">
            <p className="truncate font-medium text-[13.5px]">{resolvedPullRequest.title}</p>
            <p className="truncate text-muted-foreground text-xs">
              #{resolvedPullRequest.number} · {resolvedPullRequest.headBranch} →{" "}
              {resolvedPullRequest.baseBranch}
            </p>
          </div>
          <span className={cn("shrink-0 text-xs", statusTone)}>{stateLabel}</span>
        </div>
      ) : null}

      {isResolving ? (
        <div role="status" className="flex items-center gap-2 text-muted-foreground text-xs">
          <Spinner className="size-3.5" />
          Wird aufgelöst…
        </div>
      ) : null}

      {errorMessage ? (
        <p role="alert" className="text-destructive text-xs">
          {errorMessage}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onOpenChange(false)}
          disabled={busy}
        >
          Abbrechen
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void handleConfirm("local");
          }}
          disabled={confirmDisabled}
        >
          {preparingMode === "local" ? "Bereitet vor…" : "Lokal"}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            void handleConfirm("worktree");
          }}
          disabled={confirmDisabled}
        >
          {preparingMode === "worktree" ? "Bereitet vor…" : "Worktree"}
        </Button>
      </div>
    </section>
  );
}
