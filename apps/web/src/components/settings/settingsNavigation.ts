import type { ComponentType } from "react";
import {
  ActivityIcon,
  ArchiveIcon,
  BriefcaseBusinessIcon,
  GitBranchIcon,
  KeyboardIcon,
  MonitorIcon,
  PaletteIcon,
  SparklesIcon,
  TerminalIcon,
  Settings2Icon,
  WrenchIcon,
} from "lucide-react";
import { SETTINGS_SECTION_LABELS, type SettingsPath } from "./settingsSearch";

export const SETTINGS_SECTION_ICONS: Readonly<
  Record<SettingsPath, ComponentType<{ className?: string }>>
> = {
  "/settings/business-os": BriefcaseBusinessIcon,
  "/settings/general": Settings2Icon,
  "/settings/appearance": PaletteIcon,
  "/settings/keybindings": KeyboardIcon,
  "/settings/harnesses": TerminalIcon,
  "/settings/models": SparklesIcon,
  "/settings/computers": MonitorIcon,
  "/settings/workjet": WrenchIcon,
  "/settings/source-control": GitBranchIcon,
  "/settings/diagnostics": ActivityIcon,
  "/settings/archived": ArchiveIcon,
};

export const SETTINGS_NAV_ITEMS = (Object.keys(SETTINGS_SECTION_LABELS) as SettingsPath[]).map(
  (to) => ({
    to,
    label: SETTINGS_SECTION_LABELS[to],
    icon: SETTINGS_SECTION_ICONS[to],
  }),
);

export const INSTANCE_SETTINGS_NAV_ITEMS = SETTINGS_NAV_ITEMS.filter(
  (item) => item.to !== "/settings/business-os",
);
