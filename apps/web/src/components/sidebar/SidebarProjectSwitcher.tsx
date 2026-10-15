/**
 * Projektumschalter der Seitenleiste (#580): voller Name statt „Light Gun
 * Heroe…“, ein reines Auswahlmenü mit eindeutigen Einträgen (gleichnamige
 * Projekte tragen eine Meta-Zeile) und ab acht Projekten ein Suchfeld.
 */
import { CheckIcon, ChevronDownIcon, LayoutGridIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SidebarMenuButton } from "../ui/sidebar";
import {
  filterProjectSwitcherEntries,
  PROJECT_SWITCHER_SEARCH_THRESHOLD,
  type ProjectSwitcherEntry,
} from "./projectSwitcher.logic";

export interface SidebarProjectSwitcherText {
  readonly allProjects: string;
  readonly chooseProject: string;
  readonly searchProjects: string;
  readonly noProjectFound: string;
  readonly newProject: string;
}

const ITEM_CLASS = "items-start py-1 hover:bg-accent hover:text-accent-foreground";

export function SidebarProjectSwitcher(props: {
  readonly entries: ReadonlyArray<ProjectSwitcherEntry>;
  /** Id des aktuellen Projekts; null = „Alle Projekte“. */
  readonly selectedId: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelectAll: () => void;
  readonly onSelect: (id: string) => void;
  readonly onCreateProject: () => void;
  readonly text: SidebarProjectSwitcherText;
  readonly busy?: boolean;
  /** Rechts in der Zeile, z. B. das Token-Budget. */
  readonly renderTrailing?: (entry: ProjectSwitcherEntry) => ReactNode;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = props.entries.find((entry) => entry.id === props.selectedId) ?? null;
  const currentTitle = selected?.title ?? props.text.allProjects;
  const showSearch = props.entries.length >= PROJECT_SWITCHER_SEARCH_THRESHOLD;
  const visible = filterProjectSwitcherEntries(props.entries, showSearch ? query : "");

  // Das Menü fokussiert beim Öffnen sich selbst; danach übernimmt das Suchfeld.
  useEffect(() => {
    if (!props.open || !showSearch) return;
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [props.open, showSearch]);

  const setOpen = (open: boolean) => {
    if (!open) setQuery("");
    props.onOpenChange(open);
  };
  const choose = (id: string) => {
    setOpen(false);
    props.onSelect(id);
  };
  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && visible[0]) {
      event.preventDefault();
      choose(visible[0].id);
      return;
    }
    // Pfeil runter und Escape gehören dem Menü; alle anderen Tasten dem Suchfeld,
    // sonst springt die Tipp-Navigation des Menüs auf einen Eintrag.
    if (event.key !== "ArrowDown" && event.key !== "Escape") event.stopPropagation();
  };

  return (
    <Menu open={props.open} onOpenChange={setOpen} highlightItemOnHover={!showSearch}>
      <MenuTrigger
        render={
          <SidebarMenuButton
            aria-label={`${props.text.chooseProject}: ${currentTitle}`}
            aria-busy={props.busy}
            disabled={props.busy}
            data-workjet-action="project.switcher"
            className="h-auto min-h-11 min-w-0 flex-1 gap-2.5 py-1.5 text-[13.5px] font-semibold text-sidebar-foreground focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar"
          />
        }
      >
        <span
          aria-hidden
          className="flex size-7 shrink-0 items-center justify-center self-start rounded-md bg-sidebar-accent text-[13.5px] font-semibold uppercase text-sidebar-accent-foreground"
        >
          {currentTitle.trim().charAt(0) || <LayoutGridIcon className="size-4" />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col" data-project-switcher-current="">
          <span className="whitespace-normal break-words leading-snug" data-sensitive="">
            {currentTitle}
          </span>
          {selected?.meta ? (
            <span className="truncate text-[12px] font-normal text-sidebar-muted-foreground">
              {selected.meta}
            </span>
          ) : null}
        </span>
        <ChevronDownIcon aria-hidden className="size-4 shrink-0" />
      </MenuTrigger>
      <MenuPopup align="start" className="w-72 max-w-[calc(100vw-1rem)]">
        {showSearch ? (
          <label className="mb-1 flex h-8 items-center gap-2 rounded-md border border-border px-2 text-[13.5px]">
            <SearchIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={props.text.searchProjects}
              aria-label={props.text.searchProjects}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
              data-project-switcher-search=""
            />
          </label>
        ) : null}
        <MenuItem
          className={ITEM_CLASS}
          data-workjet-action="project.overview"
          onClick={() => {
            setOpen(false);
            props.onSelectAll();
          }}
        >
          <LayoutGridIcon aria-hidden className="mt-0.5 size-4" />
          <span>{props.text.allProjects}</span>
        </MenuItem>
        <MenuSeparator />
        <div data-project-switcher-list="">
          {visible.map((entry) => (
            <MenuItem
              key={entry.id}
              className={ITEM_CLASS}
              label={`${entry.title} ${entry.meta ?? ""}`.trim()}
              data-workjet-action={`project.select:${entry.id}`}
              onClick={() => choose(entry.id)}
            >
              <ProjectSwitcherRowContent
                entry={entry}
                selected={entry.id === props.selectedId}
                trailing={props.renderTrailing?.(entry)}
              />
            </MenuItem>
          ))}
          {visible.length === 0 ? (
            <div className="px-2 py-1.5 text-[13.5px] text-muted-foreground">
              {props.text.noProjectFound}
            </div>
          ) : null}
        </div>
        <MenuSeparator />
        <MenuItem
          className={ITEM_CLASS}
          data-workjet-action="project.add.sidebar.persistent"
          onClick={() => {
            setOpen(false);
            props.onCreateProject();
          }}
        >
          <PlusIcon aria-hidden className="mt-0.5 size-4" />
          <span>{props.text.newProject}</span>
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

/** Eine Projektzeile: voller Name (Umbruch statt „…“), Meta-Zeile bei Gleichnamigen. */
export function ProjectSwitcherRowContent(props: {
  readonly entry: ProjectSwitcherEntry;
  readonly selected: boolean;
  readonly trailing?: ReactNode;
}) {
  return (
    <>
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
        {props.selected ? <CheckIcon aria-hidden className="size-4" /> : null}
      </span>
      <span className="min-w-0 flex-1" data-project-switcher-row="">
        <span
          className={`block whitespace-normal break-words${props.selected ? " font-medium" : ""}`}
          data-sensitive=""
        >
          {props.entry.title}
        </span>
        {props.entry.meta ? (
          <span
            className="block truncate text-[12px] text-muted-foreground"
            data-project-switcher-meta=""
          >
            {props.entry.meta}
          </span>
        ) : null}
      </span>
      {props.trailing ? <span className="shrink-0 self-center">{props.trailing}</span> : null}
    </>
  );
}
