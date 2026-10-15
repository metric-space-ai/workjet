/**
 * „Neue Unterhaltung in …“: ein reines Auswahl-Dropdown in der Seitenleiste
 * (drei Orte, keine Popups). Ersetzt den Projekt-Picker der früheren
 * Befehlspalette; ein Eintrag startet sofort eine Unterhaltung im Projekt.
 */
import { ChevronDownIcon, FolderIcon, FolderPlusIcon } from "lucide-react";

import type { AvailableProject } from "../availableProjects";
import { buildProjectSwitcherEntries, projectFolderName } from "./sidebar/projectSwitcher.logic";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { SidebarMenuButton } from "./ui/sidebar";

export const NEW_THREAD_IN_LABEL = "Neue Unterhaltung in";

export interface NewThreadMenuEntry {
  readonly key: string;
  readonly title: string;
  /** Ordner, nur wenn ein gleichnamiges Projekt existiert („metric“/„Metric“). */
  readonly meta: string | null;
  readonly project: AvailableProject;
}

/** One entry per project; the fallback covers a computer-only working copy. */
export function buildNewThreadMenuEntries(
  projects: readonly AvailableProject[],
  fallback: AvailableProject | null,
): NewThreadMenuEntry[] {
  const source = projects.length > 0 ? projects : fallback === null ? [] : [fallback];
  const seen = new Set<string>();
  const unique: Array<{ key: string; project: AvailableProject }> = [];
  for (const project of source) {
    const key = `${project.environmentId}:${project.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ key, project });
  }
  const labelled = buildProjectSwitcherEntries(
    unique.map(({ key, project }) => ({
      id: key,
      title: project.title,
      metaCandidates: [projectFolderName(project.path)],
    })),
  );
  return unique
    .map(({ key, project }, index) => ({
      key,
      title: project.title,
      meta: labelled[index]?.meta ?? null,
      project,
    }))
    .toSorted((left, right) => left.title.localeCompare(right.title, "de"));
}

export function NewThreadInMenu(props: {
  readonly entries: readonly NewThreadMenuEntry[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (project: AvailableProject) => void;
  readonly onCreateProject: () => void;
  /** Opened programmatically (the sidebar „+“); no visible trigger of its own. */
  readonly hideTrigger?: boolean;
  /** Kopfzeile aus dem Sprachkatalog. */
  readonly title?: string;
}) {
  const title = props.title ?? NEW_THREAD_IN_LABEL;
  return (
    <Menu open={props.open} onOpenChange={props.onOpenChange}>
      <MenuTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={title}
            data-workjet-action="thread.new.in"
            tabIndex={props.hideTrigger ? -1 : undefined}
            aria-hidden={props.hideTrigger ? true : undefined}
            className={
              props.hideTrigger
                ? "pointer-events-none absolute right-0 size-8 opacity-0"
                : "w-5 min-w-5 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
            }
          />
        }
      >
        <ChevronDownIcon aria-hidden className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end" className="w-72 max-w-[calc(100vw-1rem)]">
        <MenuGroup>
          <MenuGroupLabel className="whitespace-normal">{title}</MenuGroupLabel>
          {props.entries.map((entry) => (
            <MenuItem
              key={entry.key}
              data-workjet-action={`thread.new.in:${entry.project.id}`}
              onClick={() => props.onSelect(entry.project)}
            >
              <FolderIcon aria-hidden className="size-4 self-start mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="block whitespace-normal break-words" data-sensitive="">
                  {entry.title}
                </span>
                {entry.meta ? (
                  <span className="block truncate text-[12px] text-muted-foreground">
                    {entry.meta}
                  </span>
                ) : null}
              </span>
            </MenuItem>
          ))}
          {props.entries.length === 0 ? (
            <MenuItem onClick={props.onCreateProject}>
              <FolderPlusIcon aria-hidden className="size-4" />
              <span>Projekt anlegen</span>
            </MenuItem>
          ) : null}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
