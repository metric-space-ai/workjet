import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

const CONTRACT_URL = new URL(
  "../../../native/web-stack/schema/web-stack-tools.v1.json",
  import.meta.url,
);
const OUTPUT_URL = new URL("../src/generated/web-stack-tools.v1.ts", import.meta.url);

const TOOL_NAMES = [
  "web_search",
  "web_read",
  "web_deep_research",
  "web_browser_prepare",
  "web_browser_automate",
];

const EXPECTED_TOOLS = {
  web_search: {
    capabilityId: "web-search",
    annotations: {
      title: "Web Search",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  web_read: {
    capabilityId: "web-search",
    annotations: {
      title: "Read Web Page",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  web_deep_research: {
    capabilityId: "web-search",
    annotations: {
      title: "Deep Web Research",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  web_browser_prepare: {
    capabilityId: "web-stack-browser",
    annotations: {
      title: "Prepare Web Browser",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  web_browser_automate: {
    capabilityId: "web-stack-browser",
    annotations: {
      title: "Web Stack Browser",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
};

const FORBIDDEN_FIELD_NAMES = new Set([
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

const ROOT_KEYS = ["schemaVersion", "tools"];
const TOOL_KEYS = [
  "name",
  "capabilityId",
  "contractVersion",
  "description",
  "annotations",
  "inputSchema",
  "outputSchema",
];
const ANNOTATION_KEYS = [
  "title",
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
];

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const assertExactKeys = (value, expected, location) => {
  if (!isRecord(value)) throw new Error(`${location} must be an object.`);
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some((key) => !actual.includes(key))) {
    throw new Error(`${location} must contain exactly: ${expected.join(", ")}.`);
  }
};

const assertEqualRecord = (actual, expected, location) => {
  assertExactKeys(actual, Object.keys(expected), location);
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      throw new Error(`${location}.${key} must be ${JSON.stringify(value)}.`);
    }
  }
};

const validateSchemaNode = (node, location) => {
  if (Array.isArray(node)) {
    node.forEach((child, index) => validateSchemaNode(child, `${location}[${index}]`));
    return;
  }
  if (!isRecord(node)) return;

  const hasObjectKeywords =
    node.type === "object" ||
    Object.hasOwn(node, "properties") ||
    Object.hasOwn(node, "additionalProperties");
  if (hasObjectKeywords) {
    if (node.type !== "object") {
      throw new Error(`${location} uses object keywords without type object.`);
    }
    if (node.additionalProperties !== false) {
      throw new Error(`${location} is an open object schema.`);
    }
    if (!isRecord(node.properties)) {
      throw new Error(`${location}.properties must be an object.`);
    }
    const propertyNames = Object.keys(node.properties);
    for (const fieldName of propertyNames) {
      if (FORBIDDEN_FIELD_NAMES.has(fieldName)) {
        throw new Error(`${location}.properties contains forbidden field ${fieldName}.`);
      }
    }
    if (Object.hasOwn(node, "required")) {
      if (
        !Array.isArray(node.required) ||
        node.required.some(
          (fieldName) => typeof fieldName !== "string" || !propertyNames.includes(fieldName),
        )
      ) {
        throw new Error(`${location}.required must contain only declared property names.`);
      }
    }
  }

  for (const [key, child] of Object.entries(node)) {
    validateSchemaNode(child, `${location}.${key}`);
  }
};

const validateSchema = (schema, location) => {
  if (!isRecord(schema) || schema.type !== "object") {
    throw new Error(`${location} must be an object schema.`);
  }
  validateSchemaNode(schema, location);
};

const validateBrowserActions = (tool) => {
  const alternatives = tool.inputSchema?.properties?.actions?.items?.oneOf;
  if (!Array.isArray(alternatives)) {
    throw new Error("web_browser_automate actions must use oneOf.");
  }
  const actions = alternatives.map((alternative) => alternative?.properties?.action?.const);
  const expected = ["navigate", "observe", "click", "fill", "press"];
  if (JSON.stringify(actions) !== JSON.stringify(expected)) {
    throw new Error(`web_browser_automate actions must be exactly: ${expected.join(", ")}.`);
  }
};

const validateContract = (contract) => {
  assertExactKeys(contract, ROOT_KEYS, "contract");
  if (contract.schemaVersion !== 1) throw new Error("contract.schemaVersion must be 1.");
  if (!Array.isArray(contract.tools)) throw new Error("contract.tools must be an array.");
  if (contract.tools.length !== TOOL_NAMES.length) {
    throw new Error(`contract.tools must contain exactly ${TOOL_NAMES.length} tools.`);
  }

  const names = contract.tools.map((tool) => tool?.name);
  if (new Set(names).size !== names.length) throw new Error("contract.tools has duplicate names.");
  const unknown = names.filter((name) => !TOOL_NAMES.includes(name));
  if (unknown.length > 0)
    throw new Error(`contract.tools has unknown names: ${unknown.join(", ")}.`);
  const missing = TOOL_NAMES.filter((name) => !names.includes(name));
  if (missing.length > 0)
    throw new Error(`contract.tools is missing names: ${missing.join(", ")}.`);
  if (JSON.stringify(names) !== JSON.stringify(TOOL_NAMES)) {
    throw new Error(`contract.tools must be ordered: ${TOOL_NAMES.join(", ")}.`);
  }

  for (const [index, tool] of contract.tools.entries()) {
    const location = `contract.tools[${index}]`;
    assertExactKeys(tool, TOOL_KEYS, location);
    const expected = EXPECTED_TOOLS[tool.name];
    if (tool.capabilityId !== expected.capabilityId) {
      throw new Error(`${location}.capabilityId must be ${expected.capabilityId}.`);
    }
    if (tool.contractVersion !== "1.0.0") {
      throw new Error(`${location}.contractVersion must be 1.0.0.`);
    }
    if (typeof tool.description !== "string" || tool.description.trim() === "") {
      throw new Error(`${location}.description must be a non-empty string.`);
    }
    assertExactKeys(tool.annotations, ANNOTATION_KEYS, `${location}.annotations`);
    assertEqualRecord(tool.annotations, expected.annotations, `${location}.annotations`);
    validateSchema(tool.inputSchema, `${location}.inputSchema`);
    validateSchema(tool.outputSchema, `${location}.outputSchema`);
  }

  validateBrowserActions(contract.tools[4]);
};

const render = (contract) => `// This file is generated by scripts/generate-web-stack-contract.mjs.
// Do not edit it directly; edit native/web-stack/schema/web-stack-tools.v1.json.

export type WebStackToolName =
  | "web_search"
  | "web_read"
  | "web_deep_research"
  | "web_browser_prepare"
  | "web_browser_automate";

export type WebStackCapabilityId = "web-search" | "web-stack-browser";

export type WebStackJsonPrimitive = string | number | boolean | null;
export type WebStackJsonValue =
  | WebStackJsonPrimitive
  | WebStackJsonObject
  | readonly WebStackJsonValue[];
export interface WebStackJsonObject {
  readonly [key: string]: WebStackJsonValue;
}

export interface WebStackMcpAnnotations {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface WebStackToolContract {
  readonly name: WebStackToolName;
  readonly capabilityId: WebStackCapabilityId;
  readonly contractVersion: "1.0.0";
  readonly description: string;
  readonly annotations: WebStackMcpAnnotations;
  readonly inputSchema: WebStackJsonObject;
  readonly outputSchema: WebStackJsonObject;
}

export interface WebStackToolContractDocument {
  readonly schemaVersion: 1;
  readonly tools: readonly [
    WebStackToolContract,
    WebStackToolContract,
    WebStackToolContract,
    WebStackToolContract,
    WebStackToolContract,
  ];
}

// prettier-ignore
export const WEB_STACK_TOOL_CONTRACT = ${JSON.stringify(contract, null, 2)} as const satisfies WebStackToolContractDocument;

export const WEB_STACK_TOOLS = WEB_STACK_TOOL_CONTRACT.tools;

export const [
  WEB_SEARCH_TOOL_CONTRACT,
  WEB_READ_TOOL_CONTRACT,
  WEB_DEEP_RESEARCH_TOOL_CONTRACT,
  WEB_BROWSER_PREPARE_TOOL_CONTRACT,
  WEB_BROWSER_AUTOMATE_TOOL_CONTRACT,
] = WEB_STACK_TOOLS;
`;

const main = async () => {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    throw new Error("Usage: generate-web-stack-contract.mjs [--check]");
  }

  const source = await NodeFSP.readFile(CONTRACT_URL, "utf8");
  let contract;
  try {
    contract = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in ${NodeURL.fileURLToPath(CONTRACT_URL)}.`, {
      cause: error,
    });
  }
  validateContract(contract);
  const generated = render(contract);

  if (args[0] === "--check") {
    let current;
    try {
      current = await NodeFSP.readFile(OUTPUT_URL, "utf8");
    } catch {
      throw new Error(`Generated contract is missing: ${NodeURL.fileURLToPath(OUTPUT_URL)}.`);
    }
    if (current !== generated) {
      throw new Error(
        `Generated contract has drifted. Run node ${NodeURL.fileURLToPath(import.meta.url)}.`,
      );
    }
    return;
  }

  await NodeFSP.writeFile(OUTPUT_URL, generated, "utf8");
};

await main();
