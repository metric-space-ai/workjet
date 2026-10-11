import type { EnvironmentId } from "@workjet/contracts";
import { useMemo, useState } from "react";

import { useTheme } from "~/hooks/useTheme";
import { PierreEntryIcon } from "../chat/PierreEntryIcon";
import {
  getProjectFilePickerMatches,
  PROJECT_FILE_PICKER_RESULT_LIMIT,
} from "../files/ProjectFilePicker.logic";
import { useProjectFilePickerQuery } from "../files/projectFilesQueryState";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

function statusLine(query: string, error: string | null, isPending: boolean): string | null {
  if (error) return error;
  if (isPending) return "Bilddateien werden gesucht …";
  return query.trim() ? "Keine passende Bilddatei." : "Keine Bilddateien gefunden.";
}

/**
 * Project icon choice as an inline grid (drei Orte, keine Popups): a search
 * field over the project's image files and one button per match. Choosing a
 * file saves it and closes the grid.
 */
export function ProjectFaviconPicker(props: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  readonly onSelect: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const result = useProjectFilePickerQuery(
    props.environmentId,
    props.cwd,
    query,
    PROJECT_FILE_PICKER_RESULT_LIMIT,
    { imageOnly: true },
  );
  const { resolvedTheme } = useTheme();
  const matches = useMemo(
    () => getProjectFilePickerMatches(result.entries, result.matchedQuery),
    [result.entries, result.matchedQuery],
  );

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border bg-card/40 p-3"
      data-slot="inline-panel"
      data-settings-inline-editor=""
      data-testid="project-favicon-picker"
    >
      <div className="font-medium text-[13.5px]">Projektsymbol wählen</div>
      <Input
        aria-label="Bilddateien suchen"
        autoFocus
        placeholder="Bilddateien suchen …"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {matches.length > 0 ? (
        <div
          className="grid max-h-72 grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-1.5 overflow-auto"
          role="listbox"
          aria-label="Bilddateien"
        >
          {matches.map((match) => (
            <button
              key={match.path}
              type="button"
              role="option"
              aria-selected={false}
              title={match.path}
              className="flex min-w-0 items-center gap-2 rounded-md border border-border/70 px-2 py-1.5 text-left text-xs hover:bg-accent/60"
              onClick={() => {
                props.onSelect(match.path);
                props.onClose();
              }}
            >
              <PierreEntryIcon pathValue={match.path} kind="file" theme={resolvedTheme} />
              <span className="min-w-0 flex-1 truncate">{match.path}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground" role="status">
          {statusLine(query, result.error, result.isPending)}
        </div>
      )}
      <div className="flex items-center justify-end gap-2" data-slot="inline-panel-footer">
        <Button size="sm" type="button" variant="outline" onClick={props.onClose}>
          Abbrechen
        </Button>
      </div>
    </div>
  );
}
