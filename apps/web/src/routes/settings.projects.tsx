import { Outlet, createFileRoute, useChildMatches } from "@tanstack/react-router";

import { ProjectsSettingsList } from "../components/settings/ProjectSettingsPanel";

/**
 * Einstellungen › Projekte: the project list as Rows. A selected project
 * (Einstellungen › Projekte › <Projekt>) renders as the child route.
 */
function ProjectsSettingsRoute() {
  const childMatches = useChildMatches();
  return childMatches.length > 0 ? <Outlet /> : <ProjectsSettingsList />;
}

export const Route = createFileRoute("/settings/projects")({
  component: ProjectsSettingsRoute,
});
