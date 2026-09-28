import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { WorkjetProjectFile, WORKJET_PROJECT_FILE_SCHEMA_URL } from "@workjet/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `workjet.json` file contents (lenient JSONC string) and the
 * decoded {@link WorkjetProjectFile}.
 */
export const WorkjetProjectFileFromJson = fromLenientJson(WorkjetProjectFile);

const decodeWorkjetProjectFile = Schema.decodeExit(WorkjetProjectFileFromJson);

/**
 * Decode raw `workjet.json` contents, treating invalid or malformed files as
 * absent. Clients use this to read optional defaults (scripts, thread env
 * mode) without surfacing decode errors to the user.
 */
export function parseWorkjetProjectFile(contents: string): WorkjetProjectFile | null {
  const decoded = decodeWorkjetProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

/**
 * Build the publishable JSON Schema document for `workjet.json` (draft 2020-12).
 *
 * Served from the marketing site at {@link WORKJET_PROJECT_FILE_SCHEMA_URL} so
 * editors get LSP support via a `$schema` reference.
 */
export function buildWorkjetProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(WorkjetProjectFile);
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: WORKJET_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
