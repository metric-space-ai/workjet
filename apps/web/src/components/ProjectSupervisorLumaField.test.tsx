import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import {
  DEFAULT_WORKJET_CONFIGURATION,
  extractLumaInstanceDocument,
  WorkjetLumaTarget,
  WorkjetWorkerProfile,
} from "@workjet/contracts";
import {
  ProjectSupervisorLumaSelect,
  ProjectSupervisorLumaSummaryView,
  readCachedSupervisorLumas,
  writeCachedSupervisorLumas,
} from "./ProjectSupervisorLumaField";

const profile = Schema.decodeUnknownSync(WorkjetWorkerProfile)({
  id: "molecularity-supervisor",
  name: "Molecularity supervisor",
  computerId: "gpu3",
  harness: "claude-code",
  llmRouteId: "claude-personal",
  modelId: "claude-opus-5-5",
  reasoning: "automatic",
});

describe("Project Supervisor-Preset selection", () => {
  it("uses configured metadata in the overview only while its scoped source is available", () => {
    const ready = renderToStaticMarkup(
      <ProjectSupervisorLumaSummaryView lumaId={profile.id} phase="ready" profiles={[profile]} />,
    );
    expect(ready).toContain(`Konfiguriert · Claude Code · ${profile.modelId}`);
    const unavailable = renderToStaticMarkup(
      <ProjectSupervisorLumaSummaryView
        lumaId={profile.id}
        phase="unavailable"
        profiles={[profile]}
      />,
    );
    expect(unavailable).toContain("Presets nicht erreichbar");
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
    expect(html).toContain(profile.modelId);
    expect(html).not.toContain("Konfiguriert ·");
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
    expect(html).toContain("Presets nicht erreichbar");
    expect(html).not.toContain(profile.modelId);
    expect(html).not.toContain("Erneut versuchen");
  });
  it("offers exactly one retry action when the hook can retry", () => {
    const html = renderToStaticMarkup(
      <ProjectSupervisorLumaSelect
        id="luma"
        value={null}
        onChange={() => {}}
        disabled={false}
        phase="unavailable"
        profiles={[]}
        retry={() => {}}
      />,
    );
    expect(html).toContain("Presets nicht erreichbar");
    expect(html.match(/Erneut versuchen/g)).toHaveLength(1);
  });
});

describe("cached supervisor lumas", () => {
  it("keeps the last known templates across a failed or slow reload", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    try {
      expect(readCachedSupervisorLumas("managed:fixture")).toBeNull();
      writeCachedSupervisorLumas("managed:fixture", {
        instanceName: "Fixture",
        target: Schema.decodeUnknownSync(WorkjetLumaTarget)({
          connectionId: "conn-1",
          instanceId: "managed:fixture",
        }),
        configuration: extractLumaInstanceDocument({
          ...DEFAULT_WORKJET_CONFIGURATION,
          workerProfiles: [profile],
        }),
      });
      const cached = readCachedSupervisorLumas("managed:fixture");
      expect(cached?.configuration?.workerProfiles[0]?.id).toBe(profile.id);
      expect(cached?.target?.connectionId).toBe("conn-1");
      // A different instance never borrows this list.
      expect(readCachedSupervisorLumas("managed:other")).toBeNull();
      // Corrupt payloads degrade to „no cache“ instead of breaking the menu.
      store.set("workjet.supervisor-lumas.v1:managed:fixture", "{broken");
      expect(readCachedSupervisorLumas("managed:fixture")).toBeNull();
    } finally {
      Object.defineProperty(globalThis, "localStorage", { value: original, configurable: true });
    }
  });
});
