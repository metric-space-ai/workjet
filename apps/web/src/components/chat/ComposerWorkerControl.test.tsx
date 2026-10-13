import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WorkjetComputerId,
  WorkjetLlmRouteId,
  WorkjetWorkerProfileId,
  type WorkjetWorkerProfile,
} from "@workjet/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ComposerWorkerControlView,
  ComposerWorkerMenuItems,
  MANUAL_WORKER_VALUE,
  providerInstanceIdForHarness,
  type ComposerWorkerControlProps,
} from "./ComposerWorkerControl";

function worker(overrides: Partial<WorkjetWorkerProfile> = {}): WorkjetWorkerProfile {
  return {
    id: WorkjetWorkerProfileId.make("worker-sol"),
    name: "Sol · Completion",
    computerId: WorkjetComputerId.make("computer-local"),
    harness: "claude-code",
    llmRouteId: WorkjetLlmRouteId.make("route-openai"),
    modelId: "gpt-5.6-sol",
    reasoning: "high",
    role: "standard",
    capabilityIds: [],
    capabilityBindings: [],
    ...overrides,
  };
}

function render(props: Partial<ComposerWorkerControlProps> = {}): string {
  return renderToStaticMarkup(
    <ComposerWorkerControlView
      workers={[worker()]}
      selectedWorkerId={null}
      onSelectWorker={vi.fn()}
      onOpenWorkjetSettings={vi.fn()}
      {...props}
    />,
  );
}

type AnyProps = Readonly<Record<string, unknown>> & { readonly children?: ReactNode };

/** Expands function components (hook-free) so the menu entries can be inspected. */
function flatten(node: ReactNode): Array<ReactElement<AnyProps>> {
  if (Array.isArray(node)) return node.flatMap(flatten);
  if (!isValidElement<AnyProps>(node)) return [];
  return [node, ...flatten(node.props.children)];
}

function textContent(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textContent).join(" ");
  if (isValidElement<AnyProps>(node)) return textContent(node.props.children);
  return "";
}

function items(overrides: Partial<Parameters<typeof ComposerWorkerMenuItems>[0]> = {}) {
  return ComposerWorkerMenuItems({
    workers: [worker()],
    selectedWorkerId: null,
    onSelectWorker: vi.fn(),
    onOpenWorkjetSettings: vi.fn(),
    ...overrides,
  });
}

describe("the bar's leftmost decision", () => {
  it("reads Manuell until a Luma is chosen", () => {
    expect(render()).toContain("Ohne Preset");
    expect(render()).toContain('aria-label="Worker-Preset"');
  });

  it("names the chosen Luma instead", () => {
    expect(render({ selectedWorkerId: "worker-sol" })).toContain("Sol · Completion");
  });

  it("keeps a long Luma label inside the bounded composer trigger", () => {
    const markup = render({
      workers: [worker({ name: `Luma ${"x".repeat(180)}` })],
      selectedWorkerId: "worker-sol",
    });
    expect(markup).toContain("max-w-52");
    expect(markup).toContain("min-w-0");
  });

  it("is a plain dropdown, never a popover with forms or explanations", () => {
    const markup = render();
    expect(markup).not.toContain("Back to Lumas");
    expect(markup).not.toContain("Choose harness, model");
    expect(markup).toContain('aria-haspopup="menu"');
  });

  it("shows only the harness next to each Luma, never a raw model ID", () => {
    const text = textContent(items());
    expect(text).toContain("Claude Code");
    expect(text).not.toContain("gpt-5.6-sol");
    expect(text).toContain("Worker-Presets verwalten");
  });

  it("disables every choice together when unavailable", () => {
    const radios = flatten(items({ disabled: true })).filter(
      (element) => element.props.value !== undefined && element.props.closeOnClick === true,
    );
    expect(radios.length).toBe(2);
    expect(radios.every((radio) => radio.props.disabled === true)).toBe(true);
  });
});

describe("selection", () => {
  const group = (onSelectWorker: (id: string | null) => void, selectedWorkerId: string | null) =>
    flatten(items({ onSelectWorker, selectedWorkerId })).find(
      (element) => typeof element.props.onValueChange === "function",
    )!;

  it("reports Manuell as null", () => {
    const onSelectWorker = vi.fn();
    const radioGroup = group(onSelectWorker, "worker-sol");
    expect(radioGroup.props.value).toBe("worker-sol");
    (radioGroup.props.onValueChange as (value: string) => void)(MANUAL_WORKER_VALUE);
    expect(onSelectWorker).toHaveBeenCalledWith(null);
  });

  it("chooses the stable Luma ID", () => {
    const onSelectWorker = vi.fn();
    const radioGroup = group(onSelectWorker, null);
    expect(radioGroup.props.value).toBe(MANUAL_WORKER_VALUE);
    (radioGroup.props.onValueChange as (value: string) => void)("worker-sol");
    expect(onSelectWorker).toHaveBeenCalledWith("worker-sol");
  });

  it("opens Settings → Lumas instead of an in-place editor", () => {
    const onOpenWorkjetSettings = vi.fn();
    const onSelectWorker = vi.fn();
    const manage = flatten(items({ onOpenWorkjetSettings, onSelectWorker })).find(
      (element) => element.props.onClick === onOpenWorkjetSettings,
    );
    expect(manage).toBeDefined();
    (manage!.props.onClick as () => void)();
    expect(onOpenWorkjetSettings).toHaveBeenCalledOnce();
    expect(onSelectWorker).not.toHaveBeenCalled();
  });
});

describe("a Luma's harness decides which runtime the turn uses", () => {
  it("maps every supported harness to its instance", () => {
    expect(providerInstanceIdForHarness("claude-code")).toBe("claudeAgent");
    expect(providerInstanceIdForHarness("codex-cli")).toBe("codex");
    expect(providerInstanceIdForHarness("opencode")).toBe("opencode");
    expect(providerInstanceIdForHarness("grok-cli")).toBe("grok");
    expect(providerInstanceIdForHarness("cursor-agent")).toBe("cursor");
    expect(providerInstanceIdForHarness("pi-code")).toBe("pi");
  });
});
