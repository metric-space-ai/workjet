import type { CapabilityManifestV1 } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { builtInCapabilityManifests } from "./manifests.ts";
import { compileCapabilityPrompt } from "./prompt.ts";

const withPrompt = (
  manifest: CapabilityManifestV1,
  instructions: string | null,
): CapabilityManifestV1 => ({
  ...manifest,
  promptContribution: instructions === null ? null : { instructions },
});

describe("capability prompt compiler", () => {
  it("places trimmed managed instructions first and capabilities in supplied order", () => {
    const manifests = [
      withPrompt(builtInCapabilityManifests[1]!, "  Search carefully.  "),
      withPrompt(builtInCapabilityManifests[0]!, "\nLocate exact matches.\n"),
    ];

    expect(
      compileCapabilityPrompt({
        managedInstructions: "  Follow the managed policy.  ",
        manifests,
      }),
    ).toBe(
      [
        "## Managed Instructions\n\nFollow the managed policy.",
        "## Capability: web-search@1.0.0\n\nSearch carefully.",
        "## Capability: greppy@1.0.0\n\nLocate exact matches.",
      ].join("\n\n"),
    );
  });

  it("de-duplicates by capability ID using the first occurrence", () => {
    const manifests = [
      withPrompt(builtInCapabilityManifests[0]!, "First contribution."),
      withPrompt(builtInCapabilityManifests[0]!, "Second contribution."),
      withPrompt(builtInCapabilityManifests[2]!, "Browser contribution."),
    ];
    const prompt = compileCapabilityPrompt({ managedInstructions: "", manifests });

    expect(prompt).toContain("First contribution.");
    expect(prompt).not.toContain("Second contribution.");
    expect(prompt.match(/greppy@1\.0\.0/g)).toHaveLength(1);
  });

  it("returns empty output for blank instructions and no contributions", () => {
    expect(
      compileCapabilityPrompt({
        managedInstructions: " \n\t ",
        manifests: [
          withPrompt(builtInCapabilityManifests[0]!, null),
          withPrompt(builtInCapabilityManifests[1]!, null),
        ],
      }),
    ).toBe("");
  });

  it("omits permissions, secret references, schemas, adapters, and metadata", () => {
    const sentinelManifest: CapabilityManifestV1 = {
      ...builtInCapabilityManifests[0]!,
      metadata: {
        displayName: "DISPLAY_SENTINEL",
        description: "DESCRIPTION_SENTINEL",
      },
      promptContribution: { instructions: "Allowed prompt text." },
      permissionRequirements: ["process.spawn"],
      secretRequirements: [{ reference: "SECRET_REFERENCE_SENTINEL", optional: false }],
      inputSchema: { sentinelInputSchema: "INPUT_SCHEMA_SENTINEL" },
      outputSchema: { sentinelOutputSchema: "OUTPUT_SCHEMA_SENTINEL" },
      supportedAdapters: ["ctox-business-command"],
    };
    const prompt = compileCapabilityPrompt({
      managedInstructions: "Managed text.",
      manifests: [sentinelManifest],
    });

    expect(prompt).toContain("Allowed prompt text.");
    expect(prompt).toContain("greppy@1.0.0");
    expect(prompt).not.toContain("DISPLAY_SENTINEL");
    expect(prompt).not.toContain("DESCRIPTION_SENTINEL");
    expect(prompt).not.toContain("process.spawn");
    expect(prompt).not.toContain("SECRET_REFERENCE_SENTINEL");
    expect(prompt).not.toContain("INPUT_SCHEMA_SENTINEL");
    expect(prompt).not.toContain("OUTPUT_SCHEMA_SENTINEL");
    expect(prompt).not.toContain("ctox-business-command");
  });

  it("does not mutate the supplied manifest collection", () => {
    const manifests = [builtInCapabilityManifests[2]!, builtInCapabilityManifests[0]!];
    const original = [...manifests];

    compileCapabilityPrompt({ managedInstructions: "Managed", manifests });

    expect(manifests).toEqual(original);
  });
});
