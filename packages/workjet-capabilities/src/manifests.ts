import { CapabilityManifestV1 } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const ALL_ADAPTERS = [
  "t3-mcp",
  "t3-prompt",
  "ctox-business-os-mcp",
  "ctox-business-command",
] as const;

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
      description: "Searches public web sources and returns structured results.",
    },
    promptContribution: {
      instructions:
        "Use Web Search when current or externally published information is needed, and ground conclusions in the returned sources.",
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
        "Use Web Stack Browser for tasks that require interacting with or inspecting a rendered web page, and report observed outcomes.",
    },
    permissionRequirements: ["browser.automation", "network.read"],
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
          description: "A plain-language browser task.",
        },
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
