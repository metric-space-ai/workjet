import { createFileRoute } from "@tanstack/react-router";

import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";

function SettingsHarnessesRoute() {
  return <ProviderSettingsPanel sections="harnesses" />;
}

export const Route = createFileRoute("/settings/harnesses")({
  component: SettingsHarnessesRoute,
});
