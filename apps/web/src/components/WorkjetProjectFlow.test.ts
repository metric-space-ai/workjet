import { describe, expect, it } from "vite-plus/test";

import commandPaletteSource from "./CommandPalette.tsx?raw";
import commandPaletteResultsSource from "./CommandPaletteResults.tsx?raw";
import sidebarSource from "./Sidebar.tsx?raw";
import chatIndexSource from "../routes/_chat.index.tsx?raw";
import registrationSource from "../localProjectRegistration.tsx?raw";

describe("CTOX-native project story", () => {
  it("does not gate the visible Add project flow on an Environment or computer assignment", () => {
    const start = commandPaletteSource.indexOf("const openAddProjectFlow");
    const end = commandPaletteSource.indexOf("useLayoutEffect", start);
    const visibleFlow = commandPaletteSource.slice(start, end);

    expect(visibleFlow).toContain("setIsLogicalProjectNameEntry(true)");
    expect(visibleFlow).toContain("setLogicalProjectFolder(null)");
    expect(commandPaletteSource).toContain("Attach folder (optional)");
    expect(visibleFlow).not.toContain("addProjectEnvironmentOptions");
    expect(visibleFlow).not.toContain("No Code computer assigned");
    expect(visibleFlow).not.toContain("projectEnvironment.create");
  });

  it("saves a name-only project locally before any native catalog request and retains its retry identity", () => {
    const start = commandPaletteSource.indexOf("const createLogicalProject =");
    const end = commandPaletteSource.indexOf("const createLogicalProjectFromPath", start);
    const creation = commandPaletteSource.slice(start, end);
    expect(creation).toContain("workspaceRoot: string | null");
    expect(creation).toContain("await createProject");
    expect(creation).toContain(".get(environmentProjects.projectsAtom)");
    expect(creation).toContain(".filter((project) => project.environmentId === environmentId)");
    expect(creation).not.toContain("unscopedProjects.filter");
    expect(creation).not.toContain("listWorkjetProjects");
    expect(creation).not.toContain("runWorkjetProjectCreation");
    expect(creation).toMatch(
      /ctoxRegistration:\s*\{\s*instanceId,\s*commandId:\s*attempt.commandId,\s*status:\s*"pending"/,
    );
    expect(creation).toContain("logicalProjectAttemptRef.current?.key !== attemptKey");
    expect(creation).toContain("setLogicalProjectCreationError(description)");
    expect(registrationSource).toContain("commandId: intent.commandId");
    expect(registrationSource).toContain("projectId: project.id");
    expect(registrationSource).toContain("currentScope.selectionRevision !== selectionRevision");
    expect(
      registrationSource.search(
        /if \(outcome\._tag === "visible"\)\s*recordWorkjetProjectProjection/,
      ),
    ).toBeGreaterThan(registrationSource.indexOf("await runWorkjetProjectCreation"));
    expect(registrationSource).toMatch(/status:\s*"pending",\s*lastFailure:\s*outcome.code/);
    expect(registrationSource).not.toContain("setInterval");
  });

  it("submits an entered local folder path through the same authoritative CTOX flow", () => {
    expect(commandPaletteSource).toContain("Create project");
    expect(commandPaletteSource).toContain("setIsLogicalProjectPathEntry(logicalProjectPathEntry)");
    expect(commandPaletteSource).toContain("isLogicalProjectPathEntry &&");
    expect(commandPaletteSource).toContain(
      "void createLogicalProjectFromPath(resolvedAddProjectPath)",
    );
    expect(commandPaletteSource).toContain("ProjectCreationProgress stage={projectCreationStage}");
    expect(commandPaletteSource).toContain('aria-live="polite"');
  });

  it("exposes stable action IDs and the authoritative project in Code chrome", () => {
    expect(commandPaletteResultsSource).toContain("data-workjet-action={props.item.value}");
    expect(sidebarSource).toContain('data-workjet-action="project.add.sidebar"');
    expect(chatIndexSource).toContain('data-workjet-action="project.add.hero"');
    expect(sidebarSource).toContain("useAvailableProjectContext()");
    expect(sidebarSource).toContain("project.title");
    expect(chatIndexSource).toContain('data-workjet-project-state="ready"');
    expect(chatIndexSource).toContain("Project synced with this CTOX instance");
  });
});
