import type { EnvironmentId } from "@workjet/contracts";
import type { RelayClientEnvironmentRecord } from "@workjet/contracts/relay";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { WorkjetConnectEnvironmentRow } from "./WorkjetConnectUserProfilePage";

const environment: RelayClientEnvironmentRecord = {
  environmentId: "environment-1" as EnvironmentId,
  label: "Studio Mac",
  endpoint: {
    httpBaseUrl: "https://studio.example.com",
    wsBaseUrl: "wss://studio.example.com",
    providerKind: "cloudflare_tunnel",
  },
  linkedAt: "2026-08-12T12:00:00.000Z",
};

function renderRow({
  confirmationOpen = false,
  mutationPending = false,
}: {
  readonly confirmationOpen?: boolean;
  readonly mutationPending?: boolean;
} = {}) {
  return renderToStaticMarkup(
    <WorkjetConnectEnvironmentRow
      environment={environment}
      confirmationOpen={confirmationOpen}
      mutationPending={mutationPending}
      onConfirmationChange={vi.fn()}
      onDeregister={vi.fn()}
    />,
  );
}

describe("Workjet Connect environment row", () => {
  it("keeps deregistration confirmation inline and collapsed by default", () => {
    const markup = renderRow();

    expect(markup).toContain("Studio Mac");
    expect(markup).toContain("Abmelden");
    expect(markup).not.toContain("Server abmelden");
    expect(markup).not.toContain("Studio Mac abmelden");
  });

  it("expands Clerk-style confirmation content beneath the environment row", () => {
    const markup = renderRow({ confirmationOpen: true });

    expect(markup).toContain("Server abmelden");
    expect(markup).toContain("„Studio Mac“ wird entfernt");
    expect(markup).toContain("Studio Mac abmelden");
    expect(markup).not.toContain("Local connections on your devices are not changed.");
    expect(markup).toContain("Abbrechen");
  });

  it("locks the confirmation actions while deregistration is pending", () => {
    const markup = renderRow({ confirmationOpen: true, mutationPending: true });

    expect(markup).toContain("Wird abgemeldet …");
    expect(markup.match(/ disabled=""/g)).toHaveLength(3);
  });
});
