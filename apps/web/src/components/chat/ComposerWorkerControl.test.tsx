import { renderToStaticMarkup } from "react-dom/server";
import {
  WorkjetComputerId,
  WorkjetLlmRouteId,
  WorkjetWorkerProfileId,
  type WorkjetWorkerProfile,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  ComposerWorkerControlView,
  MANUAL_WORKER_VALUE,
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
    capabilityIds: [],
    ...overrides,
  } as WorkjetWorkerProfile;
}

function element(props: Partial<ComposerWorkerControlProps> = {}) {
  return ComposerWorkerControlView({
    workers: [worker()],
    selectedWorkerId: null,
    onSelectWorker: vi.fn(),
    onOpenWorkjetSettings: vi.fn(),
    ...props,
  });
}

function render(props: Partial<ComposerWorkerControlProps> = {}): string {
  return renderToStaticMarkup(element(props) as never);
}

/**
 * Every string in the element tree. The popup's items are not in the static
 * markup — a closed Select renders no panel — so the menu's contents can only
 * be asserted on the tree.
 */
function menuText(props: Partial<ComposerWorkerControlProps> = {}): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object" && "props" in node) {
      walk((node as { props: { children?: unknown } }).props.children);
    }
  };
  walk(element(props));
  return parts.join(" | ");
}

describe("the bar's leftmost decision", () => {
  it("reads Manual until a worker is chosen", () => {
    // Manual is a real choice, not an empty state: it is what the bar has
    // always done, and it stays for the one-off turn no worker matches.
    expect(render()).toContain("Manual");
  });

  it("names the chosen worker instead", () => {
    const markup = render({ selectedWorkerId: "worker-sol" });

    expect(markup).toContain("Sol · Completion");
  });

  it("shows what each worker settles, so picking is not blind", () => {
    // One choice settles harness, model and effort; the menu says which.
    const text = menuText();

    expect(text).toContain("claude-code");
    expect(text).toContain("gpt-5.6-sol");
    expect(text).toContain("high");
  });

  it("points somewhere when nothing is saved yet", () => {
    // Otherwise the control is a dropdown with one entry and no way forward —
    // which is exactly the dead end an empty LLM-route select already was.
    expect(menuText({ workers: [] })).toContain("No saved workers");
  });
});

describe("selection", () => {
  it("reports manual as null rather than a sentinel the caller must know", () => {
    const onSelectWorker = vi.fn();
    const element = ComposerWorkerControlView({
      workers: [worker()],
      selectedWorkerId: "worker-sol",
      onSelectWorker,
      onOpenWorkjetSettings: vi.fn(),
    }) as unknown as {
      props: { children: ReadonlyArray<{ props: { onValueChange: (v: string) => void } }> };
    };
    const select = element.props.children[0]!;

    select.props.onValueChange(MANUAL_WORKER_VALUE);

    expect(onSelectWorker).toHaveBeenCalledWith(null);
  });

  it("opens settings instead of selecting the placeholder row", () => {
    const onSelectWorker = vi.fn();
    const onOpenWorkjetSettings = vi.fn();
    const element = ComposerWorkerControlView({
      workers: [],
      selectedWorkerId: null,
      onSelectWorker,
      onOpenWorkjetSettings,
    }) as unknown as {
      props: { children: ReadonlyArray<{ props: { onValueChange: (v: string) => void } }> };
    };

    element.props.children[0]!.props.onValueChange("__configure__");

    expect(onOpenWorkjetSettings).toHaveBeenCalledTimes(1);
    expect(onSelectWorker).not.toHaveBeenCalled();
  });
});
