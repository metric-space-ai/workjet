import { createFileRoute } from "@tanstack/react-router";

import { WorkjetSettings } from "../components/settings/WorkjetSettings";

function SystemPromptsSettings() {
  return <WorkjetSettings defaultSection="prompt" />;
}

/** System-Prompts: own settings page with the role tabs (#618). */
export const Route = createFileRoute("/settings/prompts")({
  component: SystemPromptsSettings,
});
