const vorgangSchema = {
  version: 1,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 180 },
    title: { type: "string" },
    status: { type: "string" },
    kunde_id: { type: "string" },
    kunde_name: { type: "string" },
    quelle_json: { type: "object" },
    triage_json: { type: "object" },
    run_json: { type: "object" },
    mails_json: { type: "array" },
    audit_json: { type: "array" },
    notes: { type: "string" },
    is_deleted: { type: "boolean" },
    created_at_ms: { type: "number" },
    updated_at_ms: { type: "number" },
  },
  required: ["id", "title", "status", "is_deleted", "created_at_ms", "updated_at_ms"],
  additionalProperties: true,
};

const entscheidungSchema = {
  version: 1,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 180 },
    vorgang_id: { type: "string" },
    typ: { type: "string" },
    titel: { type: "string" },
    zeilen_json: { type: "array" },
    detail_seiten_json: { type: "array" },
    aktionen_json: { type: "array" },
    backing_ref: { type: "string" },
    status: { type: "string" },
    antwort_json: { type: "object" },
    is_deleted: { type: "boolean" },
    created_at_ms: { type: "number" },
    updated_at_ms: { type: "number" },
  },
  required: [
    "id",
    "vorgang_id",
    "typ",
    "titel",
    "status",
    "is_deleted",
    "created_at_ms",
    "updated_at_ms",
  ],
  additionalProperties: true,
};

const projektSchema = {
  version: 1,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 180 },
    name: { type: "string" },
    adressen_json: { type: "array" },
    domains_json: { type: "array" },
    code_projekt: { type: "string" },
    notizen: { type: "string" },
    aktiv: { type: "boolean" },
    is_deleted: { type: "boolean" },
    created_at_ms: { type: "number" },
    updated_at_ms: { type: "number" },
  },
  required: ["id", "name", "is_deleted", "created_at_ms", "updated_at_ms"],
  additionalProperties: true,
};

export const collections = {
  kundenpipeline_vorgaenge: vorgangSchema,
  kundenpipeline_entscheidungen: entscheidungSchema,
  kundenpipeline_projekte: projektSchema,
};
export const migrationStrategies = {};
