/**
 * „Neue Unterhaltung in …“: ein reines Auswahl-Dropdown in der Seitenleiste
 * (drei Orte, keine Popups). Ersetzt den Projekt-Picker der früheren
 * Befehlspalette; ein Eintrag startet sofort eine Unterhaltung im Projekt.
 */
import { ChevronDownIcon, FolderIcon, FolderPlusIcon } from "lucide-react";

import type { AvailableProject } from "../availableProjects";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { SidebarMenuButton } from "./ui/sidebar";

export const NEW_THREAD_IN_LABEL = "Neue Unterhaltung in …";

export interface NewThreadMenuEntry {
  readonly key: string;
  readonly title: string;
  readonly project: AvailableProject;
}

/** One entry per project; the fallback covers a computer-only working copy. */
export function buildNewThreadMenuEntries(
  projects: readonly AvailableProject[],
  fallback: AvailableProject | null,
): NewThreadMenuEntry[] {
  const source = projects.length > 0 ? projects : fallback === null ? [] : [fallback];
  const seen = new Set<string>();
  const entries: NewThreadMenuEntry[] = [];
  for (const project of source) {
    const key = `${project.environmentId}:${project.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ key, title: project.title, project });
  }
  return entries.toSorted((left, right) => left.title.localeCompare(right.title, "de"));
}

export function NewThreadInMenu(props: {
  readonly entries: readonly NewThreadMenuEntry[];
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (project: AvailableProject) => void;
  readonly onCreateProject: () => void;
  /** Opened programmatically (the sidebar „+“); no visible trigger of its own. */
  readonly hideTrigger?: boolean;
}) {
  return (
    <Menu open={props.open} onOpenChange={props.onOpenChange}>
      <MenuTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={NEW_THREAD_IN_LABEL}
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
      <MenuPopup align="end" className="min-w-56 max-w-80">
        <MenuGroup>
          <MenuGroupLabel>{NEW_THREAD_IN_LABEL}</MenuGroupLabel>
          {props.entries.map((entry) => (
            <MenuItem
              key={entry.key}
              data-workjet-action={`thread.new.in:${entry.project.id}`}
              onClick={() => props.onSelect(entry.project)}
            >
              <FolderIcon aria-hidden className="size-4" />
              <span className="min-w-0 truncate">{entry.title}</span>
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
