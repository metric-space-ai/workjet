import { WorkjetWorkerProfile } from "@workjet/contracts";
import { Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { NativeSupervisorRouteControlsView } from "./NativeSupervisorRouteControls";

// Existing authenticated catalog evidence: models/g3-claude-live-models-20261009.json.
const profile = Schema.decodeUnknownSync(WorkjetWorkerProfile)({
  id: "molecularity-supervisor",
  name: "Molecularity supervisor",
  computerId: "gpu3",
  harness: "claude-code",
  llmRouteId: "claude-personal",
  modelId: "claude-opus-5-5",
  reasoning: "automatic",
});
const defaults = {
  value: profile.id,
  profiles: [profile],
  disabled: false,
  phase: "ready" as const,
  saving: false,
  error: null,
  routeTitle: "Configured instance Luma. No verified execution receipt is available.",
  instanceName: "Welsch",
  onChange: () => {},
  onConfigureWorkers: () => {},
  onConfigureInstance: () => {},
};

describe("native Supervisor composer route controls", () => {
  it("offers real instance Workers and their harness/model routes in the composer", () => {
    const html = renderToStaticMarkup(<NativeSupervisorRouteControlsView {...defaults} />);
    expect(html).toContain('aria-label="Supervisor Worker"');
    expect(html).toContain('aria-label="Supervisor model"');
    expect(html).toContain("Molecularity supervisor");
    expect(html).toContain("Claude Code · claude-opus-5-5");
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain('aria-disabled="true"');
    expect(html).toContain("No verified execution receipt");
    expect(html).not.toContain("Executed ·");
  });
  it("offers the existing default and does not invent a model while no Worker is configured", () => {
    const html = renderToStaticMarkup(
      <NativeSupervisorRouteControlsView {...defaults} value={null} profiles={[]} />,
    );
    expect(html).toContain("Instance default");
    expect(html).toContain("Instance model");
    expect(html).toContain("Configure Workers");
    expect(html).not.toContain("claude-opus");
  });
  it("retains the saved selection during an outage and offers configuration instead of a dead button", () => {
    const html = renderToStaticMarkup(
      <NativeSupervisorRouteControlsView
        {...defaults}
        phase="unavailable"
        profiles={[]}
        disabled
      />,
    );
    expect(html).toContain('value="molecularity-supervisor" selected=""');
    expect(html).toContain("Saved Worker unavailable");
    expect(html).toContain("Saved model unavailable");
    expect(html).toContain("Configure Workers");
    expect(html).toContain("saved route is retained");
    expect(html).not.toContain("claude-opus");
  });
  it("shows saving and the native failure beside the choice", () => {
    const saving = renderToStaticMarkup(
      <NativeSupervisorRouteControlsView {...defaults} saving disabled />,
    );
    expect(saving).toContain('role="status"');
    expect(saving).toContain("Saving…");
    const failed = renderToStaticMarkup(
      <NativeSupervisorRouteControlsView
        {...defaults}
        error="Sign in to ctox.dev to reconnect this project's instance."
      />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Sign in to ctox.dev");
  });
});
