import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerFooterControls, type ComposerFooterControlsProps } from "./ComposerFooterControls";

const baseProps: ComposerFooterControlsProps = {
  traitsPicker: null,
  showInteractionModeToggle: true,
  interactionMode: "default",
  runtimeMode: "full-access",
  workjetRole: "standard",
  workjetGreppyEnabled: false,
  workjetBusy: false,
  workjetDisabled: false,
  sendToWorkerControl: null,
  onToggleInteractionMode: () => undefined,
  onRuntimeModeChange: () => undefined,
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
    expect(markup).toContain('aria-label="Runtime mode"');

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
    expect(markup).toContain('aria-label="Runtime mode"');
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
    expect(markup).toContain('aria-label="Runtime mode"');
  });

  it("renders the caller's traits picker and send-to-worker slots", () => {
    const markup = render({
      traitsPicker: <span data-test-traits="true">traits</span>,
      sendToWorkerControl: <span data-test-send="true">send</span>,
    });

    expect(markup).toContain('data-test-traits="true"');
    expect(markup).toContain('data-test-send="true"');
  });
});
