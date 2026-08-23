import { createFileRoute } from "@tanstack/react-router";

import { WorkjetSettings } from "../components/settings/WorkjetSettings";

/**
 * Computers as a TOP-LEVEL settings page, as the operator specified twice:
 * machines are not a detail of worker configuration — a worker references a
 * computer, so the computer has to exist first and deserves its own place
 * beside Models and Harnesses. Rendering the existing Computers section keeps
 * one implementation; only the entry point moves.
 */
function SettingsComputersRoute() {
  return <WorkjetSettings defaultSection="computers" />;
}

export const Route = createFileRoute("/settings/computers")({
  component: SettingsComputersRoute,
});
