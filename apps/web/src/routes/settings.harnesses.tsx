import { createFileRoute, redirect } from "@tanstack/react-router";

/** Coding agents moved onto Rechner (#554); old links land there. */
export const Route = createFileRoute("/settings/harnesses")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/computers", hash: "harnesses", replace: true });
  },
});
