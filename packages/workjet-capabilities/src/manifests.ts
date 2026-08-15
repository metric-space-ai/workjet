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

const BOUNDED_STRING = (maxLength: number) => ({ type: "string", maxLength }) as const;
const SAFE_UNSIGNED_INTEGER = {
  type: "integer",
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
} as const;
const SAFE_INTEGER = {
  type: "integer",
  minimum: Number.MIN_SAFE_INTEGER,
  maximum: Number.MAX_SAFE_INTEGER,
} as const;
const BOUNDED_STRING_ARRAY = (maxItems: number, maxLength: number) =>
  ({
    type: "array",
    maxItems,
    items: BOUNDED_STRING(maxLength),
  }) as const;

const WEB_READ_RESPONSE_METADATA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["redirectChain"],
  properties: {
    requestedUrl: BOUNDED_STRING(8_000),
    finalUrl: BOUNDED_STRING(8_000),
    status: SAFE_UNSIGNED_INTEGER,
    contentType: BOUNDED_STRING(1_000),
    byteCount: SAFE_UNSIGNED_INTEGER,
    sha256: BOUNDED_STRING(1_000),
    contentKind: BOUNDED_STRING(1_000),
    redirected: { type: "boolean" },
    redirectChain: BOUNDED_STRING_ARRAY(100, 8_000),
    lineage: BOUNDED_STRING(16_000),
    admissionRejectionReason: BOUNDED_STRING(2_000),
  },
} as const;

const WEB_READ_EXTRACTED_FIELDS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fields"],
  properties: {
    sourceId: BOUNDED_STRING(1_000),
    tier: BOUNDED_STRING(1_000),
    fields: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "value"],
        properties: {
          field: BOUNDED_STRING(1_000),
          value: BOUNDED_STRING(4_000),
          confidence: BOUNDED_STRING(1_000),
          note: BOUNDED_STRING(2_000),
          sourceUrl: BOUNDED_STRING(8_000),
        },
      },
    },
  },
} as const;

export const WEB_READ_OUTPUT_SCHEMA = {
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
    requestedUrl: BOUNDED_STRING(8_000),
    canonicalUrl: BOUNDED_STRING(8_000),
    finalUrl: BOUNDED_STRING(8_000),
    title: BOUNDED_STRING(2_000),
    summary: BOUNDED_STRING(16_000),
    pageTextExcerpt: BOUNDED_STRING(16_000),
    isPdf: { type: "boolean" },
    pdfTotalPages: SAFE_UNSIGNED_INTEGER,
    redirected: { type: "boolean" },
    redirectChain: BOUNDED_STRING_ARRAY(100, 8_000),
    lineage: BOUNDED_STRING(16_000),
    verificationStatus: BOUNDED_STRING(1_000),
    checkedAt: SAFE_UNSIGNED_INTEGER,
    httpStatus: SAFE_UNSIGNED_INTEGER,
    snapshotHash: BOUNDED_STRING(1_000),
    contentType: BOUNDED_STRING(1_000),
    byteCount: SAFE_UNSIGNED_INTEGER,
    responseContentKind: BOUNDED_STRING(1_000),
    responseMetadata: WEB_READ_RESPONSE_METADATA_SCHEMA,
    excerpts: BOUNDED_STRING_ARRAY(100, 2_000),
    findMatches: {
      type: "array",
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pattern", "matches"],
        properties: {
          pattern: BOUNDED_STRING(1_000),
          matches: BOUNDED_STRING_ARRAY(16, 2_000),
        },
      },
    },
    pageSections: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: {
          pageNumber: SAFE_UNSIGNED_INTEGER,
          text: BOUNDED_STRING(4_000),
        },
      },
    },
    sourceTier: BOUNDED_STRING(1_000),
    transportEvidenceEligible: { type: "boolean" },
    evidenceEligible: { type: "boolean" },
    evidenceRelevanceScore: SAFE_INTEGER,
    evidenceRejectionReason: BOUNDED_STRING(2_000),
    evidenceContentKind: BOUNDED_STRING(1_000),
    datasetContentExtracted: { type: "boolean" },
    extractedFields: WEB_READ_EXTRACTED_FIELDS_SCHEMA,
  },
} as const;

const WEB_RESEARCH_SOURCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "canonicalUrl",
    "transportVerified",
    "contentExtracted",
    "actualFullTextOrData",
    "evidenceEligible",
    "excerpts",
  ],
  properties: {
    title: BOUNDED_STRING(2_000),
    canonicalUrl: BOUNDED_STRING(8_000),
    domain: BOUNDED_STRING(1_000),
    summary: BOUNDED_STRING(4_000),
    sourceType: BOUNDED_STRING(1_000),
    doi: BOUNDED_STRING(1_000),
    verificationStatus: BOUNDED_STRING(1_000),
    checkedAt: SAFE_UNSIGNED_INTEGER,
    httpStatus: SAFE_UNSIGNED_INTEGER,
    snapshotHash: BOUNDED_STRING(1_000),
    transportVerified: { type: "boolean" },
    contentExtracted: { type: "boolean" },
    actualFullTextOrData: { type: "boolean" },
    evidenceEligible: { type: "boolean" },
    evidenceRelevanceScore: SAFE_INTEGER,
    evidenceRejectionReason: BOUNDED_STRING(2_000),
    responseContentKind: BOUNDED_STRING(1_000),
    dataValidationStatus: BOUNDED_STRING(1_000),
    pageTextExcerpt: BOUNDED_STRING(4_000),
    excerpts: BOUNDED_STRING_ARRAY(8, 2_000),
  },
} as const;

const WEB_RESEARCH_COUNT_NAMES = [
  "planned_search_queries",
  "executed_search_queries",
  "database_queries",
  "discovered_source_candidates",
  "candidate_pool_limit",
  "deduplicated_sources",
  "verified_sources",
  "rejected_source_candidates",
  "read_budget",
  "followup_read_budget",
  "read_attempts",
  "followed_data_links",
  "sources_with_page_read_attempts",
  "successful_page_reads",
  "failed_page_reads",
  "figure_candidates",
  "estimated_external_fetches",
] as const;

export const WEB_DEEP_RESEARCH_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "operation",
    "query",
    "depth",
    "maxSources",
    "evidenceStatus",
    "verifiedSources",
    "blockedSources",
    "systematicCoverage",
    "researchCallCounts",
    "reportScaffold",
    "workspacePersisted",
  ],
  properties: {
    operation: { const: "deepResearch" },
    query: BOUNDED_STRING(4_000),
    focus: BOUNDED_STRING(4_000),
    depth: { type: "string", enum: ["quick", "standard", "exhaustive"] },
    maxSources: { type: "integer", minimum: 3, maximum: 100 },
    evidenceStatus: {
      type: "string",
      enum: ["no_verified_sources", "verified_sources_available"],
    },
    verifiedSources: {
      type: "array",
      maxItems: 100,
      items: WEB_RESEARCH_SOURCE_SCHEMA,
    },
    blockedSources: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["canonicalUrl"],
        properties: {
          title: BOUNDED_STRING(2_000),
          canonicalUrl: BOUNDED_STRING(8_000),
          blockedResponseUrl: BOUNDED_STRING(8_000),
          reason: BOUNDED_STRING(2_000),
          doi: BOUNDED_STRING(1_000),
          nextAction: BOUNDED_STRING(4_000),
        },
      },
    },
    systematicCoverage: {
      type: "object",
      additionalProperties: false,
      required: [
        "plannedFacets",
        "successfulFacets",
        "uncoveredFacets",
        "excludedExistingUrlCount",
        "verifiedPrimaryDataSources",
        "verifiedScholarlyFullTextSources",
        "hashBoundVerifiedSources",
        "independentVerifiedDomains",
        "remainingGaps",
        "complete",
      ],
      properties: {
        plannedFacets: BOUNDED_STRING_ARRAY(100, 1_000),
        successfulFacets: BOUNDED_STRING_ARRAY(100, 1_000),
        uncoveredFacets: BOUNDED_STRING_ARRAY(100, 1_000),
        excludedExistingUrlCount: { type: "integer", minimum: 0, maximum: 100 },
        verifiedPrimaryDataSources: { type: "integer", minimum: 0, maximum: 100 },
        verifiedScholarlyFullTextSources: { type: "integer", minimum: 0, maximum: 100 },
        hashBoundVerifiedSources: { type: "integer", minimum: 0, maximum: 100 },
        independentVerifiedDomains: BOUNDED_STRING_ARRAY(100, 1_000),
        remainingGaps: BOUNDED_STRING_ARRAY(100, 1_000),
        complete: { type: "boolean" },
      },
    },
    researchCallCounts: {
      type: "object",
      additionalProperties: false,
      required: WEB_RESEARCH_COUNT_NAMES,
      properties: Object.fromEntries(
        WEB_RESEARCH_COUNT_NAMES.map((name) => [name, SAFE_UNSIGNED_INTEGER]),
      ) as Record<(typeof WEB_RESEARCH_COUNT_NAMES)[number], typeof SAFE_UNSIGNED_INTEGER>,
    },
    reportScaffold: {
      type: "object",
      additionalProperties: false,
      required: ["recommendedSections", "evaluationAxes", "synthesisInstruction"],
      properties: {
        recommendedSections: BOUNDED_STRING_ARRAY(100, 2_000),
        evaluationAxes: BOUNDED_STRING_ARRAY(100, 2_000),
        synthesisInstruction: BOUNDED_STRING(16_000),
      },
    },
    workspacePersisted: { type: "boolean" },
    workspaceId: {
      type: "string",
      minLength: 25,
      maxLength: 25,
      pattern: "^research-[0-9a-f]{16}$",
    },
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
