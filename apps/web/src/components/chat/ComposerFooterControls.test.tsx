import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerFooterControls, type ComposerFooterControlsProps } from "./ComposerFooterControls";

const baseProps: ComposerFooterControlsProps = {
  workerMode: false,
  traitsPicker: null,
  showInteractionModeToggle: true,
  interactionMode: "default",
  workjetRole: "standard",
  workjetGreppyEnabled: false,
  workjetBusy: false,
  workjetDisabled: false,
  sendToWorkerControl: null,
  onToggleInteractionMode: () => undefined,
  onWorkjetRoleChange: () => undefined,
  onWorkjetGreppyEnabledChange: () => undefined,
  onOpenWorkjetSettings: () => undefined,
};

function render(props: Partial<ComposerFooterControlsProps> = {}): string {
  return renderToStaticMarkup(<ComposerFooterControls {...baseProps} {...props} />);
}

describe("ComposerFooterControls", () => {
  /**
   * docs/workjet-plan.md → Wave 5 requires the `Code | Orchestrator` control
   * to be ADDED WITHOUT REPLACING the provider-specific Plan/Build control.
   * This is that constraint as an assertion.
   */
  it("renders the Workjet role control BESIDE the provider Plan/Build control", () => {
    const markup = render();

    // The provider-specific Plan/Build toggle, untouched.
    expect(markup).toContain('aria-label="Default mode — click to enter plan mode"');
    expect(markup).toContain(">Build<");
    // …and the access control it ships with.
    // Permission is ALWAYS full (operator rule): the picker is gone.
    expect(markup).not.toContain('aria-label="Runtime mode"');

    // The new Workjet role control, alongside it.
    expect(markup).toContain('aria-label="Workjet thread role"');
    expect(markup).toContain('data-workjet-role="standard"');
    expect(markup).toContain('data-workjet-role="orchestrator"');
    expect(markup).toContain('data-workjet-settings-gear="true"');
  });

  it("keeps both controls when the provider thread is in plan mode", () => {
    const markup = render({ interactionMode: "plan" });

    expect(markup).toContain('aria-label="Plan mode — click to return to normal build mode"');
    expect(markup).toContain(">Plan<");
    expect(markup).toContain('aria-label="Workjet thread role"');
  });

  it("keeps the role control for a provider that has no Plan/Build toggle", () => {
    const markup = render({ showInteractionModeToggle: false });

    expect(markup).not.toContain(">Build<");
    // Permission is ALWAYS full (operator rule): the picker is gone.
    expect(markup).not.toContain('aria-label="Runtime mode"');
    expect(markup).toContain('aria-label="Workjet thread role"');
  });

  it("shows the read-only worker state without dropping Plan/Build", () => {
    const markup = render({ workjetRole: "worker" });

    expect(markup).toContain(">Build<");
    expect(markup).toContain('data-workjet-role="worker"');
    expect(markup).toContain('data-workjet-role-readonly="true"');
    expect(markup).not.toContain('data-workjet-role="orchestrator"');
  });

  it("omits the Workjet controls on a thread with no server configuration", () => {
    const markup = render({ workjetRole: null, workjetGreppyEnabled: null });

    expect(markup).not.toContain('aria-label="Workjet thread role"');
    expect(markup).not.toContain('data-workjet-settings-gear="true"');
    expect(markup).not.toContain('aria-label="Thread tools"');
    // The provider controls are unaffected by the absence of Workjet state.
    expect(markup).toContain(">Build<");
    // Permission is ALWAYS full (operator rule): the picker is gone.
    expect(markup).not.toContain('aria-label="Runtime mode"');
  });

  it("renders the caller's traits picker and send-to-worker slots", () => {
    const markup = render({
      traitsPicker: <span data-test-traits="true">traits</span>,
      sendToWorkerControl: <span data-test-send="true">send</span>,
    });

    expect(markup).toContain('data-test-traits="true"');
    expect(markup).toContain('data-test-send="true"');
  });

  /**
   * The operator's worker-mode bar: Worker · Computer · Extras. NOTHING else —
   * no Plan/Build toggle, no `Code | Orchestrator` radio (and with it no
   * settings gear), no traits, no "Send to worker", no system prompt.
   */
  it("worker mode shows only Worker, Computer and Extras", () => {
    const markup = render({
      workerMode: true,
      workjetWorkers: [],
      selectedWorkjetWorkerId: "worker-1",
      onSelectWorkjetWorker: () => undefined,
      computerControl: <span data-test-computer="true">computer</span>,
      systemPromptControl: <span data-test-system-prompt="true">prompt</span>,
      traitsPicker: <span data-test-traits="true">traits</span>,
      sendToWorkerControl: <span data-test-send="true">send</span>,
    });

    expect(markup).toContain('aria-label="Worker"');
    expect(markup).toContain('data-test-computer="true"');
    expect(markup).toContain('aria-label="Thread tools"');

    expect(markup).not.toContain(">Build<");
    expect(markup).not.toContain('aria-label="Workjet thread role"');
    expect(markup).not.toContain('data-workjet-settings-gear="true"');
    expect(markup).not.toContain('data-test-traits="true"');
    expect(markup).not.toContain('data-test-send="true"');
    expect(markup).not.toContain('data-test-system-prompt="true"');
  });

  it("manual mode renders the Computer control before the Worker control", () => {
    const markup = render({
      workjetWorkers: [],
      selectedWorkjetWorkerId: null,
      onSelectWorkjetWorker: () => undefined,
      computerControl: <span data-test-computer="true">computer</span>,
    });

    const computerIndex = markup.indexOf('data-test-computer="true"');
    const workerIndex = markup.indexOf('aria-label="Worker"');
    expect(computerIndex).toBeGreaterThanOrEqual(0);
    expect(workerIndex).toBeGreaterThanOrEqual(0);
    expect(computerIndex).toBeLessThan(workerIndex);
    // The manual bar keeps the full control set.
    expect(markup).toContain(">Build<");
    expect(markup).toContain('aria-label="Workjet thread role"');
  });

  it("manual mode renders the system prompt affordance", () => {
    const markup = render({
      systemPromptControl: <span data-test-system-prompt="true">prompt</span>,
    });

    expect(markup).toContain('data-test-system-prompt="true"');
  });
});
