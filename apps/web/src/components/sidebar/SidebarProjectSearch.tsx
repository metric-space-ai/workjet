/**
 * Datei- und Inhaltssuche inline unter dem Seitenleisten-Feld „Suchen“
 * (drei Orte, keine Popups). Ersetzt den früheren Datei-Picker und die
 * Inhaltssuche im Palettendialog: ⌘P schaltet das Feld auf „Dateien“, ⌘⇧F
 * auf „Inhalt“; die Treffer stehen direkt darunter und öffnen die Datei im
 * rechten Bereich der aktiven Unterhaltung.
 */
import type { ProjectContentMatch } from "@workjet/contracts";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";

import type { SidebarSearchMode } from "~/commandPaletteBus";
import { useActiveProjectTarget, type ActiveProjectTarget } from "~/hooks/useActiveProjectTarget";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useProjectContentSearch } from "~/state/queries";

import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import {
  getProjectFilePickerMatches,
  PROJECT_FILE_PICKER_RESULT_LIMIT,
} from "../files/ProjectFilePicker.logic";
import { useProjectFilePickerQuery } from "../files/projectFilesQueryState";
import { HighlightedSearchLine } from "../search/HighlightedSearchLine";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

export const SIDEBAR_SEARCH_MODES: ReadonlyArray<{
  readonly value: SidebarSearchMode;
  readonly label: string;
  readonly placeholder: string;
}> = [
  { value: "threads", label: "Unterhaltungen", placeholder: "Suchen" },
  { value: "files", label: "Dateien", placeholder: "Datei suchen" },
  { value: "content", label: "Inhalt", placeholder: "Im Projekt suchen" },
];

export function sidebarSearchPlaceholder(mode: SidebarSearchMode, fallback: string): string {
  if (mode === "threads") return fallback;
  return SIDEBAR_SEARCH_MODES.find((entry) => entry.value === mode)?.placeholder ?? fallback;
}

/** Shown results per mode; content rows are syntax highlighted, so stay small. */
const VISIBLE_FILE_RESULTS = 60;
const VISIBLE_CONTENT_RESULTS = 80;

export function SidebarSearchModeSegment(props: {
  readonly mode: SidebarSearchMode;
  readonly onModeChange: (mode: SidebarSearchMode) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Suchbereich"
      className="w-full px-1"
      size="xs"
      variant="outline"
      value={[props.mode]}
      onValueChange={(value) => {
        const next = SIDEBAR_SEARCH_MODES.find((entry) => entry.value === value[0]);
        if (next !== undefined) props.onModeChange(next.value);
      }}
    >
      {SIDEBAR_SEARCH_MODES.map((entry) => (
        <Toggle
          key={entry.value}
          value={entry.value}
          data-sidebar-search-mode={entry.value}
          className="flex-1 text-xs text-sidebar-muted-foreground data-pressed:bg-primary/15 data-pressed:text-sidebar-foreground"
        >
          {entry.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

function StatusLine(props: { readonly children: string; readonly tone?: "error" }) {
  return (
    <p
      role={props.tone === "error" ? "alert" : "status"}
      className={cn(
        "px-2 py-4 text-center text-xs",
        props.tone === "error" ? "text-destructive" : "text-sidebar-muted-foreground",
      )}
    >
      {props.children}
    </p>
  );
}

/**
 * Wires ArrowUp/ArrowDown/Enter of the sidebar search input to a result list
 * without owning the input (the sidebar keeps its own handlers for threads).
 */
function useResultKeyboard(
  inputRef: RefObject<HTMLInputElement | null>,
  count: number,
  onOpen: (index: number) => void,
) {
  const [activeIndex, setActiveIndex] = useState(0);
  const latest = useRef({ count, onOpen, activeIndex });
  latest.current = { count, onOpen, activeIndex };
  useEffect(() => {
    setActiveIndex(0);
  }, [count]);
  useEffect(() => {
    const input = inputRef.current;
    if (input === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const { count: total, onOpen: open, activeIndex: index } = latest.current;
      if (total === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((current) => (current + 1) % total);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) => (current - 1 + total) % total);
      } else if (event.key === "Enter") {
        event.preventDefault();
        open(index);
      }
    };
    input.addEventListener("keydown", onKeyDown);
    return () => input.removeEventListener("keydown", onKeyDown);
  }, [inputRef]);
  return [activeIndex, setActiveIndex] as const;
}

function splitPath(path: string): { readonly name: string; readonly directory: string } {
  const separator = path.lastIndexOf("/");
  return separator === -1
    ? { name: path, directory: "" }
    : { name: path.slice(separator + 1), directory: path.slice(0, separator) };
}

function FileResults(props: {
  readonly target: ActiveProjectTarget;
  readonly query: string;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onOpened: () => void;
}) {
  const { target } = props;
  const { resolvedTheme } = useTheme();
  const result = useProjectFilePickerQuery(
    target.environmentId,
    target.cwd,
    props.query,
    PROJECT_FILE_PICKER_RESULT_LIMIT,
  );
  const matches = useMemo(
    () =>
      getProjectFilePickerMatches(result.entries, result.matchedQuery).slice(
        0,
        VISIBLE_FILE_RESULTS,
      ),
    [result.entries, result.matchedQuery],
  );
  const open = (index: number) => {
    const match = matches[index];
    if (match === undefined) return;
    useRightPanelStore.getState().openFile(target.threadRef, match.path);
    props.onOpened();
  };
  const [activeIndex, setActiveIndex] = useResultKeyboard(props.inputRef, matches.length, open);

  if (result.error) return <StatusLine tone="error">{result.error}</StatusLine>;
  if (matches.length === 0)
    return <StatusLine>{result.isPending ? "Suche läuft …" : "Keine Dateien"}</StatusLine>;
  return (
    <ul role="listbox" aria-label="Dateien" className="flex flex-col gap-px">
      {matches.map((match, index) => (
        <li key={match.path} role="option" aria-selected={index === activeIndex}>
          <button
            type="button"
            data-sidebar-file-result={match.path}
            className={cn(
              "flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm text-sidebar-foreground hover:bg-sidebar-row-hover",
              index === activeIndex && "bg-sidebar-row-hover",
            )}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => open(index)}
          >
            <PierreEntryIcon
              pathValue={match.path}
              kind="file"
              theme={resolvedTheme}
              className="size-3.5 shrink-0"
            />
            <span className="shrink-0 truncate">{match.name}</span>
            <span className="min-w-0 truncate text-xs text-sidebar-muted-foreground">
              {splitPath(match.path).directory}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ContentResults(props: {
  readonly target: ActiveProjectTarget;
  readonly query: string;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onOpened: () => void;
}) {
  const { target } = props;
  const { resolvedTheme } = useTheme();
  const search = useProjectContentSearch({
    environmentId: target.environmentId,
    cwd: target.cwd,
    query: props.query,
    caseSensitive: false,
    wholeWord: false,
    useRegex: false,
  });
  const matches = useMemo(() => search.matches.slice(0, VISIBLE_CONTENT_RESULTS), [search.matches]);
  const open = (index: number) => {
    const match: ProjectContentMatch | undefined = matches[index];
    if (match === undefined || search.isPending) return;
    useRightPanelStore.getState().openFile(target.threadRef, match.path, match.lineNumber);
    props.onOpened();
  };
  const [activeIndex, setActiveIndex] = useResultKeyboard(props.inputRef, matches.length, open);

  if (!search.hasQuery) return null;
  if (search.error) return <StatusLine tone="error">{search.error}</StatusLine>;
  if (matches.length === 0)
    return <StatusLine>{search.isPending ? "Suche läuft …" : "Keine Treffer"}</StatusLine>;
  return (
    <ul role="listbox" aria-label="Treffer" className="flex flex-col gap-px">
      {matches.map((match, index) => {
        const path = splitPath(match.path);
        return (
          <li
            key={`${match.path}:${match.lineNumber}:${index}`}
            role="option"
            aria-selected={index === activeIndex}
          >
            <button
              type="button"
              data-sidebar-content-result={index}
              disabled={search.isPending}
              className={cn(
                "flex w-full min-w-0 flex-col rounded-md px-2 py-1 text-left hover:bg-sidebar-row-hover disabled:opacity-60",
                index === activeIndex && "bg-sidebar-row-hover",
              )}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => open(index)}
            >
              <span className="flex min-w-0 items-center gap-1 text-xs text-sidebar-muted-foreground">
                <span className="truncate text-sidebar-foreground">{path.name}</span>
                <span className="shrink-0 tabular-nums">:{match.lineNumber}</span>
              </span>
              <span className="truncate whitespace-pre font-mono text-xs text-sidebar-foreground/90">
                <HighlightedSearchLine match={match} path={match.path} theme={resolvedTheme} />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Inline file or content results for the sidebar search. */
export function SidebarProjectSearchResults(props: {
  readonly mode: Exclude<SidebarSearchMode, "threads">;
  readonly query: string;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onOpened: () => void;
}) {
  const target = useActiveProjectTarget();
  if (target === null) return <StatusLine>Keine Unterhaltung mit Projektordner offen</StatusLine>;
  return props.mode === "files" ? (
    <FileResults
      key={`${target.environmentId}:${target.cwd}`}
      target={target}
      query={props.query}
      inputRef={props.inputRef}
      onOpened={props.onOpened}
    />
  ) : (
    <ContentResults
      key={`${target.environmentId}:${target.cwd}`}
      target={target}
      query={props.query}
      inputRef={props.inputRef}
      onOpened={props.onOpened}
    />
  );
}
