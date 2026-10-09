import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import { WorkjetWorkerProfile } from "@workjet/contracts";
import { ProjectSupervisorLumaSelect, ProjectSupervisorLumaSummaryView } from "./ProjectSupervisorLumaField";

const profile = Schema.decodeUnknownSync(WorkjetWorkerProfile)({
  id: "molecularity-supervisor",
  name: "Molecularity supervisor",
  computerId: "gpu3",
  harness: "claude-code",
  llmRouteId: "claude-personal",
  modelId: "claude-opus-5-5",
  reasoning: "automatic",
});

describe("Project Supervisor Luma selection", () => {
  it("uses configured metadata in the overview only while its scoped source is available", () => {
    const ready = renderToStaticMarkup(<ProjectSupervisorLumaSummaryView lumaId={profile.id}
      phase="ready" profiles={[profile]} />);
    expect(ready).toContain(`Configured · Claude Code · ${profile.modelId}`);
    const unavailable = renderToStaticMarkup(<ProjectSupervisorLumaSummaryView lumaId={profile.id}
      phase="unavailable" profiles={[profile]} />);
    expect(unavailable).toContain("Configured Luma unavailable");
    expect(unavailable).not.toContain(profile.modelId);
  });

  it("shows the configured model without claiming actual execution", () => {
    const html = renderToStaticMarkup(
      <ProjectSupervisorLumaSelect
        id="luma"
        value={profile.id}
        onChange={() => {}}
        disabled={false}
        phase="ready"
        profiles={[profile]}
      />,
    );
    expect(html).toContain("Molecularity supervisor");
    expect(html).toContain("Configured ·");
    expect(html).toContain(profile.modelId);
    expect(html).toContain(profile.computerId);
    expect(html).not.toContain("Executed");
  });
  it("retains a missing saved Luma while a scoped read is unavailable", () => {
    const html = renderToStaticMarkup(
      <ProjectSupervisorLumaSelect
        id="luma"
        value={profile.id}
        onChange={() => {}}
        disabled={false}
        phase="unavailable"
        profiles={[]}
      />,
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain(`value="${profile.id}"`);
    expect(html).toContain("The saved selection is retained");
    expect(html).not.toContain(profile.modelId);
  });
});
