import type { ComponentType } from "react";
import {
  ActivityIcon,
  AudioLinesIcon,
  ArchiveIcon,
  CpuIcon,
  FolderKanbanIcon,
  GitBranchIcon,
  KeyboardIcon,
  MonitorIcon,
  PaletteIcon,
  ServerIcon,
  TerminalIcon,
  Settings2Icon,
  UserRoundIcon,
} from "lucide-react";
import { SETTINGS_SECTION_LABELS, type SettingsPath } from "./settingsSearch";

export const SETTINGS_SECTION_ICONS: Readonly<
  Record<SettingsPath, ComponentType<{ className?: string }>>
> = {
  "/settings/business-os": ServerIcon,
  "/settings/general": Settings2Icon,
  "/settings/appearance": PaletteIcon,
  "/settings/keybindings": KeyboardIcon,
  "/settings/harnesses": TerminalIcon,
  "/settings/models": CpuIcon,
  "/settings/speech": AudioLinesIcon,
  "/settings/computers": MonitorIcon,
  "/settings/workjet": UserRoundIcon,
  "/settings/projects": FolderKanbanIcon,
  "/settings/source-control": GitBranchIcon,
  "/settings/diagnostics": ActivityIcon,
  "/settings/archived": ArchiveIcon,
};

export const SETTINGS_NAV_ITEMS = (Object.keys(SETTINGS_SECTION_LABELS) as SettingsPath[])
  .filter((to) => to !== "/settings/keybindings")
  .map((to) => ({
    to,
    label: SETTINGS_SECTION_LABELS[to],
    icon: SETTINGS_SECTION_ICONS[to],
  }));

export const INSTANCE_SETTINGS_NAV_ITEMS = SETTINGS_NAV_ITEMS.filter(
  (item) => item.to !== "/settings/business-os",
);
