import {
  CapabilityManifestV1,
  type CapabilityAdapter,
  type CapabilityPermissionRequirement,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  builtInCapabilityManifests,
  WEB_DEEP_RESEARCH_INPUT_SCHEMA,
  WEB_READ_INPUT_SCHEMA,
} from "./manifests.ts";

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

  it("uses bounded object schemas with capability-specific required inputs", () => {
    for (const manifest of builtInCapabilityManifests) {
      expect(manifest.inputSchema.type).toBe("object");
      expect(manifest.inputSchema.additionalProperties).toBe(false);
      expect(manifest.inputSchema.required).toEqual([
        manifest.id === "web-search"
          ? "query"
          : manifest.id === "web-stack-browser"
            ? "actions"
            : "task",
      ]);
      expect(manifest.outputSchema.type).toBe("object");
      expect(manifest.outputSchema.additionalProperties).toBe(false);
      expect(manifest.outputSchema.required).toBeInstanceOf(Array);
    }
  });

  it("exports strict bounded read and deep research model schemas without path controls", () => {
    expect(WEB_READ_INPUT_SCHEMA).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", minLength: 1, maxLength: 8_000, pattern: "\\S" },
        query: { type: "string", minLength: 1, maxLength: 4_000, pattern: "\\S" },
        find: {
          type: "array",
          maxItems: 32,
          items: { type: "string", minLength: 1, maxLength: 1_000, pattern: "\\S" },
        },
        country: { type: "string", enum: ["DE", "AT", "CH"] },
      },
    });
    expect(WEB_DEEP_RESEARCH_INPUT_SCHEMA).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1, maxLength: 4_000, pattern: "\\S" },
        focus: { type: "string", minLength: 1, maxLength: 4_000, pattern: "\\S" },
        depth: { type: "string", enum: ["quick", "standard", "exhaustive"] },
        maxSources: { type: "integer", minimum: 3, maximum: 100 },
        excludeUrls: {
          type: "array",
          maxItems: 100,
          items: { type: "string", minLength: 1, maxLength: 8_000, pattern: "\\S" },
        },
        includePapers: { type: "boolean" },
        includeAnnasArchive: { type: "boolean" },
      },
    });
    const serialized = JSON.stringify([WEB_READ_INPUT_SCHEMA, WEB_DEEP_RESEARCH_INPUT_SCHEMA]);
    for (const forbidden of ["workspace", "path", "config", "environment", "executable"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("describes Web Search as one search, read, and research capability", () => {
    const manifest = builtInCapabilityManifests.find(({ id }) => id === "web-search");
    expect(manifest?.version).toBe("1.0.0");
    expect(manifest?.metadata.description).toContain("reads specific pages");
    expect(manifest?.metadata.description).toContain("deep research");
    expect(manifest?.promptContribution?.instructions).toContain("read specific public pages");
    expect(manifest?.promptContribution?.instructions).toContain("deep research");
  });

  it("defines the browser contract as a strict bounded finite action vocabulary", () => {
    const browser = builtInCapabilityManifests.find(
      ({ id, version }) => id === "web-stack-browser" && version === "1.0.0",
    );
    expect(browser).toBeDefined();
    const inputProperties = browser?.inputSchema.properties as Record<string, unknown> | undefined;
    const actions = inputProperties?.actions as {
      readonly minItems?: number;
      readonly maxItems?: number;
      readonly items?: { readonly oneOf?: ReadonlyArray<Record<string, unknown>> };
    };
    expect(actions.minItems).toBe(1);
    expect(actions.maxItems).toBe(32);
    expect(
      actions.items?.oneOf?.map(
        (action) =>
          (action.properties as { readonly action: { readonly const: string } }).action.const,
      ),
    ).toEqual(["navigate", "observe", "click", "fill", "press"]);
    expect(JSON.stringify(browser?.inputSchema)).not.toContain("source");
    expect(JSON.stringify(browser?.inputSchema)).not.toContain("path");
    expect(JSON.stringify(browser?.inputSchema)).not.toContain("environment");
    expect(JSON.stringify(browser?.inputSchema)).toContain('"pattern":"\\\\S"');
    const outputProperties = browser?.outputSchema.properties as
      | Record<string, unknown>
      | undefined;
    expect(outputProperties?.observations).toMatchObject({ maxItems: 200 });
  });
});
