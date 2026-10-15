import { createFileRoute } from "@tanstack/react-router";

import { ProjectSettingsPanel } from "../components/settings/ProjectSettingsPanel";

/** Einstellungen › Projekte › <Projekt>: Regeltermin, Budget, Supervisor, Skripte, Icon. */
export const Route = createFileRoute("/settings/projects/$projectKey")({
  component: () => <ProjectSettingsPanel projectKey={Route.useParams().projectKey} />,
});
