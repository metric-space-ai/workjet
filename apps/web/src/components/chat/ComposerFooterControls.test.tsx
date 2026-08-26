import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_FOOTER_ROW_BREAKPOINTS,
  ComposerFooterControls,
  composerFooterRowCountForWidth,
  type ComposerFooterControlsProps,
} from "./ComposerFooterControls";

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
  it("maps measured form widths to exactly one, two, then three ordered rows", () => {
    expect(composerFooterRowCountForWidth(null)).toBe(1);
    expect(composerFooterRowCountForWidth(COMPOSER_FOOTER_ROW_BREAKPOINTS.twoRowMaxWidth + 1)).toBe(
      1,
    );
    expect(composerFooterRowCountForWidth(COMPOSER_FOOTER_ROW_BREAKPOINTS.twoRowMaxWidth)).toBe(2);
    expect(
      composerFooterRowCountForWidth(COMPOSER_FOOTER_ROW_BREAKPOINTS.threeRowMaxWidth + 1),
    ).toBe(2);
    expect(composerFooterRowCountForWidth(COMPOSER_FOOTER_ROW_BREAKPOINTS.threeRowMaxWidth)).toBe(
      3,
    );
  });

  /**
   * Provider Plan/Build stays inline; thread role and capabilities live in one
   * compact settings menu instead of spending permanent composer width.
   */
  it("keeps Plan/Build inline and moves the Workjet role into thread settings", () => {
    const markup = render();

    // The provider-specific Plan/Build toggle, untouched.
    expect(markup).toContain('aria-label="Default mode — click to enter plan mode"');
    expect(markup).toContain(">Build<");
    // …and the access control it ships with.
    // Permission is ALWAYS full (operator rule): the picker is gone.
    expect(markup).not.toContain('aria-label="Runtime mode"');

    expect(markup).toContain('aria-label="Thread tools"');
    expect(markup).not.toContain('aria-label="Workjet thread role"');
    expect(markup).not.toContain('data-workjet-role-group="true"');
    expect(markup).not.toContain('data-workjet-settings-gear="true"');
  });

  it("keeps both controls when the provider thread is in plan mode", () => {
    const markup = render({ interactionMode: "plan" });

    expect(markup).toContain('aria-label="Plan mode — click to return to normal build mode"');
    expect(markup).toContain(">Plan<");
    expect(markup).toContain('aria-label="Thread tools"');
  });

  it("keeps thread settings for a provider that has no Plan/Build toggle", () => {
    const markup = render({ showInteractionModeToggle: false });

    expect(markup).not.toContain(">Build<");
    // Permission is ALWAYS full (operator rule): the picker is gone.
    expect(markup).not.toContain('aria-label="Runtime mode"');
    expect(markup).toContain('aria-label="Thread tools"');
  });

  it("does not expose the read-only worker role in the main composer row", () => {
    const markup = render({ workjetRole: "worker" });

    expect(markup).toContain(">Build<");
    expect(markup).toContain('aria-label="Thread tools"');
    expect(markup).not.toContain('data-workjet-role="worker"');
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

  it("manual mode: Worker, Computer, provider target, then manual targets (operator order)", () => {
    const markup = render({
      workjetWorkers: [],
      selectedWorkjetWorkerId: null,
      onSelectWorkjetWorker: () => undefined,
      computerControl: <span data-test-computer="true">computer</span>,
      providerTargetControl: <span data-test-provider-target="true">provider</span>,
      manualTargetControls: <span data-test-manual-targets="true">targets</span>,
    });

    const workerIndex = markup.indexOf('aria-label="Worker"');
    const computerIndex = markup.indexOf('data-test-computer="true"');
    const providerIndex = markup.indexOf('data-test-provider-target="true"');
    const targetsIndex = markup.indexOf('data-test-manual-targets="true"');
    expect(workerIndex).toBeGreaterThanOrEqual(0);
    expect(computerIndex).toBeGreaterThan(workerIndex);
    expect(providerIndex).toBeGreaterThan(computerIndex);
    expect(targetsIndex).toBeGreaterThan(providerIndex);
    // The manual bar keeps the full control set (second row).
    expect(markup).toContain(">Build<");
    expect(markup).toContain('aria-label="Thread tools"');
  });

  it("manual mode renders the system prompt affordance", () => {
    const markup = render({
      systemPromptControl: <span data-test-system-prompt="true">prompt</span>,
    });

    expect(markup).toContain('data-test-system-prompt="true"');
  });

  it("keeps the full Workjet manual contract ordered across measured rows", () => {
    const markup = render({
      workjetWorkers: [],
      selectedWorkjetWorkerId: null,
      onSelectWorkjetWorker: () => undefined,
      computerControl: <span data-test-computer="true">computer</span>,
      manualTargetControls: <span data-test-manual-targets="true">harness-model</span>,
      traitsPicker: <span data-test-effort="true">effort</span>,
      contextWindowControl: <span data-test-context="true">context</span>,
      systemPromptControl: <span data-test-system-prompt="true">prompt</span>,
      attachmentControl: <span data-test-upload="true">upload</span>,
      sendToWorkerControl: <span data-test-send="true">send</span>,
      showInteractionModeToggle: false,
      rowCount: 3,
    });

    const orderedMarkers = [
      'aria-label="Worker"',
      'data-test-computer="true"',
      'data-test-manual-targets="true"',
      'data-test-effort="true"',
      'data-test-context="true"',
      'data-test-system-prompt="true"',
      'aria-label="Thread tools"',
      'data-test-upload="true"',
      'data-test-send="true"',
    ];
    let previousIndex = -1;
    for (const marker of orderedMarkers) {
      const nextIndex = markup.indexOf(marker);
      expect(nextIndex, `missing or misplaced marker: ${marker}`).toBeGreaterThan(previousIndex);
      previousIndex = nextIndex;
    }

    expect(markup).toContain('data-composer-row-break-after="computer"');
    expect(markup).toContain('data-composer-row-break-after="context"');
    expect(markup).toContain('data-composer-control-density="compact"');
  });

  it("uses one responsive flow and keeps the Tools cluster atomic", () => {
    const markup = render();

    expect(markup).toContain('data-composer-manual-responsive-flow="true"');
    expect(markup).toContain("flex-wrap");
    expect(markup).toContain("gap-x-0.5");
    expect(markup).not.toContain("grid-cols-[max-content_max-content]");
    expect(markup).not.toContain("flex-col gap-1");
    expect(markup).toContain('data-composer-mode-cluster="true"');
    expect(markup).toContain('data-composer-tools-cluster="true"');
    expect(markup).toContain('data-composer-secondary-cluster="true"');
    expect(markup).toMatch(/class="[^"]*shrink-0[^"]*" data-composer-tools-cluster="true"/);
  });
});
