/**
 * Icon-Leiste unter dem Projektnamen (Michael, 15.10.): Alle Projekte (Haus),
 * Übersicht, Projekteinstellungen und Suche als kompakte Knöpfe mit Icon und Wort.
 * Erscheint nur in einem Projekt; in „Alle Projekte“ gibt es keine Leiste.
 */
import { HomeIcon, LayoutDashboardIcon, SearchIcon, SettingsIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";

type ButtonClick = ReactMouseEvent<HTMLButtonElement>;

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

export interface SidebarProjectNavText {
  readonly allProjects: string;
  readonly overview: string;
  readonly projectSettings: string;
  readonly search: string;
}

export function SidebarProjectNav(props: {
  /** Name der Leiste für Screenreader: der Projektname. */
  readonly label: string;
  readonly text: SidebarProjectNavText;
  readonly onHome: () => void;
  readonly onOverview?: (() => void) | undefined;
  readonly onSettings?: ((event: ButtonClick) => void) | undefined;
  readonly onSearch: () => void;
  readonly overviewActive?: boolean;
  readonly searchActive?: boolean;
  readonly disabled?: boolean;
  /** Barrierefreier Name der Einstellungen, z. B. „Projekteinstellungen für X“. */
  readonly settingsLabel?: string;
}) {
  return (
    <div
      role="toolbar"
      aria-label={props.label}
      className="flex flex-wrap items-center gap-0.5"
      data-sidebar-project-nav=""
    >
      <NavIcon
        label={props.text.allProjects}
        action="project.overview.home"
        onClick={props.onHome}
        disabled={props.disabled}
      >
        <HomeIcon aria-hidden className="size-3.5" />
      </NavIcon>
      {props.onOverview ? (
        <NavIcon
          label={props.text.overview}
          action="project.workspace.overview"
          onClick={props.onOverview}
          active={props.overviewActive === true}
          disabled={props.disabled}
        >
          <LayoutDashboardIcon aria-hidden className="size-3.5" />
        </NavIcon>
      ) : null}
      {props.onSettings ? (
        <NavIcon
          label={props.text.projectSettings}
          ariaLabel={props.settingsLabel}
          action="project.settings.sidebar"
          onClick={props.onSettings}
        >
          <SettingsIcon aria-hidden className="size-3.5" />
        </NavIcon>
      ) : null}
      <NavIcon
        label={props.text.search}
        action="sidebar.search.open"
        onClick={props.onSearch}
        active={props.searchActive === true}
      >
        <SearchIcon aria-hidden className="size-3.5" />
      </NavIcon>
    </div>
  );
}

function NavIcon(props: {
  readonly label: string;
  readonly ariaLabel?: string | undefined;
  readonly action: string;
  readonly onClick: (event: ButtonClick) => void;
  readonly active?: boolean;
  readonly disabled?: boolean | undefined;
  readonly children: ReactNode;
}) {
  // Icon + Wort (UI-Regel, #798): kein Tooltip als einzige Beschriftung.
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      aria-label={props.ariaLabel ?? props.label}
      aria-pressed={props.active === undefined ? undefined : props.active}
      data-active={props.active ? "" : undefined}
      data-workjet-action={props.action}
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "min-w-0 px-1.5 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        props.active && "bg-sidebar-accent text-sidebar-accent-foreground",
      )}
    >
      {props.children}
      <span className="truncate">{props.label}</span>
    </Button>
  );
}
