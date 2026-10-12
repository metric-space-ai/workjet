import { WorkjetWorkerProfile, WorkjetComputer, EnvironmentId } from "@workjet/contracts";
import { Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { NativeSupervisorRouteControlsView } from "./NativeSupervisorRouteControls";

// Existing authenticated catalog evidence: models/g3-claude-live-models-20261009.json.
const profile = Schema.decodeUnknownSync(WorkjetWorkerProfile)({
  id: "molecularity-supervisor",
  name: "Molecularity supervisor",
  computerId: "mac",
  harness: "claude-code",
  llmRouteId: "claude-personal",
  modelId: "claude-opus-5-5",
  reasoning: "automatic",
});
const computer = Schema.decodeUnknownSync(WorkjetComputer)({
  id: "mac",
  label: "MacBook Pro",
  environmentId: "local",
  presentationKind: "local",
  harnesses: [{ harness: "claude-code", available: true }],
});
const defaults = {
  projectId: "molecularity",
  selected: profile,
  profiles: [profile],
  computers: [computer],
  models: [{ id: profile.modelId, displayName: profile.modelId, providers: [], accountIds: [] }],
  environmentId: EnvironmentId.make("local"),
  selectedComputerId: computer.id,
  disabled: false,
  unavailableReason: null,
  onSelectWorker: vi.fn(),
  onSelectManual: vi.fn(),
  onError: vi.fn(),
  onConfigureWorkers: vi.fn(),
  onAddComputer: vi.fn(),
};

describe("Supervisor normal composer controls", () => {
  it("uses the ordinary Luma picker for an instance preset without redundant model or instance buttons", () => {
    const html = renderToStaticMarkup(<NativeSupervisorRouteControlsView {...defaults} />);
    expect(html).toContain('aria-label="Luma"');
    expect(html).toContain("Molecularity supervisor");
    expect(html).not.toContain('aria-label="Supervisor Worker"');
    expect(html).not.toContain("Project instance");
    expect(html).not.toContain("Configure Workers");
    expect(html).not.toContain('aria-label="Harness"');
  });
  it("uses the ordinary Manual, harness, model and computer components with the retained native route", () => {
    const manual = {
      ...profile,
      id: "supervisor-manual:molecularity:selection" as typeof profile.id,
      name: "Manual",
    };
    const html = renderToStaticMarkup(
      <NativeSupervisorRouteControlsView
        {...defaults}
        selected={manual}
        profiles={[profile, manual]}
      />,
    );
    expect(html).toContain(">Manuell</span>");
    expect(html).toContain('aria-label="Harness"');
    expect(html).toContain('aria-label="Modell"');
    expect(html).toContain('aria-label="Rechner"');
    expect(html).toContain("Claude Code");
    expect(html).toContain(profile.modelId);
    expect(html).toContain("MacBook Pro");
    expect(html.indexOf('aria-label="Harness"')).toBeLessThan(html.indexOf('aria-label="Modell"'));
    expect(html.indexOf('aria-label="Modell"')).toBeLessThan(html.indexOf('aria-label="Rechner"'));
  });
  it("keeps the pickers inspectable during an outage, with a concrete connection reason", () => {
    const html = renderToStaticMarkup(
      <NativeSupervisorRouteControlsView
        {...defaults}
        selected={null}
        unavailableReason="The instance is disconnected."
      />,
    );
    expect(html).toContain('aria-label="Luma"');
    expect(html).toContain('aria-label="Harness"');
    expect(html).toContain('aria-label="Rechner"');
    expect(html).not.toContain("Instance default");
    expect(html).not.toContain("Instance model");
    expect(html).not.toContain("Configure Workers");
  });
});
