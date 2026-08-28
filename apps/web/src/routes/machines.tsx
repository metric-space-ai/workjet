import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/machines")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/business-os", replace: true });
  },
});
