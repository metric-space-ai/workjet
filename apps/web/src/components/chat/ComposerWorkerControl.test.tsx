import { isValidElement, type ReactNode, type ReactElement } from "react";
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
  WorkerChoiceList,
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

type ButtonProps = {
  children?: ReactNode;
  onClick?: () => void;
  "aria-label"?: string;
  "aria-pressed"?: boolean;
  disabled?: boolean;
};

function buttons(node: ReactNode): Array<ReactElement<ButtonProps>> {
  if (Array.isArray(node)) return node.flatMap(buttons);
  if (!isValidElement<ButtonProps>(node)) return [];
  return [...(node.type === "button" ? [node] : []), ...buttons(node.props.children)];
}

function list(overrides: Partial<Parameters<typeof WorkerChoiceList>[0]> = {}) {
  return WorkerChoiceList({
    workers: [worker()],
    selectedWorkerId: null,
    onSelectWorker: vi.fn(),
    onEditWorker: vi.fn(),
    ...overrides,
  });
}

describe("the bar's leftmost decision", () => {
  it("reads Manual until a worker is chosen", () => {
    expect(render()).toContain("Manual");
  });

  it("names the chosen worker instead", () => {
    expect(render({ selectedWorkerId: "worker-sol" })).toContain("Sol · Completion");
  });

  it("keeps a long worker label inside the bounded composer trigger", () => {
    const markup = render({
      workers: [worker({ name: `Worker ${"x".repeat(180)}` })],
      selectedWorkerId: "worker-sol",
    });
    expect(markup).toContain("max-w-52");
    expect(markup).toContain("min-w-0");
  });

  it("shows the harness, model and effort before choosing", () => {
    const markup = renderToStaticMarkup(list());
    expect(markup).toContain("Claude Code");
    expect(markup).toContain("gpt-5.6-sol");
    expect(markup).toContain("High");
  });

  it("offers setup when no workers are saved", () => {
    const markup = renderToStaticMarkup(list({ workers: [] }));
    expect(markup).toContain("No saved workers");
    expect(markup).toContain("Add worker");
  });

  it("disables selection and editing together when unavailable", () => {
    expect(buttons(list({ disabled: true })).every((button) => button.props.disabled)).toBe(true);
  });
});

describe("selection and editing are separate actions", () => {
  it("reports Manual as null", () => {
    const onSelectWorker = vi.fn();
    const onEditWorker = vi.fn();
    const choices = buttons(list({ selectedWorkerId: "worker-sol", onSelectWorker, onEditWorker }));
    choices[0]!.props.onClick!();
    expect(onSelectWorker).toHaveBeenCalledWith(null);
    expect(onEditWorker).not.toHaveBeenCalled();
  });

  it("chooses the stable worker ID", () => {
    const onSelectWorker = vi.fn();
    const onEditWorker = vi.fn();
    buttons(list({ onSelectWorker, onEditWorker }))[1]!.props.onClick!();
    expect(onSelectWorker).toHaveBeenCalledWith("worker-sol");
    expect(onEditWorker).not.toHaveBeenCalled();
  });

  it("opens a worker editor without changing the active worker", () => {
    const onSelectWorker = vi.fn();
    const onEditWorker = vi.fn();
    const edit = buttons(list({ onSelectWorker, onEditWorker })).find(
      (button) => button.props["aria-label"] === "Edit Sol · Completion",
    );
    edit!.props.onClick!();
    expect(onEditWorker).toHaveBeenCalledWith("worker-sol");
    expect(onSelectWorker).not.toHaveBeenCalled();
  });

  it("starts a new profile draft without selecting or dispatching work", () => {
    const onSelectWorker = vi.fn();
    const onEditWorker = vi.fn();
    buttons(list({ workers: [], onSelectWorker, onEditWorker })).at(-1)!.props.onClick!();
    expect(onEditWorker).toHaveBeenCalledWith(null);
    expect(onSelectWorker).not.toHaveBeenCalled();
  });
});

describe("a worker's harness decides which runtime the turn uses", () => {
  it("maps every supported harness to its instance", () => {
    expect(providerInstanceIdForHarness("claude-code")).toBe("claudeAgent");
    expect(providerInstanceIdForHarness("codex-cli")).toBe("codex");
    expect(providerInstanceIdForHarness("opencode")).toBe("opencode");
    expect(providerInstanceIdForHarness("grok-cli")).toBe("grok");
    expect(providerInstanceIdForHarness("cursor-agent")).toBe("cursor");
  });

  it("refuses to guess for a harness with no runtime here", () => {
    expect(providerInstanceIdForHarness("pi-code")).toBeNull();
  });
});
