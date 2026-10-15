import { createFileRoute, redirect } from "@tanstack/react-router";

/** Darstellung ist eine Zeile in „Allgemein“ (#553); alte Links landen dort. */
export const Route = createFileRoute("/settings/appearance")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/general", hash: "color-scheme", replace: true });
  },
});
