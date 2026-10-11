/**
 * Felder der Quellen von „Projekt anlegen“ (Neu | Aus Ordner | Repository
 * klonen), inline im Panel der Projektübersicht. Nur Darstellung; Zustand und
 * Seiteneffekte hält das Panel. Keine Erklärsätze, jede Aktion ein Button.
 */
import type { EnvironmentId, FilesystemBrowseEntry } from "@workjet/contracts";
import { FolderIcon, FolderOpenIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  PROJECT_CLONE_PROVIDERS,
  PROJECT_CREATE_SOURCES,
  type ProjectCloneProvider,
  type ProjectCloneTargetFolder,
  type ProjectComputerOption,
  type ProjectCreateSource,
} from "./ProjectCreateSources.logic";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Toggle, ToggleGroup } from "./ui/toggle-group";

const SEGMENT_TOGGLE_CLASS =
  "text-muted-foreground data-pressed:bg-primary/15 data-pressed:text-foreground dark:data-pressed:bg-primary/20";

export function ProjectCreateSourceSegment(props: {
  readonly value: ProjectCreateSource;
  readonly onChange: (source: ProjectCreateSource) => void;
  readonly disabled?: boolean;
}) {
  return (
    <ToggleGroup
      aria-label="Quelle"
      className="flex-wrap"
      size="sm"
      variant="outline"
      value={[props.value]}
      onValueChange={(value) => {
        const next = PROJECT_CREATE_SOURCES.find((entry) => entry.value === value[0]);
        if (next !== undefined && !props.disabled) props.onChange(next.value);
      }}
    >
      {PROJECT_CREATE_SOURCES.map((entry) => (
        <Toggle
          key={entry.value}
          value={entry.value}
          disabled={props.disabled}
          data-workjet-project-source={entry.value}
          className={SEGMENT_TOGGLE_CLASS}
        >
          {entry.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

export function ProjectComputerSelect(props: {
  readonly options: readonly ProjectComputerOption[];
  readonly value: EnvironmentId | null;
  readonly onChange: (environmentId: EnvironmentId) => void;
}) {
  const connected = props.options.filter((option) => option.connected);
  const label = connected.find((option) => option.environmentId === props.value)?.label ?? null;
  return (
    <div className="grid min-w-0 gap-1 text-[13.5px]">
      <span>Rechner</span>
      <Select
        value={props.value ?? ""}
        onValueChange={(value) => {
          const next = connected.find((option) => option.environmentId === value);
          if (next !== undefined) props.onChange(next.environmentId);
        }}
      >
        <SelectTrigger aria-label="Rechner" disabled={connected.length === 0}>
          <SelectValue>{label ?? "Kein Rechner verbunden"}</SelectValue>
        </SelectTrigger>
        <SelectPopup align="start" alignItemWithTrigger={false}>
          {connected.map((option) => (
            <SelectItem key={option.environmentId} value={option.environmentId}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

/** „Aus Ordner“: Pfad mit Vorschlägen; „Ordner wählen“ öffnet den Systemdialog. */
export function ProjectFolderFields(props: {
  readonly computer: ReactNode;
  readonly path: string;
  readonly onPathChange: (path: string) => void;
  readonly onPick: (() => void) | null;
  readonly picking?: boolean;
  readonly suggestions: readonly FilesystemBrowseEntry[];
  readonly onSuggestion: (entry: FilesystemBrowseEntry) => void;
}) {
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        {props.computer}
        <label className="grid min-w-0 gap-1 text-[13.5px]">
          Ordner
          <div className="grid min-w-0 gap-2 sm:flex">
            <Input
              aria-label="Ordner"
              className="w-full min-w-0 sm:flex-1"
              placeholder="~/projekte/name"
              spellCheck={false}
              value={props.path}
              data-workjet-action="project.add.folder.path"
              onChange={(event) => props.onPathChange(event.target.value)}
            />
            {props.onPick ? (
              <Button
                type="button"
                variant="outline"
                disabled={props.picking}
                data-workjet-action="project.add.folder.pick"
                onClick={props.onPick}
              >
                <FolderOpenIcon />
                Ordner wählen
              </Button>
            ) : null}
          </div>
        </label>
      </div>
      {props.suggestions.length > 0 ? (
        <div aria-label="Unterordner" className="flex flex-wrap gap-1.5" role="group">
          {props.suggestions.map((entry) => (
            <Button
              key={entry.fullPath}
              type="button"
              size="xs"
              variant="outline"
              data-workjet-folder-suggestion={entry.fullPath}
              onClick={() => props.onSuggestion(entry)}
            >
              <FolderIcon />
              {entry.name}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** „Repository klonen“: URL oder Anbieter-Repository und Zielordner. */
export function ProjectCloneFields(props: {
  readonly computer: ReactNode;
  readonly providers: readonly ProjectCloneProvider[];
  readonly provider: ProjectCloneProvider;
  readonly onProviderChange: (provider: ProjectCloneProvider) => void;
  readonly repository: string;
  readonly onRepositoryChange: (repository: string) => void;
  readonly baseDirectory: string;
  readonly onBaseDirectoryChange: (baseDirectory: string) => void;
  /** Bekannte Ordner des Rechners als Auswahl; Freitext bleibt Fallback. */
  readonly targetFolders?: readonly ProjectCloneTargetFolder[];
  readonly onPickTarget?: (() => void) | null;
  readonly picking?: boolean;
}) {
  const normalizedBase = props.baseDirectory.trim().replace(/(.)[/\\]+$/, "$1");
  const entry =
    PROJECT_CLONE_PROVIDERS.find((candidate) => candidate.value === props.provider) ??
    PROJECT_CLONE_PROVIDERS[0]!;
  const providerEntries = PROJECT_CLONE_PROVIDERS.filter((candidate) =>
    props.providers.includes(candidate.value),
  );
  return (
    <div className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        {props.computer}
        <div className="grid min-w-0 gap-1 text-[13.5px]">
          <span>Repository</span>
          <div className="grid min-w-0 gap-2 sm:flex">
            {providerEntries.length > 1 ? (
              <Select
                value={props.provider}
                onValueChange={(value) => {
                  const next = providerEntries.find((candidate) => candidate.value === value);
                  if (next !== undefined) props.onProviderChange(next.value);
                }}
              >
                <SelectTrigger aria-label="Anbieter" className="w-full shrink-0 sm:w-36">
                  <SelectValue>{entry.label}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  {providerEntries.map((candidate) => (
                    <SelectItem key={candidate.value} value={candidate.value}>
                      {candidate.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            <Input
              aria-label="Repository"
              className="w-full min-w-0 sm:flex-1"
              placeholder={entry.placeholder}
              spellCheck={false}
              value={props.repository}
              data-workjet-action="project.add.clone.repository"
              onChange={(event) => props.onRepositoryChange(event.target.value)}
            />
          </div>
        </div>
      </div>
      <div className="grid min-w-0 gap-1 text-[13.5px]">
        <span>Zielordner</span>
        {(props.targetFolders?.length ?? 0) > 0 || props.onPickTarget ? (
          <div
            aria-label="Bekannte Ordner"
            className="flex flex-wrap gap-1.5"
            role="group"
            data-workjet-clone-targets=""
          >
            {props.targetFolders?.map((folder) => (
              <Button
                key={folder.path}
                type="button"
                size="xs"
                variant={folder.path === normalizedBase ? "default" : "outline"}
                aria-pressed={folder.path === normalizedBase}
                title={folder.path}
                data-workjet-clone-target={folder.path}
                onClick={() => props.onBaseDirectoryChange(folder.path)}
              >
                <FolderIcon />
                {folder.label}
              </Button>
            ))}
            {props.onPickTarget ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={props.picking}
                data-workjet-action="project.add.clone.pick-target"
                onClick={props.onPickTarget}
              >
                <FolderOpenIcon />
                Ordner wählen
              </Button>
            ) : null}
          </div>
        ) : null}
        <Input
          aria-label="Zielordner"
          className="w-full min-w-0"
          placeholder="~/"
          spellCheck={false}
          value={props.baseDirectory}
          onChange={(event) => props.onBaseDirectoryChange(event.target.value)}
        />
      </div>
    </div>
  );
}

/** Eine Statuszeile mit genau einem Button, z. B. zu Einstellungen › Instanzen. */
export function ProjectCreateRequirementLine(props: {
  readonly text: string;
  readonly actionLabel: string;
  readonly onAction: () => void;
}) {
  return (
    <span className="flex flex-wrap items-center gap-2" data-workjet-project-requirement="">
      <span>{props.text}</span>
      <Button type="button" size="xs" variant="outline" onClick={props.onAction}>
        {props.actionLabel}
      </Button>
    </span>
  );
}
