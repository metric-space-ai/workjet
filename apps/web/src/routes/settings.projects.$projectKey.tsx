import { createFileRoute } from "@tanstack/react-router";

import { ProjectCardRedirect } from "../components/settings/ProjectSettingsPanel";

/** Früher Einstellungen › Projekte › <Projekt>; heute die Projektkarte (#569). */
export const Route = createFileRoute("/settings/projects/$projectKey")({
  component: () => <ProjectCardRedirect projectKey={Route.useParams().projectKey} />,
});
