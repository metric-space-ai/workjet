import { createFileRoute } from "@tanstack/react-router";

import { WorkjetSettings } from "../components/settings/WorkjetSettings";

export const Route = createFileRoute("/settings/workjet")({
  component: WorkjetSettings,
});
