import {
  EnvironmentId,
  WorkjetComputerId,
  WorkjetConnectionId,
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
      role: "standard",
      capabilityIds: ["greppy", "web-search", "web-stack-browser"],
      capabilityBindings: [],
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
    });
  });

  it("requires exactly one Decision Hub binding and persists the root role", () => {
    const draft = {
      ...createWorkjetWorkerDraft({ computers: [computer], routes: [route], id: "worker-1" }),
      name: "Owner coordinator",
      modelId: "gpt-5.6-sol",
      role: "orchestrator" as const,
      capabilityIds: ["decision-hub" as const],
    };
    expect(() => saveWorkjetWorkerDraft(draft)).toThrow("exactly one Decision Hub connection");

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
    expect(saved.role).toBe("orchestrator");
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

    // The panel follows the Swift Workjet worker editor: one column, in the
    // order each choice constrains the next, with the harness, provider,
    // reasoning and target computer as visible option sets rather than
    // dropdowns that hide them.
    const sections = [
      "Name / role",
      "Harness",
      "LLM route",
      "Model",
      "Reasoning",
      "task",
      "Skills",
      "Target computer",
      "Technical details",
    ] as const;
    const order = sections.map((section) => markup.indexOf(section));
    expect(sections.filter((_s, i) => order[i]! < 0)).toEqual([]);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    // Options visible, not hidden behind a trigger.
    expect(markup).toContain("Claude Code");
    expect(markup).toContain("OpenCode");
    expect(markup).toContain("Web Stack Browser");
    // With a route chosen the panel names it.
    expect(markup).toContain("Route: Codex work");
  });
});
