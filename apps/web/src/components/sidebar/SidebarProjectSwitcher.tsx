/**
 * Projektumschalter der Seitenleiste (#580): voller Name statt „Light Gun
 * Heroe…“, eine Liste mit eindeutigen Einträgen (gleichnamige Projekte tragen
 * eine Meta-Zeile) und ab acht Projekten ein Suchfeld.
 */
import { CheckIcon, ChevronDownIcon, LayoutGridIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";

import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
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
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = props.entries.find((entry) => entry.id === props.selectedId) ?? null;
  const currentTitle = selected?.title ?? props.text.allProjects;
  const showSearch = props.entries.length >= PROJECT_SWITCHER_SEARCH_THRESHOLD;
  const visible = filterProjectSwitcherEntries(props.entries, showSearch ? query : "");

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
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      listRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    }
  };
  const handleListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [...(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      event.preventDefault();
      next.focus();
    }
  };

  return (
    <Popover open={props.open} onOpenChange={setOpen}>
      <PopoverTrigger
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
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="w-72 max-w-[calc(100vw-1rem)]"
        viewportClassName="p-1 [--viewport-inline-padding:--spacing(1)]"
        {...(showSearch ? { initialFocus: searchRef } : {})}
        data-project-switcher-popup=""
      >
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
        <SwitcherRow
          selected={props.selectedId === null}
          action="project.overview"
          onClick={() => {
            setOpen(false);
            props.onSelectAll();
          }}
          icon={<LayoutGridIcon aria-hidden className="size-4" />}
        >
          {props.text.allProjects}
        </SwitcherRow>
        <div className="my-1 h-px bg-border" role="separator" />
        <ProjectSwitcherList
          listRef={listRef}
          entries={visible}
          selectedId={props.selectedId}
          label={props.text.chooseProject}
          emptyText={props.text.noProjectFound}
          onKeyDown={handleListKeyDown}
          onChoose={choose}
          {...(props.renderTrailing ? { renderTrailing: props.renderTrailing } : {})}
        />
        <div className="my-1 h-px bg-border" role="separator" />
        <SwitcherRow
          selected={false}
          action="project.add.sidebar.persistent"
          onClick={() => {
            setOpen(false);
            props.onCreateProject();
          }}
          icon={<PlusIcon aria-hidden className="size-4" />}
        >
          {props.text.newProject}
        </SwitcherRow>
      </PopoverPopup>
    </Popover>
  );
}

/** Die Projektzeilen: voller Name (Umbruch statt „…“), Meta-Zeile bei Gleichnamigen. */
export function ProjectSwitcherList(props: {
  readonly entries: ReadonlyArray<ProjectSwitcherEntry>;
  readonly selectedId: string | null;
  readonly label: string;
  readonly emptyText: string;
  readonly onChoose: (id: string) => void;
  readonly onKeyDown?: (event: KeyboardEvent<HTMLUListElement>) => void;
  readonly listRef?: RefObject<HTMLUListElement | null>;
  readonly renderTrailing?: (entry: ProjectSwitcherEntry) => ReactNode;
}) {
  return (
    <ul
      ref={props.listRef}
      aria-label={props.label}
      className="flex max-h-[min(70vh,36rem)] flex-col gap-px overflow-y-auto"
      onKeyDown={props.onKeyDown}
      data-project-switcher-list=""
    >
      {props.entries.map((entry) => (
        <li key={entry.id}>
          <SwitcherRow
            selected={entry.id === props.selectedId}
            action={`project.select:${entry.id}`}
            onClick={() => props.onChoose(entry.id)}
            trailing={props.renderTrailing?.(entry)}
          >
            <span className="block whitespace-normal break-words" data-sensitive="">
              {entry.title}
            </span>
            {entry.meta ? (
              <span
                className="block truncate text-[12px] text-muted-foreground"
                data-project-switcher-meta=""
              >
                {entry.meta}
              </span>
            ) : null}
          </SwitcherRow>
        </li>
      ))}
      {props.entries.length === 0 ? (
        <li className="px-2 py-1.5 text-[13.5px] text-muted-foreground">{props.emptyText}</li>
      ) : null}
    </ul>
  );
}

function SwitcherRow(props: {
  readonly selected: boolean;
  readonly action: string;
  readonly onClick: () => void;
  readonly icon?: ReactNode;
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-current={props.selected ? "true" : undefined}
      data-workjet-action={props.action}
      onClick={props.onClick}
      className={cn(
        "flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1 text-left text-[13.5px] text-popover-foreground outline-none hover:bg-accent focus-visible:bg-accent",
        props.selected && "font-medium",
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
        {props.icon ?? (props.selected ? <CheckIcon aria-hidden className="size-4" /> : null)}
      </span>
      <span className="min-w-0 flex-1 leading-5">{props.children}</span>
      {props.trailing ? <span className="shrink-0 self-center">{props.trailing}</span> : null}
    </button>
  );
}
