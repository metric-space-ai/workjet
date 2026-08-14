import {
  CapabilityManifestV1,
  type CapabilityAdapter,
  type CapabilityPermissionRequirement,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { builtInCapabilityManifests } from "./manifests.ts";

const ALL_ADAPTERS: ReadonlyArray<CapabilityAdapter> = [
  "t3-mcp",
  "t3-prompt",
  "ctox-business-os-mcp",
  "ctox-business-command",
];

const EXPECTED = [
  {
    id: "greppy",
    version: "1.0.0",
    permissions: ["process.spawn", "filesystem.read"],
  },
  {
    id: "web-search",
    version: "1.0.0",
    permissions: ["network.search", "network.read"],
  },
  {
    id: "web-stack-browser",
    version: "1.0.0",
    permissions: ["browser.automation", "network.read"],
  },
] as const satisfies ReadonlyArray<{
  readonly id: string;
  readonly version: string;
  readonly permissions: ReadonlyArray<CapabilityPermissionRequirement>;
}>;

describe("built-in capability manifests", () => {
  it("exports exactly the canonical IDs and versions in order", () => {
    expect(builtInCapabilityManifests.map(({ id, version }) => ({ id, version }))).toEqual(
      EXPECTED.map(({ id, version }) => ({ id, version })),
    );
  });

  it("defines the exact permission sets and all supported adapters", () => {
    for (const [index, manifest] of builtInCapabilityManifests.entries()) {
      expect(manifest.permissionRequirements).toEqual(EXPECTED[index]?.permissions);
      expect(manifest.supportedAdapters).toEqual(ALL_ADAPTERS);
      expect(manifest.secretRequirements).toEqual([]);
    }
  });

  it("decodes every runtime export through the V1 contract", () => {
    const decode = Schema.decodeUnknownSync(CapabilityManifestV1);

    for (const manifest of builtInCapabilityManifests) {
      expect(decode(manifest)).toEqual(manifest);
      expect(manifest.metadata.displayName.trim()).not.toBe("");
      expect(manifest.metadata.description.trim()).not.toBe("");
      expect(manifest.promptContribution?.instructions.trim()).not.toBe("");
    }
  });

  it("round-trips every manifest through JSON and the contract", () => {
    const decode = Schema.decodeUnknownSync(CapabilityManifestV1);
    const encode = Schema.encodeSync(CapabilityManifestV1);

    for (const manifest of builtInCapabilityManifests) {
      const wire = encode(manifest);
      const jsonRoundTrip = JSON.parse(JSON.stringify(wire)) as unknown;

      expect(encode(decode(jsonRoundTrip))).toEqual(wire);
    }
  });

  it("uses bounded object schemas with required task or query text and structured output", () => {
    for (const manifest of builtInCapabilityManifests) {
      expect(manifest.inputSchema.type).toBe("object");
      expect(manifest.inputSchema.additionalProperties).toBe(false);
      expect(manifest.inputSchema.required).toEqual([
        manifest.id === "web-search" ? "query" : "task",
      ]);
      expect(manifest.outputSchema.type).toBe("object");
      expect(manifest.outputSchema.additionalProperties).toBe(false);
      expect(manifest.outputSchema.required).toBeInstanceOf(Array);
    }
  });
});
