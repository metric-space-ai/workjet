import { createFileRoute } from "@tanstack/react-router";

import { WorkjetComputersSettings } from "../components/settings/WorkjetComputersSettings";

/**
 * Computers as a TOP-LEVEL settings page, as the operator specified twice:
 * machines are not a detail of worker configuration — a worker references a
 * computer, so the computer has to exist first and deserves its own place
 * beside Models and Harnesses. The page has its own component (titled
 * "Computers", not "Workjet") and also hosts the remote-environment pairing
 * that used to live on Connections.
 */
export const Route = createFileRoute("/settings/computers")({
  component: WorkjetComputersSettings,
});
