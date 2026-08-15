import { CapabilityManifestV1 } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const ALL_ADAPTERS = [
  "t3-mcp",
  "t3-prompt",
  "ctox-business-os-mcp",
  "ctox-business-command",
] as const;

const NON_WHITESPACE_STRING = (maxLength: number) =>
  ({ type: "string", minLength: 1, maxLength, pattern: "\\S" }) as const;

export const WEB_READ_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["url"],
  properties: {
    url: NON_WHITESPACE_STRING(8_000),
    query: NON_WHITESPACE_STRING(4_000),
    find: {
      type: "array",
      maxItems: 32,
      items: NON_WHITESPACE_STRING(1_000),
    },
    country: { type: "string", enum: ["DE", "AT", "CH"] },
  },
} as const;

export const WEB_DEEP_RESEARCH_INPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["query"],
  properties: {
    query: NON_WHITESPACE_STRING(4_000),
    focus: NON_WHITESPACE_STRING(4_000),
    depth: { type: "string", enum: ["quick", "standard", "exhaustive"] },
    maxSources: { type: "integer", minimum: 3, maximum: 100 },
    excludeUrls: {
      type: "array",
      maxItems: 100,
      items: NON_WHITESPACE_STRING(8_000),
    },
    includePapers: { type: "boolean" },
    includeAnnasArchive: { type: "boolean" },
  },
} as const;

const BROWSER_TARGET_SCHEMA = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: ["selector"],
      properties: {
        selector: { type: "string", minLength: 1, maxLength: 2000, pattern: "\\S" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["testId"],
      properties: {
        testId: { type: "string", minLength: 1, maxLength: 2000, pattern: "\\S" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["role", "name"],
      properties: {
        role: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
        name: { type: "string", minLength: 1, maxLength: 2000, pattern: "\\S" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["label"],
      properties: {
        label: { type: "string", minLength: 1, maxLength: 2000, pattern: "\\S" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["placeholder"],
      properties: {
        placeholder: { type: "string", minLength: 1, maxLength: 2000, pattern: "\\S" },
      },
    },
    {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: {
        text: { type: "string", minLength: 1, maxLength: 2000, pattern: "\\S" },
      },
    },
  ],
} as const;

const BUILT_IN_MANIFEST_LITERALS = [
  {
    schemaVersion: 1,
    id: "greppy",
    version: "1.0.0",
    metadata: {
      displayName: "Greppy",
      description: "Searches text in readable files and returns matching locations.",
    },
    promptContribution: {
      instructions:
        "Use Greppy to locate relevant text in files when repository or document search would help answer the task.",
    },
    permissionRequirements: ["process.spawn", "filesystem.read"],
    secretRequirements: [],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["task"],
      properties: {
        task: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          description: "A plain-language description of the text to locate.",
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["matches"],
      properties: {
        matches: {
          type: "array",
          maxItems: 200,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "excerpt"],
            properties: {
              path: { type: "string", minLength: 1, maxLength: 2000 },
              line: { type: "integer", minimum: 1 },
              excerpt: { type: "string", maxLength: 8000 },
            },
          },
        },
      },
    },
    supportedAdapters: ALL_ADAPTERS,
  },
  {
    schemaVersion: 1,
    id: "web-search",
    version: "1.0.0",
    metadata: {
      displayName: "Web Search",
      description:
        "Searches public web sources, reads specific pages, and performs bounded deep research with structured evidence.",
    },
    promptContribution: {
      instructions:
        "Use Web Search to discover current or externally published information, read specific public pages, or perform bounded deep research, and ground conclusions in the returned evidence.",
    },
    permissionRequirements: ["network.search", "network.read"],
    secretRequirements: [],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          minLength: 1,
          maxLength: 2000,
          description: "The web search query.",
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["results"],
      properties: {
        results: {
          type: "array",
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "url", "snippet"],
            properties: {
              title: { type: "string", maxLength: 2000 },
              url: { type: "string", minLength: 1, maxLength: 8000 },
              snippet: { type: "string", maxLength: 8000 },
            },
          },
        },
      },
    },
    supportedAdapters: ALL_ADAPTERS,
  },
  {
    schemaVersion: 1,
    id: "web-stack-browser",
    version: "1.0.0",
    metadata: {
      displayName: "Web Stack Browser",
      description: "Automates browser interactions and returns structured observations.",
    },
    promptContribution: {
      instructions:
        "Use Web Stack Browser for tasks that require interacting with or inspecting a rendered web page. Supply only its finite structured actions, never JavaScript, shell commands, paths, environment variables, or secrets, and report observed outcomes.",
    },
    permissionRequirements: ["browser.automation", "network.read"],
    secretRequirements: [],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["actions"],
      properties: {
        actions: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: {
            oneOf: [
              {
                type: "object",
                additionalProperties: false,
                required: ["action", "url"],
                properties: {
                  action: { const: "navigate" },
                  url: { type: "string", minLength: 1, maxLength: 8000, pattern: "\\S" },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["action"],
                properties: { action: { const: "observe" } },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["action", "target"],
                properties: {
                  action: { const: "click" },
                  target: BROWSER_TARGET_SCHEMA,
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["action", "target", "value"],
                properties: {
                  action: { const: "fill" },
                  target: BROWSER_TARGET_SCHEMA,
                  value: { type: "string", maxLength: 8000 },
                },
              },
              {
                type: "object",
                additionalProperties: false,
                required: ["action", "target", "key"],
                properties: {
                  action: { const: "press" },
                  target: BROWSER_TARGET_SCHEMA,
                  key: { type: "string", minLength: 1, maxLength: 200, pattern: "\\S" },
                },
              },
            ],
          },
        },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 300000 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["observations"],
      properties: {
        observations: {
          type: "array",
          maxItems: 200,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["description"],
            properties: {
              description: { type: "string", minLength: 1, maxLength: 8000 },
              url: { type: "string", maxLength: 8000 },
            },
          },
        },
      },
    },
    supportedAdapters: ALL_ADAPTERS,
  },
] as const;

const decodeManifest = Schema.decodeUnknownSync(CapabilityManifestV1);

export const builtInCapabilityManifests: ReadonlyArray<CapabilityManifestV1> = Object.freeze(
  BUILT_IN_MANIFEST_LITERALS.map((manifest) => decodeManifest(manifest)),
);
