import { describe, expect, it } from "vite-plus/test";

import commandPaletteSource from "./CommandPalette.tsx?raw";
import commandPaletteResultsSource from "./CommandPaletteResults.tsx?raw";
import sidebarSource from "./Sidebar.tsx?raw";
import chatIndexSource from "../routes/_chat.index.tsx?raw";

describe("CTOX-native project story", () => {
  it("does not gate the visible Add project flow on an Environment or computer assignment", () => {
    const start = commandPaletteSource.indexOf("const openAddProjectFlow");
    const end = commandPaletteSource.indexOf("useLayoutEffect", start);
    const visibleFlow = commandPaletteSource.slice(start, end);

    expect(visibleFlow).toContain('value: "action:add-project:choose-folder"');
    expect(visibleFlow).toContain("createLogicalProjectFromFolder");
    expect(visibleFlow).toContain('value: "action:add-project:enter-folder-path"');
    expect(visibleFlow).toContain("startAddProjectBrowse(environmentId, true)");
    expect(visibleFlow).not.toContain("addProjectEnvironmentOptions");
    expect(visibleFlow).not.toContain("No Code computer assigned");
    expect(visibleFlow).not.toContain("projectEnvironment.create");
  });

  it("creates the local Code project before confirming its authoritative CTOX projection", () => {
    const start = commandPaletteSource.indexOf("const createLogicalProjectFromPath");
    const end = commandPaletteSource.indexOf("const createLogicalProjectFromFolder", start);
    const creation = commandPaletteSource.slice(start, end);

    expect(creation).toContain("await createProject");
    expect(creation).toContain("unscopedProjects.filter");
    expect(creation.indexOf("await createProject")).toBeLessThan(
      creation.indexOf("await runWorkjetProjectCreation"),
    );
    expect(creation).toContain("...(workingCopyComputer");
    expect(creation).toContain("confirmedRegistry.projects.find");
    expect(creation).toContain("if (confirmedProject === undefined)");
    expect(creation).toContain("recordWorkjetProjectProjection");
    expect(creation).toContain("readWorkjetProjectRegistry(presentationInstanceId).projects.some");
    expect(creation.indexOf("setOpen(false)")).toBeGreaterThan(
      creation.indexOf("readWorkjetProjectRegistry(presentationInstanceId).projects.some"),
    );
    expect(creation).toContain("setIsLogicalProjectCreating(true)");
    expect(creation).toContain("setLogicalProjectCreationError(description)");
    expect(creation).toContain("Workjet could not reach the active CTOX shell");
  });

  it("submits an entered local folder path through the same authoritative CTOX flow", () => {
    expect(commandPaletteSource).toContain('title: "Enter folder path…"');
    expect(commandPaletteSource).toContain("setIsLogicalProjectPathEntry(logicalProjectPathEntry)");
    expect(commandPaletteSource).toContain("isLogicalProjectPathEntry &&");
    expect(commandPaletteSource).toContain(
      "void createLogicalProjectFromPath(resolvedAddProjectPath)",
    );
    expect(commandPaletteSource).toContain("Adding the local project and syncing it with CTOX…");
    expect(commandPaletteSource).toContain('aria-live="polite"');
  });

  it("exposes stable action IDs and the authoritative project in Code chrome", () => {
    expect(commandPaletteResultsSource).toContain("data-workjet-action={props.item.value}");
    expect(sidebarSource).toContain('data-workjet-action="project.add.sidebar"');
    expect(chatIndexSource).toContain('data-workjet-action="project.add.hero"');
    expect(sidebarSource).toContain("useWorkjetProjectRegistry(activeCtoxInstanceId)");
    expect(sidebarSource).toContain("project.title");
    expect(chatIndexSource).toContain('data-workjet-project-state="ready"');
    expect(chatIndexSource).toContain("Project synced with this CTOX instance");
  });
});
