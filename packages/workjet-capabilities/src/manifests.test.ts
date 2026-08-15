// @effect-diagnostics nodeBuiltinImport:off -- The generator check intentionally spawns Node.
// @ts-expect-error -- The package omits Node types, but this test runs in Node.
import { execFileSync } from "node:child_process";
// @ts-expect-error -- The package omits Node types, but this test runs in Node.
import { fileURLToPath } from "node:url";

declare const process: { readonly execPath: string };

import {
  CapabilityManifestV1,
  type CapabilityAdapter,
  type CapabilityPermissionRequirement,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  WEB_BROWSER_AUTOMATE_TOOL_CONTRACT,
  WEB_BROWSER_PREPARE_TOOL_CONTRACT,
  WEB_DEEP_RESEARCH_TOOL_CONTRACT,
  WEB_READ_TOOL_CONTRACT,
  WEB_SEARCH_TOOL_CONTRACT,
  WEB_STACK_TOOLS,
} from "./generated/web-stack-tools.v1.ts";
import {
  builtInCapabilityManifests,
  WEB_BROWSER_AUTOMATE_INPUT_SCHEMA,
  WEB_BROWSER_AUTOMATE_OUTPUT_SCHEMA,
  WEB_BROWSER_PREPARE_INPUT_SCHEMA,
  WEB_BROWSER_PREPARE_OUTPUT_SCHEMA,
  WEB_DEEP_RESEARCH_INPUT_SCHEMA,
  WEB_DEEP_RESEARCH_OUTPUT_SCHEMA,
  WEB_READ_INPUT_SCHEMA,
  WEB_READ_OUTPUT_SCHEMA,
  WEB_SEARCH_INPUT_SCHEMA,
  WEB_SEARCH_OUTPUT_SCHEMA,
} from "./manifests.ts";

const ALL_ADAPTERS: ReadonlyArray<CapabilityAdapter> = [
  "t3-mcp",
  "t3-prompt",
  "ctox-business-os-mcp",
  "ctox-business-command",
];

const assertFiniteClosedSchema = (schema: unknown): void => {
  expect(schema).toBeTypeOf("object");
  expect(schema).not.toBeNull();
  const node = schema as Record<string, unknown>;
  if (Object.hasOwn(node, "const")) return;
  if (Array.isArray(node.enum)) {
    expect(node.enum.length).toBeGreaterThan(0);
    return;
  }
  switch (node.type) {
    case "object":
      expect(node.additionalProperties).toBe(false);
      expect(node.required).toBeInstanceOf(Array);
      for (const property of Object.values(node.properties as Record<string, unknown>)) {
        assertFiniteClosedSchema(property);
      }
      return;
    case "array":
      expect(node.maxItems).toBeTypeOf("number");
      assertFiniteClosedSchema(node.items);
      return;
    case "string":
      expect(node.maxLength).toBeTypeOf("number");
      return;
    case "integer":
      expect(node.minimum).toBeTypeOf("number");
      expect(node.maximum).toBeTypeOf("number");
      return;
    case "boolean":
      return;
    default:
      throw new Error(`Unsupported schema node: ${JSON.stringify(node)}`);
  }
};

const FORBIDDEN_WEB_STACK_FIELD_NAMES = new Set([
  "source",
  "script",
  "evaluate",
  "path",
  "dir",
  "cwd",
  "environment",
  "env",
  "session_id",
  "sessionId",
  "profile",
  "executable",
  "command",
  "args",
]);

const assertRecursivelyClosedAndProductNeutral = (node: unknown): void => {
  if (Array.isArray(node)) {
    for (const child of node) assertRecursivelyClosedAndProductNeutral(child);
    return;
  }
  if (typeof node !== "object" || node === null) return;

  const record = node as Record<string, unknown>;
  if (record.type === "object") {
    expect(record.additionalProperties).toBe(false);
    expect(record.properties).toBeTypeOf("object");
    expect(record.properties).not.toBeNull();
    for (const fieldName of Object.keys(record.properties as Record<string, unknown>)) {
      expect(FORBIDDEN_WEB_STACK_FIELD_NAMES.has(fieldName), fieldName).toBe(false);
    }
  }
  for (const child of Object.values(record)) assertRecursivelyClosedAndProductNeutral(child);
};

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

describe("canonical Web Stack tool contract", () => {
  it("contains exactly the five tools in canonical order with exact grants", () => {
    expect(WEB_STACK_TOOLS.map(({ name, capabilityId }) => ({ name, capabilityId }))).toEqual([
      { name: "web_search", capabilityId: "web-search" },
      { name: "web_read", capabilityId: "web-search" },
      { name: "web_deep_research", capabilityId: "web-search" },
      { name: "web_browser_prepare", capabilityId: "web-stack-browser" },
      { name: "web_browser_automate", capabilityId: "web-stack-browser" },
    ]);
  });

  it("keeps every input and output schema recursively closed and product-neutral", () => {
    for (const tool of WEB_STACK_TOOLS) {
      assertRecursivelyClosedAndProductNeutral(tool.inputSchema);
      assertRecursivelyClosedAndProductNeutral(tool.outputSchema);
    }
  });

  it("derives all public schema exports from the generated contract", () => {
    expect(WEB_SEARCH_INPUT_SCHEMA).toEqual(WEB_SEARCH_TOOL_CONTRACT.inputSchema);
    expect(WEB_SEARCH_OUTPUT_SCHEMA).toEqual(WEB_SEARCH_TOOL_CONTRACT.outputSchema);
    expect(WEB_READ_INPUT_SCHEMA).toEqual(WEB_READ_TOOL_CONTRACT.inputSchema);
    expect(WEB_READ_OUTPUT_SCHEMA).toEqual(WEB_READ_TOOL_CONTRACT.outputSchema);
    expect(WEB_DEEP_RESEARCH_INPUT_SCHEMA).toEqual(WEB_DEEP_RESEARCH_TOOL_CONTRACT.inputSchema);
    expect(WEB_DEEP_RESEARCH_OUTPUT_SCHEMA).toEqual(WEB_DEEP_RESEARCH_TOOL_CONTRACT.outputSchema);
    expect(WEB_BROWSER_PREPARE_INPUT_SCHEMA).toEqual(WEB_BROWSER_PREPARE_TOOL_CONTRACT.inputSchema);
    expect(WEB_BROWSER_PREPARE_OUTPUT_SCHEMA).toEqual(
      WEB_BROWSER_PREPARE_TOOL_CONTRACT.outputSchema,
    );
    expect(WEB_BROWSER_AUTOMATE_INPUT_SCHEMA).toEqual(
      WEB_BROWSER_AUTOMATE_TOOL_CONTRACT.inputSchema,
    );
    expect(WEB_BROWSER_AUTOMATE_OUTPUT_SCHEMA).toEqual(
      WEB_BROWSER_AUTOMATE_TOOL_CONTRACT.outputSchema,
    );
  });

  it("keeps browser automation to the finite five-action AST", () => {
    expect(
      WEB_BROWSER_AUTOMATE_TOOL_CONTRACT.inputSchema.properties.actions.items.oneOf.map(
        (action) => action.properties.action.const,
      ),
    ).toEqual(["navigate", "observe", "click", "fill", "press"]);
  });

  it("has a byte-current generated TypeScript representation", () => {
    const generator = fileURLToPath(
      new URL("../scripts/generate-web-stack-contract.mjs", import.meta.url),
    );
    expect(() => execFileSync(process.execPath, [generator, "--check"])).not.toThrow();
  });
});

describe("built-in capability manifests", () => {
  it("exports exactly the canonical IDs and versions in order", () => {
    expect(builtInCapabilityManifests.map(({ id, version }) => ({ id, version }))).toEqual(
      EXPECTED.map(({ id, version }) => ({ id, version })),
    );
  });

  it("uses the canonical search and browser automation schemas without copies", () => {
    const search = builtInCapabilityManifests.find(({ id }) => id === "web-search");
    const browser = builtInCapabilityManifests.find(({ id }) => id === "web-stack-browser");

    expect(search?.inputSchema).toEqual(WEB_SEARCH_TOOL_CONTRACT.inputSchema);
    expect(search?.outputSchema).toEqual(WEB_SEARCH_TOOL_CONTRACT.outputSchema);
    expect(browser?.inputSchema).toEqual(WEB_BROWSER_AUTOMATE_TOOL_CONTRACT.inputSchema);
    expect(browser?.outputSchema).toEqual(WEB_BROWSER_AUTOMATE_TOOL_CONTRACT.outputSchema);
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
        query: {
          type: "string",
          minLength: 1,
          maxLength: 4_000,
          pattern: "\\S",
        },
        find: {
          type: "array",
          maxItems: 32,
          items: {
            type: "string",
            minLength: 1,
            maxLength: 1_000,
            pattern: "\\S",
          },
        },
        country: { type: "string", enum: ["DE", "AT", "CH"] },
      },
    });
    expect(WEB_DEEP_RESEARCH_INPUT_SCHEMA).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 4_000,
          pattern: "\\S",
        },
        focus: {
          type: "string",
          minLength: 1,
          maxLength: 4_000,
          pattern: "\\S",
        },
        depth: { type: "string", enum: ["quick", "standard", "exhaustive"] },
        maxSources: { type: "integer", minimum: 3, maximum: 100 },
        excludeUrls: {
          type: "array",
          maxItems: 100,
          items: {
            type: "string",
            minLength: 1,
            maxLength: 8_000,
            pattern: "\\S",
          },
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

  it("exports recursively closed output schemas with the Rust normalization bounds", () => {
    assertFiniteClosedSchema(WEB_READ_OUTPUT_SCHEMA);
    assertFiniteClosedSchema(WEB_DEEP_RESEARCH_OUTPUT_SCHEMA);

    expect(WEB_READ_OUTPUT_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: [
        "operation",
        "requestedUrl",
        "isPdf",
        "redirectChain",
        "excerpts",
        "findMatches",
        "pageSections",
        "transportEvidenceEligible",
        "evidenceEligible",
        "datasetContentExtracted",
      ],
      properties: {
        operation: { const: "read" },
        requestedUrl: { maxLength: 8_000 },
        pageTextExcerpt: { maxLength: 16_000 },
        redirectChain: { maxItems: 100, items: { maxLength: 8_000 } },
        findMatches: { maxItems: 32 },
        pageSections: { maxItems: 100 },
      },
    });
    expect(WEB_DEEP_RESEARCH_OUTPUT_SCHEMA).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        operation: { const: "deepResearch" },
        query: { maxLength: 4_000 },
        maxSources: { minimum: 3, maximum: 100 },
        verifiedSources: { maxItems: 100 },
        blockedSources: { maxItems: 100 },
        systematicCoverage: { additionalProperties: false },
        researchCallCounts: { additionalProperties: false },
        reportScaffold: { additionalProperties: false },
        workspaceId: { minLength: 25, maxLength: 25 },
      },
    });

    const serialized = JSON.stringify([
      WEB_READ_OUTPUT_SCHEMA,
      WEB_DEEP_RESEARCH_OUTPUT_SCHEMA,
    ]).toLowerCase();
    for (const forbidden of ['"path"', '"body"', '"html"', '"raw"', "artifact", "workspacepath"]) {
      expect(serialized).not.toContain(forbidden);
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
      readonly items?: {
        readonly oneOf?: ReadonlyArray<Record<string, unknown>>;
      };
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
