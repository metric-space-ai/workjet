import { createFileRoute } from "@tanstack/react-router";

import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";

/** Harnesses: Entwicklerseite mit den Coding-Agenten je Rechner (#568). */
export const Route = createFileRoute("/settings/harnesses")({
  component: () => <ProviderSettingsPanel sections="harnesses" />,
});
