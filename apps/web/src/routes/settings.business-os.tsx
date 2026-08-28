import { createFileRoute } from "@tanstack/react-router";

import { BusinessOsSettings } from "../components/settings/BusinessOsSettings";

export const Route = createFileRoute("/settings/business-os")({
  component: BusinessOsSettings,
});
