import {
  WORKJET_SESSION_IMPORT_MAX_SELECTION,
  type WorkjetSessionImportCandidate,
  type WorkjetSessionImportInspection,
  type WorkjetSessionImportItemResult,
  type WorkjetSessionImportSource,
} from "@workjet/contracts";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CheckIcon,
  FolderIcon,
  MessageSquareIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import type { SessionImportProject } from "./sessionImportProject";

export const sessionImportSourceLabel = (source: WorkjetSessionImportSource) =>
  source === "codex" ? "Codex" : "Claude Code";
export const sessionImportFolderName = (path: string | null) =>
  path
    ? path
        .replace(/[\\/]+$/u, "")
        .split(/[\\/]/u)
        .at(-1) || path
    : "No recorded folder";
const inputClass =
  "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:opacity-50";

export interface SessionImportBrowserProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly inspection: WorkjetSessionImportInspection | null | undefined;
  readonly pending: boolean;
  readonly error: string | null;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly source: WorkjetSessionImportSource | "all";
  readonly onSourceChange: (source: WorkjetSessionImportSource | "all") => void;
  readonly page: number;
  readonly onPageChange: (page: number) => void;
  readonly onRefresh: () => void;
  readonly selected: ReadonlyMap<string, WorkjetSessionImportCandidate>;
  readonly onSelect: (candidate: WorkjetSessionImportCandidate, checked: boolean) => void;
  readonly onClearSelection: () => void;
  readonly onSelectAll: () => void;
  readonly preview: WorkjetSessionImportCandidate | null;
  readonly onPreview: (candidate: WorkjetSessionImportCandidate | null) => void;
  readonly projects: readonly SessionImportProject[];
  readonly destination: string;
  readonly onDestinationChange: (value: string) => void;
  readonly newProjectTitle: string;
  readonly onNewProjectTitleChange: (value: string) => void;
  readonly workspaceRoot: string;
  readonly onWorkspaceRootChange: (value: string) => void;
  readonly onPickFolder?: () => void;
  readonly canImport: boolean;
  readonly readOnly: boolean;
  readonly progress: string | null;
  readonly results: readonly WorkjetSessionImportItemResult[];
  readonly onImport: () => void;
  readonly onStop: () => void;
  readonly onOpenThread: (item: WorkjetSessionImportItemResult) => void;
}

export function SessionImportBrowser(props: SessionImportBrowserProps) {
  const busy = props.progress !== null;
  const candidates = props.inspection?.candidates ?? [];
  const first = props.preview;
  const destinationProject = props.projects.find(({ id }) => id === props.destination);
  const selectionCount = props.selected.size;
  const resultsByCandidate = new Map(props.results.map((item) => [item.candidateId, item]));
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!busy) props.onOpenChange(open);
      }}
    >
      <DialogPopup
        className="flex h-[min(780px,90dvh)] w-[calc(100vw-2rem)] max-w-6xl flex-col overflow-hidden p-0"
        bottomStickOnMobile={false}
        showCloseButton={!busy}
        data-workjet-action="session-import.browser"
      >
        <DialogHeader className="shrink-0 pb-4">
          <DialogTitle>Import conversations</DialogTitle>
          <DialogDescription>
            Choose conversations from your harnesses and copy them into a Workjet project.
          </DialogDescription>
        </DialogHeader>
        <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-6 pb-4">
          <label className="relative min-w-40 flex-1">
            <SearchIcon
              className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
              aria-hidden
            />
            <input
              className={cn(inputClass, "pl-9")}
              aria-label="Search conversations"
              placeholder="Search titles or folders…"
              value={props.query}
              disabled={busy}
              onChange={(event) => props.onQueryChange(event.target.value)}
            />
          </label>
          <div className="flex items-center gap-1" role="group" aria-label="Session source">
            {(["all", "codex", "claude-code"] as const).map((source) => (
              <Button
                key={source}
                size="sm"
                variant={props.source === source ? "secondary" : "ghost"}
                aria-pressed={props.source === source}
                disabled={busy}
                onClick={() => props.onSourceChange(source)}
              >
                {source === "all" ? "All harnesses" : sessionImportSourceLabel(source)}
              </Button>
            ))}
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh conversations"
            disabled={props.pending || busy}
            onClick={props.onRefresh}
          >
            <RefreshCwIcon className="size-4" />
          </Button>
        </div>
        <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)]">
          <div className={cn("flex min-h-0 min-w-0 flex-col", first && "max-lg:hidden")}>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-6 py-3 text-xs text-muted-foreground">
              <span>
                {props.pending
                  ? "Finding conversations…"
                  : `${candidates.length} conversations on this page`}
              </span>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || props.readOnly || props.pending || candidates.length === 0}
                onClick={() => candidates.forEach((candidate) => props.onSelect(candidate, true))}
              >
                Select page
              </Button>
              <Button
                size="xs"
                variant="ghost"
                aria-label="Select all matching conversations"
                data-workjet-action="session-import.select-all"
                disabled={busy || props.readOnly || props.pending || candidates.length === 0}
                onClick={props.onSelectAll}
              >
                Select all matches
              </Button>
            </div>
            <div
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3"
              aria-label="Importable conversations"
              aria-busy={props.pending}
            >
              {props.error ? (
                <p className="px-3 py-6 text-sm text-destructive" role="alert">
                  {props.error}
                </p>
              ) : null}
              {!props.pending && !props.error && candidates.length === 0 ? (
                <div className="px-3 py-10 text-center">
                  <MessageSquareIcon className="mx-auto mb-3 size-6 text-muted-foreground" />
                  <p className="text-sm font-medium">
                    {props.query ? "No matching conversations" : "No conversations found"}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {props.query
                      ? "Try another title, folder or harness."
                      : "Connect a computer with readable Codex or Claude Code sessions."}
                  </p>
                </div>
              ) : null}
              {candidates.map((candidate) => {
                const checked = props.selected.has(candidate.candidateId);
                const result = resultsByCandidate.get(candidate.candidateId);
                const copiedHere = candidate.importedCopies?.some(
                  (copy) => copy.projectId === props.destination,
                );
                return (
                  <div
                    key={candidate.candidateId}
                    className={cn(
                      "flex min-w-0 items-start gap-3 rounded-lg px-3 py-3 transition-colors",
                      first?.candidateId === candidate.candidateId
                        ? "bg-primary/8"
                        : "hover:bg-muted/35",
                    )}
                  >
                    <Checkbox
                      className="mt-0.5 shrink-0"
                      checked={checked}
                      disabled={busy || props.readOnly}
                      aria-label={`Select ${candidate.title}`}
                      onCheckedChange={(value) => props.onSelect(candidate, value === true)}
                    />
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Preview ${candidate.title}`}
                      aria-pressed={first?.candidateId === candidate.candidateId}
                      onClick={() => props.onPreview(candidate)}
                    >
                      <span className="line-clamp-2 break-words text-sm font-medium leading-snug">
                        {candidate.title}
                      </span>
                      <span className="mt-1.5 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="shrink-0">
                          {sessionImportSourceLabel(candidate.source)}
                        </span>
                        <span aria-hidden>·</span>
                        <span className="truncate" title={candidate.workspaceRoot ?? undefined}>
                          {sessionImportFolderName(candidate.workspaceRoot)}
                        </span>
                        <span className="ml-auto shrink-0">
                          {new Date(candidate.updatedAt).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                        </span>
                      </span>
                      {result?.status === "failed" ? (
                        <span className="mt-1 block text-xs text-destructive">
                          {result.message}
                        </span>
                      ) : copiedHere || candidate.importedThreadId ? (
                        <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                          <CheckIcon className="size-3" />
                          {copiedHere ? "Already in this project" : "Previously imported"}
                        </span>
                      ) : null}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="flex shrink-0 items-center justify-between border-t px-6 py-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={props.page === 0 || props.pending || busy}
                onClick={() => props.onPageChange(props.page - 1)}
              >
                <ArrowLeftIcon className="size-3.5" />
                Previous
              </Button>
              <span className="text-xs text-muted-foreground">Page {props.page + 1}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={!props.inspection?.nextOffset || props.pending || busy}
                onClick={() => props.onPageChange(props.page + 1)}
              >
                Next
                <ArrowRightIcon className="size-3.5" />
              </Button>
            </div>
          </div>
          <div
            className={cn(
              "min-h-0 min-w-0 overflow-y-auto border-l bg-muted/15 p-6",
              !first && "max-lg:hidden",
            )}
          >
            {first ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mb-4 lg:hidden"
                  onClick={() => props.onPreview(null)}
                >
                  <ArrowLeftIcon className="size-3.5" />
                  Back to conversations
                </Button>
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Conversation preview
                </p>
                <h3 className="mt-2 break-words text-base font-semibold leading-snug">
                  {first.title}
                </h3>
                <p className="mt-2 text-xs text-muted-foreground">
                  {sessionImportSourceLabel(first.source)} ·{" "}
                  {new Date(first.updatedAt).toLocaleDateString()}
                </p>
                <p
                  className="mt-2 break-all text-xs text-muted-foreground"
                  title={first.workspaceRoot ?? undefined}
                >
                  {first.workspaceRoot ?? "No recorded folder"}
                </p>
                {!first.workspaceAvailable ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {first.workspaceRoot
                      ? "The original folder is unavailable. You can still import into another project."
                      : "The source app did not record a folder. Choose a destination project for this conversation."}
                  </p>
                ) : null}
                <div className="mt-6 space-y-5">
                  {first.previewMessages?.length ? (
                    first.previewMessages.map((message, index) => (
                      <div key={index}>
                        <p className="mb-1.5 text-xs font-medium">
                          {message.role === "user" ? "You" : "Assistant"}
                        </p>
                        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">
                          {message.text}
                          {message.text.length === 1_000 ? "…" : ""}
                        </p>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      A preview is unavailable. The conversation can still be selected.
                    </p>
                  )}
                </div>
                <p className="mt-5 text-[11px] text-muted-foreground">
                  Preview of the beginning. The full readable conversation is copied during import.
                </p>
                <Button
                  className="mt-5"
                  size="sm"
                  variant={props.selected.has(first.candidateId) ? "secondary" : "default"}
                  disabled={busy || props.readOnly}
                  onClick={() => props.onSelect(first, !props.selected.has(first.candidateId))}
                >
                  {props.selected.has(first.candidateId) ? (
                    <CheckIcon className="size-3.5" />
                  ) : (
                    <PlusIcon className="size-3.5" />
                  )}
                  {props.selected.has(first.candidateId)
                    ? "Selected · Remove"
                    : "Select conversation"}
                </Button>
              </>
            ) : (
              <div className="flex h-full flex-col items-center justify-center text-center">
                <MessageSquareIcon className="mb-3 size-7 text-muted-foreground/50" />
                <p className="text-sm font-medium">Take a look before importing</p>
                <p className="mt-1 max-w-60 text-xs leading-relaxed text-muted-foreground">
                  Choose a conversation to preview its content and source.
                </p>
              </div>
            )}
          </div>
        </div>
        <div className="max-h-[40dvh] shrink-0 overflow-y-auto border-t bg-background px-6 py-4">
          {props.results.length > 0 ? (
            <div
              className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
              aria-live="polite"
            >
              <span>
                {props.results.filter((item) => item.status !== "failed").length} imported ·{" "}
                {props.results.filter((item) => item.status === "failed").length} failed
              </span>
              {props.results
                .filter((item) => item.threadId !== null)
                .slice(0, 3)
                .map((item, index) => (
                  <Button
                    key={item.candidateId}
                    size="xs"
                    variant="link"
                    onClick={() => props.onOpenThread(item)}
                  >
                    Open conversation {index + 1}
                    <ArrowRightIcon className="size-3" />
                  </Button>
                ))}
            </div>
          ) : null}
          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-44 flex-1">
              <span className="mb-1.5 block text-xs font-medium">Destination project</span>
              <select
                className={inputClass}
                value={props.destination}
                disabled={busy || props.readOnly}
                aria-label="Destination project"
                onChange={(event) => props.onDestinationChange(event.target.value)}
              >
                <option value="">Choose a project…</option>
                {props.projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
                <option value="new">＋ New project</option>
              </select>
            </label>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground" aria-live="polite">
                {selectionCount} selected
              </span>
              {selectionCount > 0 ? (
                <Button size="xs" variant="ghost" disabled={busy} onClick={props.onClearSelection}>
                  Clear
                </Button>
              ) : null}
            </div>
            {busy ? (
              <Button size="sm" variant="ghost" onClick={props.onStop}>
                Stop after this batch
              </Button>
            ) : null}
            <Button
              disabled={!props.canImport || busy || props.readOnly}
              onClick={props.onImport}
              data-workjet-action="session-import.confirm"
            >
              {props.progress ??
                `Import ${selectionCount || "selected"} conversation${selectionCount === 1 ? "" : "s"}`}
            </Button>
          </div>
          {props.destination === "new" ||
          (destinationProject && !destinationProject.workspaceRoot) ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {props.destination === "new" ? (
                <label>
                  <span className="mb-1.5 block text-xs font-medium">Project name</span>
                  <input
                    className={inputClass}
                    aria-label="Project name"
                    value={props.newProjectTitle}
                    maxLength={256}
                    disabled={busy}
                    onChange={(event) => props.onNewProjectTitleChange(event.target.value)}
                    placeholder="My project"
                  />
                </label>
              ) : null}
              <label className={props.destination !== "new" ? "sm:col-span-2" : ""}>
                <span className="mb-1.5 block text-xs font-medium">
                  Project folder on this computer
                </span>
                <span className="flex gap-2">
                  <input
                    className={inputClass}
                    aria-label="Project folder"
                    value={props.workspaceRoot}
                    disabled={busy}
                    onChange={(event) => props.onWorkspaceRootChange(event.target.value)}
                    placeholder="/path/to/project"
                  />
                  {props.onPickFolder ? (
                    <Button
                      size="icon"
                      variant="outline"
                      aria-label="Choose project folder"
                      disabled={busy}
                      onClick={props.onPickFolder}
                    >
                      <FolderIcon className="size-4" />
                    </Button>
                  ) : null}
                </span>
              </label>
            </div>
          ) : null}
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
            Source conversations stay unchanged. Reimporting updates the copy in the chosen project.
            Large selections are imported in batches of {WORKJET_SESSION_IMPORT_MAX_SELECTION}.
          </p>
          {props.inspection?.discoveryLimitReached ? (
            <p className="mt-1 text-[11px] text-muted-foreground">
              The source scan is incomplete. Refresh or update the connected server before selecting
              all.
            </p>
          ) : null}
          {props.readOnly ? (
            <p className="mt-1 text-xs text-muted-foreground">
              This connection can browse sessions but cannot import them.
            </p>
          ) : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
