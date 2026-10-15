import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";

import { ProjectsSettingsRedirect } from "../components/settings/ProjectSettingsPanel";

/**
 * Einstellungen › Projekte gibt es nicht mehr (15.10.): der alte Link landet
 * auf der Projektübersicht, ein Projekt-Link auf dessen Projektkarte.
 */
function ProjectsSettingsRoute() {
  const childMatches = useChildMatches();
  return childMatches.length > 0 ? <Outlet /> : <ProjectsSettingsRedirect />;
}

export const Route = createFileRoute("/settings/projects")({
  component: ProjectsSettingsRoute,
});
