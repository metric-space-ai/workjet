import { describe, expect, it } from "vite-plus/test";

import commandPaletteSource from "./CommandPalette.tsx?raw";
import commandPaletteResultsSource from "./CommandPaletteResults.tsx?raw";
import sidebarSource from "./Sidebar.tsx?raw";
import chatIndexSource from "../routes/_chat.index.tsx?raw";

describe("CTOX-native project story", () => {
  it("creates a logical CTOX project before choosing a computer or working copy", () => {
    const start = commandPaletteSource.indexOf("const openAddProjectFlow");
    const end = commandPaletteSource.indexOf("useLayoutEffect", start);
    const visibleFlow = commandPaletteSource.slice(start, end);

    expect(visibleFlow).toContain('value: "action:add-project:create"');
    expect(visibleFlow).toContain('"Enter a project name"');
    expect(visibleFlow).toContain("Computer and working copy are chosen later");
    expect(visibleFlow).not.toContain("addProjectEnvironmentOptions");
    expect(visibleFlow).not.toContain("No Code computer assigned");
    expect(visibleFlow).not.toContain("projectEnvironment.create");
    expect(visibleFlow).not.toContain("pickFolder");
  });

  it("keeps the palette open until the authoritative project is in the active registry", () => {
    const start = commandPaletteSource.indexOf("const createLogicalProjectFromTitle");
    const end = commandPaletteSource.indexOf("const openAddProjectFlow", start);
    const creation = commandPaletteSource.slice(start, end);

    expect(creation).toContain("await runWorkjetProjectCreation");
    expect(creation).toContain("recordWorkjetProjectProjection");
    expect(creation).toContain("setIsLogicalProjectCreating(true)");
    expect(creation).toContain("setIsLogicalProjectCreating(false)");
    expect(creation).toContain("readWorkjetProjectRegistry(presentationInstanceId).projects.some");
    expect(creation.indexOf("setOpen(false)")).toBeGreaterThan(
      creation.indexOf("readWorkjetProjectRegistry(presentationInstanceId).projects.some"),
    );
  });

  it("exposes stable action IDs and the authoritative project in Code chrome", () => {
    expect(commandPaletteResultsSource).toContain("data-workjet-action={props.item.value}");
    expect(commandPaletteSource).toContain('data-workjet-action="project.create.submit"');
    expect(sidebarSource).toContain('data-workjet-action="project.add.sidebar"');
    expect(chatIndexSource).toContain('data-workjet-action="project.add.hero"');
    expect(sidebarSource).toContain("useWorkjetProjectRegistry(activeCtoxInstanceId)");
    expect(sidebarSource).toContain("project.title");
    expect(sidebarSource).toContain('router.navigate({ to: "/" })');
    expect(chatIndexSource).toContain('data-workjet-project-state="ready"');
    expect(chatIndexSource).toContain("Project synced with this CTOX instance");
  });
});
