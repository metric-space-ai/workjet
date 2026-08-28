import { useNavigate } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, WorkjetSessionImportCandidate } from "@t3tools/contracts";
import { CheckIcon, ExternalLinkIcon, LoaderIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const sourceLabel = (source: WorkjetSessionImportCandidate["source"]): string =>
  source === "codex" ? "Codex" : "Claude Code";

function SessionCandidateRow({
  candidate,
  checked,
  disabled,
  onCheckedChange,
  onOpen,
}: {
  readonly candidate: WorkjetSessionImportCandidate;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly onOpen: () => void;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-muted/20 sm:px-4">
      <Checkbox
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        aria-label={`Select ${candidate.title}`}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-foreground">{candidate.title}</span>
          <span className="text-[11px] font-medium text-muted-foreground">
            {sourceLabel(candidate.source)}
          </span>
          {candidate.importedThreadId ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600 dark:text-emerald-400">
              <CheckIcon className="size-3" aria-hidden /> Copied
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground/80">
          {candidate.workspaceRoot}
          {!candidate.workspaceAvailable ? " · Workspace unavailable" : ""}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground/60">
          Updated {new Date(candidate.updatedAt).toLocaleString()}
        </p>
      </div>
      {candidate.importedThreadId ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={`Open Workjet copy of ${candidate.title}`}
          onClick={onOpen}
        >
          <ExternalLinkIcon className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

export function SessionImportSection({
  environmentId,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
}) {
  const navigate = useNavigate();
  const inspection = useEnvironmentQuery(
    serverEnvironment.workjetSessionImport({ environmentId, input: { limit: 20 } }),
  );
  const runImport = useAtomCommand(serverEnvironment.importWorkjetSessions, {
    reportFailure: false,
  });
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [isImporting, setIsImporting] = useState(false);
  const activeScopeRef = useRef(true);
  const candidates = inspection.data?.candidates ?? [];
  const candidateIds = useMemo(
    () => new Set(candidates.map(({ candidateId }) => candidateId)),
    [candidates],
  );

  useEffect(() => {
    setSelected((current) => new Set([...current].filter((id) => candidateIds.has(id))));
  }, [candidateIds]);

  useEffect(() => {
    activeScopeRef.current = true;
    setSelected(new Set());
    setIsImporting(false);
    return () => {
      // Parent panels key this component by environment. A late inspection or
      // import result from the previous Business OS must not update the new
      // instance, navigate to an old draft, or emit a misleading toast.
      activeScopeRef.current = false;
    };
  }, [environmentId]);

  const importSelected = async () => {
    if (selected.size === 0 || isImporting || readOnly) return;
    setIsImporting(true);
    const result = await runImport({ environmentId, input: { candidateIds: [...selected] } });
    if (!activeScopeRef.current) return;
    setIsImporting(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Session import failed",
          description:
            error instanceof Error ? error.message : "The static copies could not be created.",
        }),
      );
      return;
    }
    const failures = result.value.items.filter(({ status }) => status === "failed");
    const copied = result.value.items.filter(({ status }) => status !== "failed");
    toastManager.add(
      stackedThreadToast({
        type: failures.length > 0 ? "error" : "success",
        title: failures.length > 0 ? "Some sessions were not copied" : "Static copies updated",
        description: `${copied.length} session${copied.length === 1 ? "" : "s"} processed${failures.length > 0 ? `, ${failures.length} failed` : ""}.`,
      }),
    );
    setSelected(new Set());
    inspection.refresh();
  };

  return (
    <SettingsSection
      title="Import sessions"
      headerAction={
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={inspection.isPending}
          aria-label="Refresh importable sessions"
          onClick={inspection.refresh}
        >
          {inspection.isPending ? (
            <LoaderIcon className="size-3.5 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3.5" />
          )}
        </Button>
      }
    >
      <SettingsRow
        title="Static copies from harness apps"
        description="Copy Codex and Claude Code conversations into independent Workjet threads. Source files are read only and never changed. Run the import again later to append new messages to the Workjet copy."
        status="No live connection, shared session, or provider resume token is created between the applications."
        control={
          <Button
            size="sm"
            disabled={readOnly || selected.size === 0 || isImporting}
            onClick={() => void importSelected()}
          >
            {isImporting ? <LoaderIcon className="size-3.5 animate-spin" /> : null}
            Import selected{selected.size > 0 ? ` (${selected.size})` : ""}
          </Button>
        }
      />
      {inspection.error ? (
        <SettingsRow title="Sessions unavailable" description={inspection.error} />
      ) : inspection.isPending && candidates.length === 0 ? (
        <SettingsRow
          title="Finding local sessions"
          description="Reading session metadata without changing the source applications."
        />
      ) : candidates.length === 0 ? (
        <SettingsRow
          title="No sessions found"
          description="No readable Codex or Claude Code conversations were found for this device's configured harness homes."
        />
      ) : (
        <div className={readOnly ? "space-y-0 opacity-60" : "space-y-0"}>
          {candidates.map((candidate) => (
            <SessionCandidateRow
              key={candidate.candidateId}
              candidate={candidate}
              checked={selected.has(candidate.candidateId)}
              disabled={readOnly || isImporting}
              onCheckedChange={(checked) =>
                setSelected((current) => {
                  const next = new Set(current);
                  if (checked) next.add(candidate.candidateId);
                  else next.delete(candidate.candidateId);
                  return next;
                })
              }
              onOpen={() => {
                if (!candidate.importedThreadId) return;
                void navigate({
                  to: "/draft/$draftId",
                  params: { draftId: candidate.importedThreadId },
                });
              }}
            />
          ))}
        </div>
      )}
      {inspection.data?.truncated ? (
        <p className="px-4 py-2 text-xs text-muted-foreground">
          Showing the newest readable sessions. Import or refresh to review later updates.
        </p>
      ) : null}
    </SettingsSection>
  );
}
