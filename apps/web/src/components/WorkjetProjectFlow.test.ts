import { describe, expect, it } from "vite-plus/test";

import commandPaletteSource from "./CommandPalette.tsx?raw";
import sidebarSource from "./Sidebar.tsx?raw";
import chatIndexSource from "../routes/_chat.index.tsx?raw";
import registrationSource from "../localProjectRegistration.tsx?raw";

describe("CTOX-native project story", () => {
  it("creates projects inline in the gallery, never in a palette dialog", () => {
    const start = chatIndexSource.indexOf("function InlineProjectCreate(");
    const end = chatIndexSource.indexOf("export const Route", start);
    const visibleFlow = chatIndexSource.slice(start, end > start ? end : undefined);

    expect(visibleFlow).toContain('triggerLabel="Projekt anlegen"');
    expect(visibleFlow).toContain('aria-label="Instanz"');
    expect(visibleFlow).not.toContain("addProjectEnvironmentOptions");
    expect(visibleFlow).not.toContain("No Code computer assigned");
    expect(visibleFlow).not.toContain("Select a CTOX instance for this project.");
    expect(commandPaletteSource).not.toContain("CommandDialog");
    expect(commandPaletteSource).toContain("requestProjectCreate()");
  });

  it("saves a name-only project locally before any native catalog request and retains its retry identity", () => {
    const start = chatIndexSource.indexOf("const submit = async () => {");
    const end = chatIndexSource.indexOf("return (", start);
    const creation = chatIndexSource.slice(start, end);
    expect(creation).toContain("workspaceRoot: null");
    expect(creation).toContain("await createProject");
    expect(creation).toContain(".get(environmentProjects.projectsAtom)");
    expect(creation).toContain("project.environmentId === environmentId");
    expect(creation).not.toContain("listWorkjetProjects");
    expect(creation).not.toContain("runWorkjetProjectCreation");
    expect(creation).toMatch(
      /ctoxRegistration:\s*\{\s*instanceId,\s*commandId:\s*attempt.commandId,\s*status:\s*"pending"/,
    );
    expect(creation).toContain("attemptRef.current?.key !== key");
    expect(creation).toContain("setError(");
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

  it("maps every former palette request onto an inline place", () => {
    expect(commandPaletteSource).toContain('detail.open === "add-project"');
    expect(commandPaletteSource).toContain('detail.open === "new-thread-in"');
    expect(commandPaletteSource).toContain("startNewThreadFromContext");
    expect(commandPaletteSource).toContain('command === "commandPalette.toggle"');
    expect(commandPaletteSource).toContain("focusSearch()");
    expect(sidebarSource).toContain('data-sidebar-search=""');
  });

  it("exposes stable action IDs and the authoritative project in Code chrome", () => {
    expect(sidebarSource).toContain('data-workjet-action="project.add.sidebar"');
    expect(chatIndexSource).toContain('triggerAction="project.add.hero"');
    expect(sidebarSource).toContain("useAvailableProjectContext()");
    expect(sidebarSource).toContain("project.title");
    expect(chatIndexSource).toContain(
      'data-workjet-project-state={error ? "opening-error" : slow ? "opening-slow" : "opening"}',
    );
    expect(chatIndexSource).toContain("void openNativeSupervisor(selectedNative)");
    expect(chatIndexSource).toContain('data-workjet-action="project.open.supervisor.retry"');
    expect(chatIndexSource).toContain("PROJECT_OPENING_TIMEOUT_MS = 10_000");
    expect(chatIndexSource).not.toContain("Project synced with this CTOX instance");
  });
});
