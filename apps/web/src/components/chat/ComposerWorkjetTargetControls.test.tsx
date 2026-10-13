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
} from "@workjet/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  COMPOSER_COMPUTER_LOCKED_REASON,
  COMPOSER_COMPUTER_PROJECT_UNAVAILABLE_HINT,
  ComposerComputerControlView,
  ComposerComputerMenuItems,
  ComposerHarnessMenuItems,
  ComposerManualTargetControlsView,
  ComposerModelMenuItems,
  ComposerSystemPromptRow,
  composerComputerChoices,
  ComposerWorkjetCompactMenuContent,
  ComposerSystemPromptControlView,
  COMPOSER_GATEWAY_PROVIDER_RAIL,
  composerGatewayModelMenuGroups,
  composerHarnessOptions,
  gatewayModelsForRoute,
  harnessForProviderInstanceId,
  inferGatewayProviderFromModelId,
  isProjectAvailableOnComputer,
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

type AnyProps = Readonly<Record<string, unknown>> & { readonly children?: ReactNode };

/** Walks a hook-free element tree; menu primitives need a live Menu root to DOM-render. */
function flatten(node: ReactNode): Array<ReactElement<AnyProps>> {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!isValidElement<AnyProps>(node)) return [];
  return [node, ...flatten(node.props.children)];
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (isValidElement<AnyProps>(node)) return textOf(node.props.children);
  return "";
}

function radioItem(node: ReactNode, value: string): ReactElement<AnyProps> {
  const found = flatten(node).find(
    (element) => element.props.value === value && element.props.closeOnClick === true,
  );
  if (!found) throw new Error(`Missing menu entry: ${value}`);
  return found;
}

function radioGroup(node: ReactNode): ReactElement<AnyProps> {
  const found = flatten(node).find((element) => typeof element.props.onValueChange === "function");
  if (!found) throw new Error("Missing radio group");
  return found;
}

describe("computer dropdown entries", () => {
  const base = {
    computers: [computer("local", "Local", envA), computer("remote", "Remote", envB)],
    selectedComputerId: "local",
    activeEnvironmentId: envA,
    selectableEnvironmentIds: [envA],
    disabledReason: null,
    mismatchNote: null,
  };

  it("lists registered network computers and short connection or checkout states", () => {
    const tree = ComposerComputerMenuItems({
      ...base,
      onSelectComputer: () => undefined,
      computerAvailability: {
        local: { status: "Online", reason: null },
        remote: { status: "Offline", reason: "gpu3 is offline." },
      },
      registeredComputers: [
        {
          id: "native-gpu1",
          displayName: "gpu1-a6000",
          hostingMode: "self_hosted",
          status: "assigned",
          capabilities: [],
          selfHostedColocation: false,
        },
      ],
    });
    const text = textOf(tree);
    // German connection words, never online/offline.
    expect(text).toContain("verbunden");
    expect(text).toContain("getrennt");
    expect(text).not.toContain("online");
    expect(text).not.toContain("offline");
    expect(text).toContain("gpu1-a6000");
    // The full reason stays reachable as the entry's tooltip, never as a sentence.
    expect(radioItem(tree, "remote").props.title).toBe("gpu3 is offline.");
    expect(radioItem(tree, "remote").props.disabled).toBe(true);
  });

  it("keeps a save in progress visible and blocks switching", () => {
    const markup = renderToStaticMarkup(
      <ComposerComputerControlView
        {...base}
        editor={{ state: { saving: true, drafts: {} }, update: () => undefined }}
        onSelectComputer={() => undefined}
      />,
    );
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("Speichert");
    expect(markup).toContain("disabled");
  });

  it("refuses an unavailable target without moving the draft", () => {
    const select = vi.fn();
    const tree = ComposerComputerMenuItems({ ...base, onSelectComputer: select });
    expect(radioItem(tree, "remote").props.disabled).toBe(true);
    (radioGroup(tree).props.onValueChange as (value: string) => void)("remote");
    expect(select).not.toHaveBeenCalled();
    expect(textOf(tree)).toContain("Projekt fehlt");
  });

  it("prevents selection of every target during a started session", () => {
    const select = vi.fn();
    const tree = ComposerComputerMenuItems({
      ...base,
      selectableEnvironmentIds: [envA, envB],
      disabledReason: COMPOSER_COMPUTER_LOCKED_REASON,
      onSelectComputer: select,
    });
    for (const id of ["local", "remote"]) {
      expect(radioItem(tree, id).props.disabled).toBe(true);
      (radioGroup(tree).props.onValueChange as (value: string) => void)(id);
    }
    expect(select).not.toHaveBeenCalled();
    // The reason is the entries' tooltip, never a status sentence in the menu.
    expect(textOf(tree)).not.toContain(COMPOSER_COMPUTER_LOCKED_REASON);
    expect(radioItem(tree, "local").props.title).toBe(COMPOSER_COMPUTER_LOCKED_REASON);
  });

  it("moves an available draft through the explicit selection", () => {
    const select = vi.fn();
    const tree = ComposerComputerMenuItems({
      ...base,
      selectableEnvironmentIds: [envA, envB],
      onSelectComputer: select,
    });
    expect(radioGroup(tree).props.value).toBe("local");
    (radioGroup(tree).props.onValueChange as (value: string) => void)("remote");
    expect(select).toHaveBeenCalledExactlyOnceWith("remote");
  });

  it("opens Settings → Rechner instead of an in-place computer editor", () => {
    const onAddComputer = vi.fn();
    const tree = ComposerComputerMenuItems({
      ...base,
      onSelectComputer: () => undefined,
      onAddComputer,
    });
    expect(textOf(tree)).toContain("Rechner hinzufügen");
    const manage = flatten(tree).find((element) => element.props.onClick === onAddComputer);
    (manage!.props.onClick as () => void)();
    expect(onAddComputer).toHaveBeenCalledOnce();
  });

  it("derives a short status for every computer", () => {
    const choices = composerComputerChoices({
      ...base,
      computerAvailability: { local: { status: "Not connected", reason: "Not connected" } },
    });
    expect(choices.map((choice) => choice.meta)).toEqual(["getrennt", "Projekt fehlt"]);
  });
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
    expect(harnessForProviderInstanceId("pi", "pi")).toBe("pi-code");
  });

  it("maps named profiles by their actual driver and marks that family configured", () => {
    expect(harnessForProviderInstanceId("greppy-fixture", "greppy")).toBe("greppy");
    expect(harnessForProviderInstanceId("codex", "greppy")).toBe("greppy");
    const options = composerHarnessOptions(new Set(["greppy-fixture"]), new Set(["greppy"]));
    expect(options.find((option) => option.id === "greppy")?.configured).toBe(true);
    expect(options.find((option) => option.id === "codex-cli")?.configured).toBe(false);
  });

  it("answers null for an instance no harness maps to", () => {
    expect(harnessForProviderInstanceId("some-custom-instance")).toBeNull();
  });

  it("HIDES a harness this build has no instance for, and marks unconfigured ones", () => {
    const options = composerHarnessOptions(new Set(["claudeAgent"]));
    expect(options.find((option) => option.id === "pi-code")?.configured).toBe(false);
    expect(options.find((option) => option.id === "claude-code")?.configured).toBe(true);
    expect(options.find((option) => option.id === "codex-cli")?.configured).toBe(false);
  });
});

describe("gateway models per route", () => {
  const models = [model("m-openai", ["acc-openai"]), model("m-kimi", ["acc-kimi"])];

  it("does not substitute source gateway models for a native-only account", () => {
    expect(
      gatewayModelsForRoute(models, {
        id: WorkjetLlmRouteId.make("native-only"),
        label: "Native Claude",
        nativeAccountReference: {
          accountId: "196a89ba-ee86-4413-885c-04ca60e6f291",
          holderInstanceId: "322084e5-8239-48d7-b3c5-c5178fbe5822",
          accountRevision: 3,
        },
      }),
    ).toEqual([]);
  });

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

  it("renders as a plain dropdown showing the current computer", () => {
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

    expect(markup).toContain('aria-label="Rechner"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain("MacBook");
    expect(markup).not.toContain('data-disabled=""');
  });

  it("keeps a long computer label inside the bounded composer trigger", () => {
    const markup = renderToStaticMarkup(
      <ComposerComputerControlView
        computers={[computer("c-long", `Computer ${"x".repeat(180)}`, envA)]}
        selectedComputerId="c-long"
        activeEnvironmentId={envA}
        selectableEnvironmentIds={[envA]}
        disabledReason={null}
        mismatchNote={null}
        onSelectComputer={() => undefined}
      />,
    );

    expect(markup).toContain("max-w-48");
    expect(markup).toContain("min-w-0");
    expect(markup).toContain("truncate");
    expect(markup).toContain(`Computer ${"x".repeat(180)}`);
  });

  it("separates project availability from device pairing", () => {
    const selectable = new Set([envA, envB]);
    // The two environments this logical project exists on: selectable.
    expect(isProjectAvailableOnComputer(computers[0]!, envA, selectable)).toBe(true);
    expect(isProjectAvailableOnComputer(computers[1]!, envA, selectable)).toBe(true);
    // A computer without the project is disabled with the hint, never a
    // silent no-op (the popup renders the project-availability hint).
    expect(isProjectAvailableOnComputer(computers[2]!, envA, selectable)).toBe(false);
    expect(COMPOSER_COMPUTER_PROJECT_UNAVAILABLE_HINT).toBe("Projekt fehlt auf diesem Rechner");
  });

  it("keeps the dropdown reachable with the stated selection lock on a started thread", () => {
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
    expect(markup).toContain('aria-label="Rechner"');
    expect(markup).not.toContain("data-disabled");
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
        models={[{ ...model("gpt-5.6-sol", ["acc-openai"]), displayName: "GPT 5.6 Sol" }]}
        modelsUnavailableReason={null}
        selectedModelId="gpt-5.6-sol"
        onSelectModel={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Harness"');
    expect(markup).not.toContain('aria-label="Provider"');
    expect(markup).toContain('aria-label="Modell"');
    expect(markup).toContain("Claude Code");
    expect(markup).toContain("GPT 5.6 Sol");
    // Plain dropdowns: no explanatory tooltip sentence, no popover form.
    expect(markup).not.toContain("the agent runtime");
    expect(markup.match(/aria-haspopup="menu"/g)?.length).toBe(2);
  });

  it("displays a native-managed route with disabled Harness and Model controls", () => {
    const reason = "This route is managed by the project's instance.";
    const markup = renderToStaticMarkup(
      <ComposerManualTargetControlsView
        disabledReason={reason}
        configuredInstanceIds={new Set(["codex"])}
        selectedHarness="codex-cli"
        onSelectHarness={vi.fn()}
        models={[]}
        modelsUnavailableReason={null}
        selectedModelId="gpt-6.1-sol"
        onSelectModel={vi.fn()}
      />,
    );
    expect(markup).toMatch(/<button[^>]*aria-label="Harness"[^>]*(?:disabled|data-disabled)/);
    expect(markup).toMatch(/<button[^>]*aria-label="Modell"[^>]*disabled/);
    expect(markup).toContain("gpt-6.1-sol");
    expect(markup).toContain("This route is managed");
  });

  it("presents the native MiniMax catalog without claiming gateway service", () => {
    const markup = renderToStaticMarkup(
      <ComposerManualTargetControlsView
        configuredInstanceIds={new Set(["minimax"])}
        selectedHarness="minimax-code"
        onSelectHarness={() => undefined}
        modelSource="native"
        models={[
          {
            id: "MiniMax-M3.1-Flash-Preview",
            displayName: "MiniMax-M3.1-Flash-Preview",
            providers: ["minimax"],
            accountIds: [],
          },
        ]}
        modelsUnavailableReason={null}
        selectedModelId="MiniMax-M3.1-Flash-Preview"
        onSelectModel={() => undefined}
      />,
    );
    expect(markup).toContain("MiniMax Code");
    expect(markup).toContain("MiniMax-M3.1-Flash-Preview");
    expect(markup).not.toContain("Served by the Workjet gateway");
  });
  it("does not present an unadvertised native model as an available current choice", () => {
    const markup = renderToStaticMarkup(
      <ComposerManualTargetControlsView
        configuredInstanceIds={new Set(["minimax"])}
        selectedHarness="minimax-code"
        onSelectHarness={() => undefined}
        modelSource="native"
        models={[]}
        modelsUnavailableReason="Run mcode login"
        selectedModelId="foreign-model"
        onSelectModel={() => undefined}
      />,
    );
    expect(markup).toContain(">Modell<");
    expect(markup).not.toContain(">foreign-model<");
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

    expect(markup).toContain(">Modell<");
  });

  it("keeps a long model id inside the bounded composer trigger", () => {
    const markup = renderToStaticMarkup(
      <ComposerManualTargetControlsView
        configuredInstanceIds={new Set(["claudeAgent"])}
        selectedHarness="claude-code"
        onSelectHarness={() => undefined}
        models={[]}
        modelsUnavailableReason={null}
        selectedModelId={`model-${"x".repeat(180)}`}
        onSelectModel={() => undefined}
      />,
    );

    expect(markup).toContain("max-w-56");
    expect(markup).toContain("min-w-0");
  });
});

describe("harness and model dropdown entries", () => {
  it("lists harnesses with a short status and reports the choice", () => {
    const onSelectHarness = vi.fn();
    const tree = ComposerHarnessMenuItems({
      configuredInstanceIds: new Set(["claudeAgent"]),
      selectedHarness: "claude-code",
      onSelectHarness,
    });
    expect(textOf(tree)).toContain("Claude Code");
    expect(textOf(tree)).toContain("nicht eingerichtet");
    expect(radioItem(tree, "codex-cli").props.disabled).toBe(true);
    (radioGroup(tree).props.onValueChange as (value: string) => void)("claude-code");
    expect(onSelectHarness).toHaveBeenCalledWith("claude-code");
  });

  it("groups catalog models by provider and offers no typed model ID", () => {
    const onSelectModel = vi.fn();
    const tree = ComposerModelMenuItems({
      models: [
        { ...model("gpt-5.6-sol", ["acc-openai"]), providers: ["codex"], displayName: "GPT Sol" },
      ],
      modelsUnavailableReason: null,
      selectedModelId: "my-private-model",
      onSelectModel,
    });
    const text = textOf(tree);
    expect(text).toContain("Codex (OpenAI)");
    expect(text).toContain("GPT Sol");
    expect(text).not.toContain("my-private-model");
    expect(text).not.toContain("eigene ID");
    expect(text).not.toContain("Eigene Modell-ID");
    // No raw model ID as a tooltip either.
    expect(radioItem(tree, "gpt-5.6-sol").props.title).toBeUndefined();
    (radioGroup(tree).props.onValueChange as (value: string) => void)("gpt-5.6-sol");
    expect(onSelectModel).toHaveBeenCalledWith("gpt-5.6-sol");
  });

  it("shows an empty catalog as one simple disabled entry, the reason only as tooltip", () => {
    const tree = ComposerModelMenuItems({
      modelSource: "native",
      models: [],
      modelsUnavailableReason: "Run mcode login",
      selectedModelId: "foreign-model",
      onSelectModel: () => undefined,
    });
    const text = textOf(tree);
    expect(text).toContain("Keine Modelle");
    expect(text).not.toContain("Run mcode login");
    expect(text).not.toContain("foreign-model");
    // The empty entry carries the reason for its tooltip (a disabled MenuItem).
    const empty = flatten(tree).find((element) => element.props.reason === "Run mcode login");
    expect(empty).toBeDefined();
  });

  it("has no inline model-ID input and no raw ID on the model trigger", () => {
    const markup = renderToStaticMarkup(
      <ComposerManualTargetControlsView
        configuredInstanceIds={new Set(["claudeAgent"])}
        selectedHarness="claude-code"
        onSelectHarness={() => undefined}
        models={[{ ...model("gpt-5.6-sol", []), displayName: "GPT Sol" }]}
        modelsUnavailableReason={null}
        selectedModelId="gpt-5.6-sol"
        onSelectModel={() => undefined}
      />,
    );
    expect(markup).not.toContain("data-composer-custom-model-inline");
    expect(markup).not.toContain('aria-label="Modell-ID"');
    expect(markup).not.toContain('title="gpt-5.6-sol"');
    expect(markup).toContain("GPT Sol");
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

  it("offers a named Greppy profile in the compact harness choices", () => {
    const text = textOf(
      ComposerWorkjetCompactMenuContent({
        ...base,
        selectedWorkerId: null,
        manualTarget: {
          ...manualTarget,
          configuredInstanceIds: new Set(["greppy-fixture"]),
          configuredDriverKinds: new Set(["greppy"]),
          selectedHarness: "greppy",
        },
      }),
    );
    expect(text).toContain("Greppy");
    const greppy = flatten(
      ComposerWorkjetCompactMenuContent({
        ...base,
        selectedWorkerId: null,
        manualTarget: {
          ...manualTarget,
          configuredInstanceIds: new Set(["greppy-fixture"]),
          configuredDriverKinds: new Set(["greppy"]),
          selectedHarness: "greppy",
        },
      }),
    ).find((element) => element.props.value === "greppy" && element.props.closeOnClick === true);
    expect(greppy?.props.disabled).toBe(false);
  });

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
    expect(text).toContain("Modell");
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
  it("renders as a labelled control outside the options menu", () => {
    const markup = renderToStaticMarkup(
      <ComposerSystemPromptControlView
        value=""
        busy={false}
        disabled={false}
        draftPending
        onApply={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Systemprompt"');
    expect(markup).not.toContain("aria-haspopup");
  });

  it("is an inline row with cancel and apply, not a popover", () => {
    const markup = renderToStaticMarkup(
      <ComposerSystemPromptRow
        value="Bisher"
        busy={false}
        disabled={false}
        draftPending={false}
        onApply={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(markup).toContain('data-composer-inline-row="system-prompt"');
    expect(markup).toContain("Abbrechen");
    expect(markup).toContain("Übernehmen");
    expect(markup).toContain("Bisher");
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
