import { createFileRoute } from "@tanstack/react-router";

import { KeybindingsSettings } from "../components/settings/KeybindingsSettings";

/** Tastenkürzel: Entwicklerseite (#568). */
export const Route = createFileRoute("/settings/keybindings")({
  component: KeybindingsSettings,
});
