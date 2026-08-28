import { createFileRoute } from "@tanstack/react-router";

import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";

function SettingsModelsRoute() {
  return <ProviderSettingsPanel sections="models" />;
}

export const Route = createFileRoute("/settings/models")({
  component: SettingsModelsRoute,
});
