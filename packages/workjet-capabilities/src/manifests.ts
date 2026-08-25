import { CapabilityManifest } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  WEB_BROWSER_AUTOMATE_TOOL_CONTRACT,
  WEB_BROWSER_PREPARE_TOOL_CONTRACT,
  WEB_DEEP_RESEARCH_TOOL_CONTRACT,
  WEB_READ_TOOL_CONTRACT,
  WEB_SEARCH_TOOL_CONTRACT,
} from "./generated/web-stack-tools.v1.ts";
import { DECISION_HUB_SKILL_PROMPT } from "./generated/decision-hub-skill.ts";

const ALL_ADAPTERS = [
  "t3-mcp",
  "t3-prompt",
  "ctox-business-os-mcp",
  "ctox-business-command",
] as const;

export const WEB_SEARCH_INPUT_SCHEMA = WEB_SEARCH_TOOL_CONTRACT.inputSchema;
export const WEB_SEARCH_OUTPUT_SCHEMA = WEB_SEARCH_TOOL_CONTRACT.outputSchema;
export const WEB_READ_INPUT_SCHEMA = WEB_READ_TOOL_CONTRACT.inputSchema;
export const WEB_READ_OUTPUT_SCHEMA = WEB_READ_TOOL_CONTRACT.outputSchema;
export const WEB_DEEP_RESEARCH_INPUT_SCHEMA = WEB_DEEP_RESEARCH_TOOL_CONTRACT.inputSchema;
export const WEB_DEEP_RESEARCH_OUTPUT_SCHEMA = WEB_DEEP_RESEARCH_TOOL_CONTRACT.outputSchema;
export const WEB_BROWSER_PREPARE_INPUT_SCHEMA = WEB_BROWSER_PREPARE_TOOL_CONTRACT.inputSchema;
export const WEB_BROWSER_PREPARE_OUTPUT_SCHEMA = WEB_BROWSER_PREPARE_TOOL_CONTRACT.outputSchema;
export const WEB_BROWSER_AUTOMATE_INPUT_SCHEMA = WEB_BROWSER_AUTOMATE_TOOL_CONTRACT.inputSchema;
export const WEB_BROWSER_AUTOMATE_OUTPUT_SCHEMA = WEB_BROWSER_AUTOMATE_TOOL_CONTRACT.outputSchema;

const BUILT_IN_MANIFEST_LITERALS = [
  {
    schemaVersion: 2,
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
    activationPolicy: {
      allowedRoles: ["standard", "orchestrator", "worker"],
      childDelegation: "allowed",
      requiredBinding: null,
    },
  },
  {
    schemaVersion: 2,
    id: WEB_SEARCH_TOOL_CONTRACT.capabilityId,
    version: WEB_SEARCH_TOOL_CONTRACT.contractVersion,
    metadata: {
      displayName: WEB_SEARCH_TOOL_CONTRACT.annotations.title,
      description: WEB_SEARCH_TOOL_CONTRACT.description,
    },
    promptContribution: {
      instructions:
        "Use Web Search to discover current or externally published information, read specific public pages, or perform bounded deep research, and ground conclusions in the returned evidence.",
    },
    permissionRequirements: ["network.search", "network.read"],
    secretRequirements: [],
    inputSchema: WEB_SEARCH_INPUT_SCHEMA,
    outputSchema: WEB_SEARCH_OUTPUT_SCHEMA,
    supportedAdapters: ALL_ADAPTERS,
    activationPolicy: {
      allowedRoles: ["standard", "orchestrator", "worker"],
      childDelegation: "allowed",
      requiredBinding: null,
    },
  },
  {
    schemaVersion: 2,
    id: WEB_BROWSER_AUTOMATE_TOOL_CONTRACT.capabilityId,
    version: WEB_BROWSER_AUTOMATE_TOOL_CONTRACT.contractVersion,
    metadata: {
      displayName: WEB_BROWSER_AUTOMATE_TOOL_CONTRACT.annotations.title,
      description: WEB_BROWSER_AUTOMATE_TOOL_CONTRACT.description,
    },
    promptContribution: {
      instructions:
        "Use Web Stack Browser for tasks that require interacting with or inspecting a rendered web page. Supply only its finite structured actions, never JavaScript, shell commands, paths, environment variables, or secrets, and report observed outcomes.",
    },
    permissionRequirements: ["browser.automation", "network.read"],
    secretRequirements: [],
    inputSchema: WEB_BROWSER_AUTOMATE_INPUT_SCHEMA,
    outputSchema: WEB_BROWSER_AUTOMATE_OUTPUT_SCHEMA,
    supportedAdapters: ALL_ADAPTERS,
    activationPolicy: {
      allowedRoles: ["standard", "orchestrator", "worker"],
      childDelegation: "allowed",
      requiredBinding: null,
    },
  },
  {
    schemaVersion: 2,
    id: "decision-hub",
    version: "1.0.0",
    metadata: {
      displayName: "Decision Hub",
      description: "Escalates a blocking owner choice to a bound CTOX Decision Hub instance.",
    },
    promptContribution: { instructions: DECISION_HUB_SKILL_PROMPT },
    permissionRequirements: ["network.read"],
    secretRequirements: [],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["decisionKey", "title", "question", "context", "options", "urgency"],
      properties: {
        decisionKey: { type: "string", minLength: 1, maxLength: 200 },
        title: { type: "string", minLength: 1, maxLength: 160 },
        question: { type: "string", minLength: 1, maxLength: 2000 },
        context: { type: "string", maxLength: 8000 },
        options: {
          type: "array",
          minItems: 2,
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "label", "description"],
            properties: {
              id: { type: "string", minLength: 1, maxLength: 100 },
              label: { type: "string", minLength: 1, maxLength: 120 },
              description: { type: "string", maxLength: 1000 },
            },
          },
        },
        recommendationOptionId: { type: "string", minLength: 1, maxLength: 100 },
        urgency: { type: "string", enum: ["normal", "high", "critical"] },
        expiresAt: { type: "string", format: "date-time" },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["decisionId", "status"],
      properties: {
        decisionId: { type: "string", minLength: 1, maxLength: 200 },
        status: { type: "string", enum: ["open", "resolved", "expired"] },
      },
    },
    supportedAdapters: ["t3-mcp", "t3-prompt"],
    activationPolicy: {
      allowedRoles: ["standard", "orchestrator"],
      childDelegation: "forbidden",
      requiredBinding: "ctox-connection",
    },
  },
] as const;

const decodeManifest = Schema.decodeUnknownSync(CapabilityManifest);

export const builtInCapabilityManifests: ReadonlyArray<CapabilityManifest> = Object.freeze(
  BUILT_IN_MANIFEST_LITERALS.map((manifest) => decodeManifest(manifest)),
);
