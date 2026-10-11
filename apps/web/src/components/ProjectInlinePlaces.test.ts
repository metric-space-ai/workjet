import { describe, expect, it } from "vite-plus/test";

import commandPaletteSource from "./CommandPalette.tsx?raw";
import projectCalendarSource from "./ProjectCalendar.tsx?raw";
import projectOverviewCardSource from "./ProjectOverviewCard.tsx?raw";
import projectScriptEditorSource from "./projectScriptEditor.tsx?raw";
import projectScriptsControlSource from "./ProjectScriptsControl.tsx?raw";
import projectWorkspaceSource from "./ProjectWorkspace.tsx?raw";
import sidebarSource from "./Sidebar.tsx?raw";
import projectFaviconPickerSource from "./settings/ProjectFaviconPicker.tsx?raw";
import projectSettingsPanelSource from "./settings/ProjectSettingsPanel.tsx?raw";
import chatIndexSource from "../routes/_chat.index.tsx?raw";
import settingsProjectsSource from "../routes/settings.projects.tsx?raw";
import settingsProjectSource from "../routes/settings.projects.$projectKey.tsx?raw";

// Drei Orte (Dev, Ops, Einstellungen), keine Popups: the project places
// must not bring back a dialog, alert dialog, popover with content, command
// dialog or a custom role="dialog" overlay.
const POPUP_PATTERN =
  /from "\.\/ui\/(?:dialog|alert-dialog|popover|sheet|command)"|from "\.\.\/ui\/(?:dialog|alert-dialog|popover|sheet|command)"|CommandDialog|role="dialog"|api\.dialogs\.confirm/;

describe("project places are inline", () => {
  it.each([
    ["CommandPalette.tsx", commandPaletteSource],
    ["ProjectCalendar.tsx", projectCalendarSource],
    ["ProjectOverviewCard.tsx", projectOverviewCardSource],
    ["projectScriptEditor.tsx", projectScriptEditorSource],
    ["ProjectScriptsControl.tsx", projectScriptsControlSource],
    ["ProjectWorkspace.tsx", projectWorkspaceSource],
    ["settings/ProjectFaviconPicker.tsx", projectFaviconPickerSource],
    ["settings/ProjectSettingsPanel.tsx", projectSettingsPanelSource],
    ["routes/_chat.index.tsx", chatIndexSource],
  ])("%s opens no popup", (_name, source) => {
    expect(source).not.toMatch(POPUP_PATTERN);
  });

  it("snoozes from a plain menu with fixed options instead of a popover", () => {
    expect(sidebarSource).not.toContain('from "./ui/popover"');
    expect(sidebarSource).toContain("function SnoozeMenuButton(");
    expect(sidebarSource).toContain('"next-week": "Nächste Woche"');
  });

  it("keeps the new-thread button usable without projects", () => {
    expect(sidebarSource).not.toContain("isSidebarNewThreadDisabled(");
    expect(sidebarSource).toContain("if (sidebarAvailableProjectCount === 0) {");
  });

  it("lives in Einstellungen › Projekte › <Projekt>", () => {
    expect(settingsProjectsSource).toContain('createFileRoute("/settings/projects")');
    expect(settingsProjectsSource).toContain("ProjectsSettingsList");
    expect(settingsProjectSource).toContain('createFileRoute("/settings/projects/$projectKey")');
    expect(sidebarSource).toContain('to: "/settings/projects/$projectKey"');
    expect(projectSettingsPanelSource).toContain('title="Regeltermin, Budget und Supervisor"');
    expect(projectSettingsPanelSource).toContain('title="Skripte"');
    expect(projectSettingsPanelSource).toContain("<ProjectFaviconPicker");
    expect(projectSettingsPanelSource).toContain("<InlineRemovalConfirm");
  });

  it("expands manage and exit inline in the gallery card", () => {
    expect(projectOverviewCardSource).toContain('data-workjet-project-card-section="configure"');
    expect(projectOverviewCardSource).toContain('data-workjet-project-card-section="exit"');
    expect(chatIndexSource).toContain(
      "[&>*:has([data-workjet-project-card-expanded])]:col-span-full",
    );
    expect(projectWorkspaceSource).toContain("<InlinePanel");
  });
});
