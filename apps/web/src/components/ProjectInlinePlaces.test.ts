import { describe, expect, it } from "vite-plus/test";

import commandPaletteSource from "./CommandPalette.tsx?raw";
import projectCalendarSource from "./ProjectCalendar.tsx?raw";
import projectOverviewCardSource from "./ProjectOverviewCard.tsx?raw";
import projectScriptEditorSource from "./projectScriptEditor.tsx?raw";
import projectScriptsControlSource from "./ProjectScriptsControl.tsx?raw";
import projectWorkspaceSource from "./ProjectWorkspace.tsx?raw";
import sidebarAddWorkerSource from "./sidebar/SidebarAddPersistentWorker.tsx?raw";
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

  it("has no „Neue Unterhaltung“; new workers come from the plus (15.10.)", () => {
    expect(sidebarSource).not.toContain('data-workjet-action="thread.new"');
    expect(sidebarSource).not.toContain("overviewText.newThread");
    expect(sidebarSource).toContain("<SidebarAddPersistentWorker");
  });

  it("lives in Einstellungen › Projekte; the old project route opens the card (#569)", () => {
    expect(settingsProjectsSource).toContain('createFileRoute("/settings/projects")');
    expect(settingsProjectsSource).toContain("ProjectsSettingsList");
    expect(settingsProjectSource).toContain('createFileRoute("/settings/projects/$projectKey")');
    expect(sidebarSource).toContain('to: "/settings/projects/$projectKey"');
    expect(settingsProjectSource).toContain("ProjectCardRedirect");
    // Regeltermin, Budget und Supervisor bearbeitet nur die Projektkarte (#569).
    expect(projectSettingsPanelSource).not.toContain('"Regeltermin, Budget und Supervisor"');
    expect(projectSettingsPanelSource).not.toContain("<ProjectOverviewEditor");
    expect(projectSettingsPanelSource).toMatch(/"Skripte"/);
    expect(projectSettingsPanelSource).toContain("<ProjectFaviconPicker");
    expect(projectSettingsPanelSource).toContain("<InlineRemovalConfirm");
  });

  it("edits exit and configuration on the card back without moving the grid", () => {
    // Die Karte behält ihren Platz: keine Zeilen-Ausdehnung, keine Navigation.
    expect(chatIndexSource).not.toContain("data-workjet-project-card-expanded");
    expect(chatIndexSource).not.toContain("col-span-full");
    expect(projectOverviewCardSource).toContain("data-workjet-project-card-backface={editing}");
    expect(projectOverviewCardSource).not.toContain('data-workjet-project-card-section="exit"');
    expect(projectOverviewCardSource).toContain("ProjectExitModelCardPanel");
    expect(projectOverviewCardSource).toContain("ProjectCardConfigEditor");
    expect(projectOverviewCardSource).not.toContain("<ProjectOverviewEditor");
    // „Projekt konfigurieren“ speichert über project.configure statt zu navigieren.
    expect(chatIndexSource).toContain("configureWorkjetProject(activeCtoxInstanceId");
    expect(chatIndexSource).not.toContain('to: "/settings/projects/$projectKey"');
    // „Worker hinzufügen“ lebt nur noch als Plus in der Seitenleiste (15.10.).
    expect(projectWorkspaceSource).not.toContain("<InlinePanel");
    expect(sidebarAddWorkerSource).toContain("<InlinePanel");
  });
});
