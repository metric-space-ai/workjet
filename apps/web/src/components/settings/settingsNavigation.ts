import type { ComponentType } from "react";
import {
  ActivityIcon,
  ArchiveIcon,
  AudioLinesIcon,
  CpuIcon,
  FolderKanbanIcon,
  GitBranchIcon,
  KeyboardIcon,
  MonitorIcon,
  PlugIcon,
  ServerIcon,
  Settings2Icon,
  TerminalIcon,
  UserRoundIcon,
} from "lucide-react";
import {
  DEVELOPER_SETTINGS_PAGE_PATHS,
  SETTINGS_PAGE_PATHS,
  SETTINGS_SECTION_LABELS,
  SETTINGS_SUBPAGE_PARENTS,
  type SettingsPagePath,
  type SettingsPath,
} from "./settingsSearch";

const PAGE_ICONS: Readonly<Record<SettingsPagePath, ComponentType<{ className?: string }>>> = {
  "/settings/general": Settings2Icon,
  "/settings/business-os": ServerIcon,
  "/settings/computers": MonitorIcon,
  "/settings/models": CpuIcon,
  "/settings/workjet": UserRoundIcon,
  "/settings/projects": FolderKanbanIcon,
  "/settings/speech": AudioLinesIcon,
  "/settings/archived": ArchiveIcon,
  "/settings/diagnostics": ActivityIcon,
  "/settings/harnesses": TerminalIcon,
  "/settings/integrations": PlugIcon,
  "/settings/source-control": GitBranchIcon,
  "/settings/keybindings": KeyboardIcon,
};

export const SETTINGS_SECTION_ICONS: Readonly<
  Record<SettingsPath, ComponentType<{ className?: string }>>
> = {
  ...PAGE_ICONS,
  "/settings/prompts": PAGE_ICONS[SETTINGS_SUBPAGE_PARENTS["/settings/prompts"]],
  "/settings/usage": PAGE_ICONS[SETTINGS_SUBPAGE_PARENTS["/settings/usage"]],
};

export interface SettingsNavItem {
  readonly to: SettingsPagePath;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
}

function navItem(to: SettingsPagePath): SettingsNavItem {
  return { to, label: SETTINGS_SECTION_LABELS[to], icon: PAGE_ICONS[to] };
}

/** Die acht Seiten (#568). */
export const SETTINGS_NAV_ITEMS: ReadonlyArray<SettingsNavItem> = SETTINGS_PAGE_PATHS.map(navItem);

/** Acht Seiten plus die fünf Entwicklerseiten. */
export const DEVELOPER_SETTINGS_NAV_ITEMS: ReadonlyArray<SettingsNavItem> = [
  ...SETTINGS_NAV_ITEMS,
  ...DEVELOPER_SETTINGS_PAGE_PATHS.map(navItem),
];

export function settingsNavItems(
  developerMode: boolean,
  options: { readonly speechAvailable?: boolean } = {},
): ReadonlyArray<SettingsNavItem> {
  const items = developerMode ? DEVELOPER_SETTINGS_NAV_ITEMS : SETTINGS_NAV_ITEMS;
  // Kennt CTOX auf der Instanz keine Spracheinstellungen, fehlt der Eintrag.
  return options.speechAvailable === false
    ? items.filter((item) => item.to !== "/settings/speech")
    : items;
}
