import {
  EnvironmentId,
  WorkjetComputerId,
  WorkjetGatewayAccountId,
  WorkjetLlmRouteId,
  WorkjetWorkerProfileId,
  type WorkjetComputer,
  type WorkjetLlmRoute,
} from "@t3tools/contracts";
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
      capabilityIds: ["greppy", "web-search", "web-stack-browser"],
    });
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
      capabilityIds: ["web-search" as const],
    };
    const before = structuredClone(draft);

    expect(workjetHarnessAvailabilityWarning(draft, [computer])).toContain(
      "Enable it in Computers",
    );
    expect(draft).toEqual(before);
  });

  it("renders accessible controls for the complete worker flow", () => {
    const markup = renderToStaticMarkup(
      <WorkjetWorkerEditor
        computers={[computer]}
        routes={[route]}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Add worker"');
    expect(markup).toContain("Name / role");
    expect(markup).toContain("Task / system instructions");
    expect(markup).toContain("Web Stack Browser");
    expect(markup).toContain("connection secrets are managed in Connections");
  });
});
