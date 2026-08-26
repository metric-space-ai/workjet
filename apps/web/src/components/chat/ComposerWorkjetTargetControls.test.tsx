// SPDX-License-Identifier: MIT OR AGPL-3.0-only
import {
  EnvironmentId,
  WorkjetComputerId,
  WorkjetGatewayAccountId,
  WorkjetLlmRouteId,
  type WorkjetComputer,
  type WorkjetGatewayModelSummary,
  type WorkjetLlmRoute,
  type WorkjetThreadConfig,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  COMPOSER_COMPUTER_LOCKED_REASON,
  COMPOSER_COMPUTER_NOT_PAIRED_HINT,
  ComposerComputerControlView,
  ComposerManualTargetControlsView,
  ComposerWorkjetCompactMenuContent,
  ComposerSystemPromptControlView,
  COMPOSER_GATEWAY_PROVIDER_RAIL,
  composerGatewayModelMenuGroups,
  composerHarnessOptions,
  gatewayModelsForRoute,
  harnessForProviderInstanceId,
  inferGatewayProviderFromModelId,
  isComputerPaired,
} from "./ComposerWorkjetTargetControls";
import { executeWorkjetCapabilitySet } from "./WorkjetCapabilityMenu";

const envA = EnvironmentId.make("environment-a");
const envB = EnvironmentId.make("environment-b");
const envUnpaired = EnvironmentId.make("environment-unpaired");

const computer = (id: string, label: string, environmentId: EnvironmentId): WorkjetComputer => ({
  id: WorkjetComputerId.make(id),
  label,
  environmentId,
  presentationKind: "local",
  harnesses: [],
});

const route = (id: string, label: string, accountId: string): WorkjetLlmRoute => ({
  id: WorkjetLlmRouteId.make(id),
  label,
  gatewayAccountId: WorkjetGatewayAccountId.make(accountId),
});

const model = (id: string, accountIds: ReadonlyArray<string>): WorkjetGatewayModelSummary => ({
  id,
  displayName: id,
  providers: [],
  accountIds: accountIds.map((accountId) => WorkjetGatewayAccountId.make(accountId)),
});

describe("harness ↔ provider-instance mapping", () => {
  it("round-trips every harness this build ships a runtime for", () => {
    expect(harnessForProviderInstanceId("claudeAgent")).toBe("claude-code");
    expect(harnessForProviderInstanceId("codex")).toBe("codex-cli");
    expect(harnessForProviderInstanceId("opencode")).toBe("opencode");
    expect(harnessForProviderInstanceId("grok")).toBe("grok-cli");
    expect(harnessForProviderInstanceId("cursor")).toBe("cursor-agent");
  });

  it("answers null for an instance no harness maps to", () => {
    expect(harnessForProviderInstanceId("some-custom-instance")).toBeNull();
  });

  it("HIDES a harness this build has no instance for, and marks unconfigured ones", () => {
    const options = composerHarnessOptions(new Set(["claudeAgent"]));
    // pi-code maps to no provider instance — it must not be listed at all.
    expect(options.some((option) => option.id === "pi-code")).toBe(false);
    expect(options.find((option) => option.id === "claude-code")?.configured).toBe(true);
    expect(options.find((option) => option.id === "codex-cli")?.configured).toBe(false);
  });
});

describe("gateway models per route", () => {
  const models = [model("m-openai", ["acc-openai"]), model("m-kimi", ["acc-kimi"])];

  it("narrows the catalog to the selected route's account", () => {
    const scoped = gatewayModelsForRoute(models, route("r1", "OpenAI", "acc-openai"));
    expect(scoped.map((entry) => entry.id)).toEqual(["m-openai"]);
  });

  it("falls back to the whole catalog when the account links to nothing", () => {
    const scoped = gatewayModelsForRoute(models, route("r1", "Other", "acc-unknown"));
    expect(scoped.map((entry) => entry.id)).toEqual(["m-openai", "m-kimi"]);
  });
});

describe("the Computer control", () => {
  const computers = [
    computer("c-a", "MacBook", envA),
    computer("c-b", "gpu3", envB),
    computer("c-x", "island", envUnpaired),
  ];

  it("renders as a real select showing the current computer", () => {
    const markup = renderToStaticMarkup(
      <ComposerComputerControlView
        computers={computers}
        selectedComputerId="c-a"
        activeEnvironmentId={envA}
        selectableEnvironmentIds={[envA, envB]}
        disabledReason={null}
        mismatchNote={null}
        onSelectComputer={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Computer"');
    expect(markup).toContain("MacBook");
    expect(markup).not.toContain('data-disabled=""');
  });

  it("pairs computers by environment — an unpaired one is a stated refusal", () => {
    const selectable = new Set([envA, envB]);
    // The two environments this logical project exists on: selectable.
    expect(isComputerPaired(computers[0]!, envA, selectable)).toBe(true);
    expect(isComputerPaired(computers[1]!, envA, selectable)).toBe(true);
    // The unpaired computer's option is disabled with the hint, never a
    // silent no-op (the popup renders COMPOSER_COMPUTER_NOT_PAIRED_HINT).
    expect(isComputerPaired(computers[2]!, envA, selectable)).toBe(false);
    expect(COMPOSER_COMPUTER_NOT_PAIRED_HINT).toContain("Not paired");
  });

  it("is disabled with the stated reason on a started thread", () => {
    const markup = renderToStaticMarkup(
      <ComposerComputerControlView
        computers={computers}
        selectedComputerId="c-a"
        activeEnvironmentId={envA}
        selectableEnvironmentIds={[envA]}
        disabledReason={COMPOSER_COMPUTER_LOCKED_REASON}
        mismatchNote={null}
        onSelectComputer={() => undefined}
      />,
    );

    expect(markup).toContain(COMPOSER_COMPUTER_LOCKED_REASON);
    expect(markup).toContain("data-disabled");
  });

  it("surfaces a worker's unresolvable computer instead of lying", () => {
    const markup = renderToStaticMarkup(
      <ComposerComputerControlView
        computers={computers}
        selectedComputerId="c-x"
        activeEnvironmentId={envA}
        selectableEnvironmentIds={[envA]}
        disabledReason={null}
        mismatchNote="island is not paired with this project — the thread stays on its current environment."
        onSelectComputer={() => undefined}
      />,
    );

    expect(markup).toContain('data-computer-mismatch="true"');
  });
});

describe("the manual target controls", () => {
  it("keeps the provider icon rail stable while the catalog is empty", () => {
    expect(composerGatewayModelMenuGroups([]).map(([provider]) => provider)).toEqual(
      COMPOSER_GATEWAY_PROVIDER_RAIL,
    );
  });

  it("keeps catalog models in the matching provider pane and locates custom current models", () => {
    const catalogModel = {
      ...model("gpt-5.6-sol", ["acc-openai"]),
      providers: ["codex" as const],
    };
    const groups = composerGatewayModelMenuGroups([catalogModel]);
    expect(groups.find(([provider]) => provider === "codex")?.[1]).toEqual([catalogModel]);
    expect(inferGatewayProviderFromModelId("claude-fable-5")).toBe("claude");
    expect(inferGatewayProviderFromModelId("grok-4.6")).toBe("xai");
  });

  it("renders Harness and Model — no separate provider chip: the model implies the account", () => {
    const markup = renderToStaticMarkup(
      <ComposerManualTargetControlsView
        configuredInstanceIds={new Set(["claudeAgent", "codex"])}
        selectedHarness="claude-code"
        onSelectHarness={() => undefined}
        models={[model("gpt-5.6-sol", ["acc-openai"])]}
        modelsUnavailableReason={null}
        selectedModelId="gpt-5.6-sol"
        onSelectModel={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Harness"');
    expect(markup).not.toContain('aria-label="Provider"');
    expect(markup).toContain('aria-label="Model"');
    expect(markup).toContain("Claude Code");
    expect(markup).toContain("gpt-5.6-sol");
  });

  it("shows the unavailable reason instead of a silent blank model menu", () => {
    const markup = renderToStaticMarkup(
      <ComposerManualTargetControlsView
        configuredInstanceIds={new Set(["claudeAgent"])}
        selectedHarness="claude-code"
        onSelectHarness={() => undefined}
        models={[]}
        modelsUnavailableReason="The Workjet gateway catalog is not available — type a model id."
        selectedModelId=""
        onSelectModel={() => undefined}
      />,
    );

    expect(markup).toContain(">Model<");
  });
});

describe("the compact overflow menu", () => {
  /** Element-tree text walk — menu primitives need a live Menu root to DOM-render. */
  const textOf = (node: unknown): string => {
    if (typeof node === "string" || typeof node === "number") return String(node);
    if (Array.isArray(node)) return node.map(textOf).join("");
    if (node !== null && typeof node === "object" && "props" in node) {
      return textOf((node as { props: { children?: unknown } }).props.children);
    }
    return "";
  };
  const manualTarget = {
    configuredInstanceIds: new Set(["claudeAgent", "codex"]),
    selectedHarness: "claude-code" as const,
    onSelectHarness: () => undefined,
    models: [model("gpt-5.6-sol", ["acc-openai"])],
    modelsUnavailableReason: null,
    selectedModelId: "gpt-5.6-sol",
    onSelectModel: () => undefined,
  };
  const base = {
    workers: [],
    computers: [],
    selectedComputerId: null,
    activeEnvironmentId: envA,
    selectableEnvironmentIds: [envA],
    computerDisabledReason: null,
    onSelectComputer: () => undefined,
    onSelectWorker: () => undefined,
  };

  it("offers Harness and Model in Manual mode — compact must not lose the new bar (K-A2)", () => {
    const text = textOf(
      ComposerWorkjetCompactMenuContent({
        ...base,
        selectedWorkerId: null,
        manualTarget,
      }),
    );
    expect(text).toContain("Harness");
    expect(text).toContain("Claude Code");
    expect(text).toContain("Model");
    expect(text).toContain("gpt-5.6-sol");
  });

  it("hides Harness and Model while a worker is selected — the worker bundles both", () => {
    const text = textOf(
      ComposerWorkjetCompactMenuContent({
        ...base,
        selectedWorkerId: "worker-1",
        manualTarget,
      }),
    );
    expect(text).not.toContain("Harness");
  });
});

describe("the custom system prompt affordance", () => {
  it("renders as a labelled control", () => {
    const markup = renderToStaticMarkup(
      <ComposerSystemPromptControlView
        value=""
        busy={false}
        disabled={false}
        draftPending
        onApply={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="System prompt"');
  });
});

describe("executeWorkjetCapabilitySet with the whole next config", () => {
  const currentConfig: WorkjetThreadConfig = {
    schemaVersion: 1,
    role: "standard",
    parent: null,
    managedInstructions: "",
    enabledCapabilityIds: [],
  };

  it("dispatches capabilities AND managed instructions in one config change", async () => {
    const dispatch = vi.fn(async (nextConfig: WorkjetThreadConfig) => {
      expect(nextConfig.enabledCapabilityIds).toEqual(["greppy"]);
      expect(nextConfig.managedInstructions).toBe("You are the UI/UX reviewer.");
      return { _tag: "Success", value: undefined } as never;
    });

    const retained = await executeWorkjetCapabilitySet({
      currentConfig,
      capabilityIds: ["greppy"] as never,
      managedInstructions: "You are the UI/UX reviewer.",
      dispatch,
      setVisibleConfig: () => undefined,
      notifyFailure: () => undefined,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(retained.managedInstructions).toBe("You are the UI/UX reviewer.");
    expect(retained.enabledCapabilityIds).toEqual(["greppy"]);
  });

  it("changes only the managed instructions when no capability list is given", async () => {
    const dispatch = vi.fn(async (nextConfig: WorkjetThreadConfig) => {
      expect(nextConfig.enabledCapabilityIds).toEqual([]);
      expect(nextConfig.managedInstructions).toBe("custom prompt");
      return { _tag: "Success", value: undefined } as never;
    });

    await executeWorkjetCapabilitySet({
      currentConfig,
      managedInstructions: "custom prompt",
      dispatch,
      setVisibleConfig: () => undefined,
      notifyFailure: () => undefined,
    });

    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("skips the dispatch entirely when nothing changes", async () => {
    const dispatch = vi.fn();

    const retained = await executeWorkjetCapabilitySet({
      currentConfig,
      capabilityIds: [] as never,
      managedInstructions: "",
      dispatch: dispatch as never,
      setVisibleConfig: () => undefined,
      notifyFailure: () => undefined,
    });

    expect(dispatch).not.toHaveBeenCalled();
    expect(retained).toBe(currentConfig);
  });
});
