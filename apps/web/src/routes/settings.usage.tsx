import { createFileRoute } from "@tanstack/react-router";

import { UsagePage } from "../components/usage/UsagePage";

/** Einstellungen › Verbrauch (früher die eigene Seite /usage). */
export const Route = createFileRoute("/settings/usage")({
  component: UsagePage,
});
