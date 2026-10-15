import { EnvironmentId, ProjectId } from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { AvailableProject } from "../availableProjects";
import { buildNewThreadMenuEntries, NEW_THREAD_IN_LABEL, NewThreadInMenu } from "./NewThreadInMenu";
import sidebarSource from "./Sidebar.tsx?raw";
import { SidebarProvider } from "./ui/sidebar";

const environmentId = EnvironmentId.make("environment-local");
const project = (id: string, title: string): AvailableProject => ({
  kind: "local",
  id: ProjectId.make(id),
  title,
  environmentId,
  path: `/work/${id}`,
});

describe("Neue Unterhaltung in …", () => {
  it("lists every project once, sorted by title", () => {
    const entries = buildNewThreadMenuEntries(
      [project("b", "Zeta"), project("a", "Alpha"), project("b", "Zeta")],
      null,
    );
    expect(entries.map((entry) => entry.title)).toEqual(["Alpha", "Zeta"]);
  });

  it("falls back to the computer's working copy when no project is listed", () => {
    const fallback = project("f", "Fallback");
    expect(buildNewThreadMenuEntries([], fallback).map((entry) => entry.project)).toEqual([
      fallback,
    ]);
    expect(buildNewThreadMenuEntries([], null)).toEqual([]);
  });

  it("renders a plain dropdown trigger, no dialog", () => {
    const html = renderToStaticMarkup(
      <SidebarProvider>
        <NewThreadInMenu
          entries={buildNewThreadMenuEntries([project("a", "Alpha")], null)}
          open={false}
          onOpenChange={() => {}}
          onSelect={() => {}}
          onCreateProject={() => {}}
        />
      </SidebarProvider>,
    );
    expect(html).toContain(`aria-label="${NEW_THREAD_IN_LABEL}"`);
    expect(html).not.toContain('role="dialog"');
  });

  it("is wired into the sidebar instead of the former palette picker", () => {
    expect(sidebarSource).toContain("<NewThreadInMenu");
    expect(sidebarSource).toContain("setNewThreadMenuOpen(true)");
    expect(sidebarSource).not.toContain('openCommandPalette({ open: "new-thread-in" })');
    expect(sidebarSource).toContain("onNewThreadMenuRequest(");
  });
});
