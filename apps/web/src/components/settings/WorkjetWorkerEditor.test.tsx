import {
  EnvironmentId,
  WorkjetComputerId,
  WorkjetConnectionId,
  WorkjetGatewayAccountId,
  WorkjetLlmRouteId,
  WorkjetWorkerProfileId,
  createDefaultWorkjetWorkerPersonalization,
  type WorkjetComputer,
  type WorkjetLlmRoute,
} from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  createWorkjetWorkerDraft,
  saveWorkjetWorkerDraft,
  updateWorkjetWorkerDraft,
  WorkjetWorkerEditor,
  workjetHarnessAvailabilityWarning,
} from "./WorkjetWorkerEditor";

const computerId = WorkjetComputerId.make("computer-1");
const routeId = WorkjetLlmRouteId.make("route-1");
const computer: WorkjetComputer = {
  id: computerId,
  label: "Remote devbox",
  environmentId: EnvironmentId.make("environment-remote"),
  presentationKind: "tailscale",
  harnesses: [
    { harness: "claude-code", available: true },
    { harness: "codex-cli", available: false },
  ],
};
const route: WorkjetLlmRoute = {
  id: routeId,
  label: "Codex work",
  gatewayAccountId: WorkjetGatewayAccountId.make("gateway_account_codex_work"),
};

describe("WorkjetWorkerEditor", () => {
  it("keeps harness and route/model choices independent through updates", () => {
    const initial = {
      ...createWorkjetWorkerDraft({ computers: [computer], routes: [route], id: "worker-1" }),
      name: "Completion",
      modelId: "gpt-5.6-sol",
    };

    const harnessChanged = updateWorkjetWorkerDraft(initial, { harness: "codex-cli" });
    expect(harnessChanged.llmRouteId).toBe(routeId);
    expect(harnessChanged.modelId).toBe("gpt-5.6-sol");

    const routeChanged = updateWorkjetWorkerDraft(harnessChanged, {
      llmRouteId: "route-alternate",
    });
    expect(routeChanged.harness).toBe("codex-cli");
    expect(routeChanged.modelId).toBe("gpt-5.6-sol");
  });

  it("saves every independent field and capability toggle", () => {
    const personalization = createDefaultWorkjetWorkerPersonalization();
    const saved = saveWorkjetWorkerDraft({
      id: "worker-1",
      name: " Completion Engine ",
      instructions: " Implement the assigned production slice. ",
      computerId,
      harness: "claude-code",
      llmRouteId: routeId,
      modelId: " gpt-5.6-sol ",
      reasoning: "high",
      capabilityIds: ["greppy", "web-search", "web-stack-browser"],
      capabilityBindings: [],
      personalization,
    });

    expect(saved).toEqual({
      id: WorkjetWorkerProfileId.make("worker-1"),
      name: "Completion Engine",
      instructions: "Implement the assigned production slice.",
      computerId,
      harness: "claude-code",
      llmRouteId: routeId,
      modelId: "gpt-5.6-sol",
      reasoning: "high",
      role: "standard",
      capabilityIds: ["greppy", "web-search", "web-stack-browser"],
      capabilityBindings: [],
      personalization,
    });
  });

  it("requires exactly one Decision Hub binding without granting a role", () => {
    const draft = {
      ...createWorkjetWorkerDraft({ computers: [computer], routes: [route], id: "worker-1" }),
      name: "Owner coordinator",
      modelId: "gpt-5.6-sol",
      role: "orchestrator" as const,
      capabilityIds: ["decision-hub" as const],
    };
    expect(() => saveWorkjetWorkerDraft(draft)).toThrow("Genau eine Decision-Hub-Verbindung");

    const saved = saveWorkjetWorkerDraft({
      ...draft,
      capabilityBindings: [
        {
          capabilityId: "decision-hub",
          target: {
            kind: "ctox-connection",
            connectionId: WorkjetConnectionId.make("connection-1"),
          },
        },
      ],
    });
    expect(saved.role).toBe("standard");
    expect(saved.capabilityBindings).toHaveLength(1);
  });

  it("warns about an unavailable harness without mutating the selected fields", () => {
    const draft = {
      id: "worker-1",
      name: "Research",
      instructions: "",
      computerId,
      harness: "codex-cli" as const,
      llmRouteId: routeId,
      modelId: "gpt-5.6-terra",
      reasoning: "automatic" as const,
      role: "standard" as const,
      capabilityIds: ["web-search" as const],
      capabilityBindings: [],
      personalization: createDefaultWorkjetWorkerPersonalization(),
    };
    const before = structuredClone(draft);

    expect(workjetHarnessAvailabilityWarning(draft, [computer])).toBe(
      "Codex CLI auf Remote devbox nicht verfügbar.",
    );
    expect(draft).toEqual(before);
  });

  it("renders accessible controls for the complete worker flow", () => {
    const markup = renderToStaticMarkup(
      <WorkjetWorkerEditor
        draftScopeKey="test-instance"
        computers={[computer]}
        routes={[route]}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Preset hinzufügen"');
    // #615: compact tabs; the open editor stays within ~30% of the viewport.
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain("max-h-[30vh]");
    for (const tab of [">Aufgabe<", ">Persönlichkeit<", ">Harness · Modell · Rechner<"])
      expect(markup).toContain(tab);
    // No heading or labels used as titles.
    expect(markup).not.toContain("Luma bearbeiten");
    expect(markup).not.toContain(">Name</label>");
    expect(markup).toContain('aria-label="Name"');
    expect(markup).toContain('aria-label="Aufgabe"');
    expect(markup).toContain(">Speichern</button>");
    // Options visible, not hidden behind a trigger.
    expect(markup).not.toContain("Orchestrator");
    expect(markup).not.toContain("Root role");
    // No disclosure, no raw ids, no explanatory sentences, no popup.
    expect(markup).not.toContain("<details");
    expect(markup).not.toContain("computer-1");
    expect(markup).not.toContain("route-1");
    expect(markup).not.toContain("Settings → Computers");
    expect(markup).not.toContain('role="dialog"');
  });
});
