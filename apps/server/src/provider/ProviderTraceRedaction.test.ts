// @effect-diagnostics nodeBuiltinImport:off - the invariant is proved by reading the provider layer's own source.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { assert, describe, it } from "@effect/vitest";

/**
 * THE PROVIDER SPAN-ATTRIBUTE INVENTORY
 * (docs/workjet-plan.md → "Security invariants": "Redact provider traffic
 * metadata and never log request bodies by default").
 *
 * WHY AN INVENTORY AND NOT A BEHAVIOURAL TEST.
 *
 * Everything a provider span is annotated with lands verbatim in
 * `<stateDir>/logs/server.trace.ndjson` (`Observability.ts:32-45` installs the
 * file sink; `packages/shared/src/observability.ts:306-336` writes the whole
 * `attributes` object). The only bound on that path is
 * `truncateTraceAttributes`, which CLAMPS strings to 500 characters and redacts
 * nothing — a 400-character credential passes through intact.
 *
 * So the surface has to be enumerated rather than sampled. This is the same
 * two-way diff `DesktopSupportBundle.test.ts` runs against
 * `SUPPORT_BUNDLE_FIELD_INVENTORY`: an undeclared attribute fails, and a
 * declaration for an attribute that no longer exists fails too, so the list
 * cannot rot into a rubber stamp.
 *
 * A real leak was found this way: `claude.query.extra_args_json` serialized the
 * operator's whole `launchArgs` record — flag names AND values — into a span.
 * It is now `claude.query.extra_arg_names`, names only.
 *
 * Mutation-verified: adding an attribute, removing one, or re-introducing a
 * JSON serialization of a provider-supplied structure fails this test.
 */

const providerDir = fileURLToPath(new URL("./", import.meta.url));

/**
 * Every span attribute the provider layer sets, with why it is safe to write to
 * a trace file. "Safe" means: an id, an enum, a count, a boolean, or a
 * host-chosen path — never provider request content and never a credential.
 */
const DECLARED_SPAN_ATTRIBUTES: Readonly<Record<string, string>> = {
  "provider.kind": "enum: the driver name",
  "provider.operation": "enum: the service method",
  "provider.instance_id": "id",
  "provider.thread_id": "id",
  "provider.turn_id": "id",
  "provider.request_id": "id",
  "provider.runtime_mode": "enum",
  "provider.interaction_mode": "enum",
  "provider.attachment_count": "count",
  "provider.rollback_turns": "count",
  "provider.resume_cursor.source": "enum",
  "provider.resume_cursor.present": "boolean",
  "provider.cwd.source": "enum",
  "provider.cwd.effective": "host-chosen filesystem path, not provider content",
  "claude.resume.source": "enum",
  "claude.resume.thread_id": "id",
  "claude.resume.session_id": "id",
  "claude.resume.session_at": "timestamp",
  "claude.resume.turn_count": "count",
  "claude.query.cwd": "host-chosen filesystem path",
  "claude.query.model": "enum: the resolved API model id",
  "claude.query.effort": "enum",
  "claude.query.permission_mode": "enum",
  "claude.query.allow_dangerously_skip_permissions": "boolean",
  "claude.query.resume": "id",
  "claude.query.session_id": "id",
  "claude.query.include_partial_messages": "boolean",
  "claude.query.additional_directories": "host-chosen filesystem paths",
  "claude.query.setting_sources": "a fixed constant list",
  "claude.query.settings_json": "see DECLARED_JSON_ATTRIBUTES",
  "claude.query.extra_arg_names":
    "the NAMES of the operator's extra launch flags, never their values",
  "claude.query.path_to_executable": "host-chosen filesystem path",
};

/**
 * The attributes that serialize a structure. Each needs a reason, because a
 * serialized structure is how content gets into a trace by accident.
 * `claude.query.extra_args_json` used to be here and was a real leak.
 */
const DECLARED_JSON_ATTRIBUTES: Readonly<Record<string, string>> = {
  "claude.query.settings_json":
    "`settings` is built locally from three booleans (ClaudeAdapter.ts) — no provider or operator string reaches it",
};

/** A key whose name alone says it would carry request content or a credential. */
const FORBIDDEN_KEY_SHAPE =
  /(prompt|message|body|token|secret|credential|header|authorization|api_?key|cookie|payload)/i;

/**
 * Keys that trip {@link FORBIDDEN_KEY_SHAPE} on a word that is not about
 * content. Each needs its own reason: weakening the pattern instead would blunt
 * it for every future attribute.
 */
const SHAPE_EXEMPTIONS: Readonly<Record<string, string>> = {
  "claude.query.include_partial_messages":
    "a boolean streaming flag — 'messages' names the mode, not any message",
};

const productionSources = (dir: string): ReadonlyArray<{ file: string; source: string }> => {
  const found: Array<{ file: string; source: string }> = [];
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...productionSources(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      found.push({
        file: NodePath.relative(providerDir, full),
        source: NodeFS.readFileSync(full, "utf8"),
      });
    }
  }
  return found;
};

/** The `{ … }` object literal that follows an `annotateCurrentSpan(` call. */
const annotationBlocks = (source: string): ReadonlyArray<string> => {
  const blocks: Array<string> = [];
  const marker = "Effect.annotateCurrentSpan({";
  for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
    const open = at + marker.length - 1;
    let depth = 0;
    for (let cursor = open; cursor < source.length; cursor += 1) {
      const character = source[cursor];
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          blocks.push(source.slice(open, cursor + 1));
          break;
        }
      }
    }
  }
  return blocks;
};

const attributeEntries = (): ReadonlyArray<{
  readonly file: string;
  readonly key: string;
  readonly value: string;
}> => {
  const entries: Array<{ file: string; key: string; value: string }> = [];
  for (const { file, source } of productionSources(providerDir)) {
    for (const block of annotationBlocks(source)) {
      for (const line of block.split("\n")) {
        const match = /^\s+"([^"]+)":\s*(.*?),?\s*$/.exec(line);
        if (match?.[1] !== undefined) entries.push({ file, key: match[1], value: match[2] ?? "" });
      }
    }
  }
  return entries;
};

describe("provider trace redaction", () => {
  it("declares every span attribute the provider layer writes to the trace file", () => {
    const observed = new Set(attributeEntries().map(({ key }) => key));
    const declared = new Set(Object.keys(DECLARED_SPAN_ATTRIBUTES));

    assert.deepEqual(
      [...observed].filter((key) => !declared.has(key)).sort(),
      [],
      "an undeclared provider span attribute reaches server.trace.ndjson",
    );
    assert.deepEqual(
      [...declared].filter((key) => !observed.has(key)).sort(),
      [],
      "a declared attribute no longer exists: the inventory must not rot",
    );
  });

  it("names no span attribute after a request body, prompt, or credential", () => {
    for (const key of Object.keys(DECLARED_SPAN_ATTRIBUTES)) {
      if (key in SHAPE_EXEMPTIONS) continue;
      assert.notMatch(
        key,
        FORBIDDEN_KEY_SHAPE,
        `${key} names provider request content or a credential`,
      );
    }
    // An exemption for an attribute that no longer exists is a stale excuse.
    assert.deepEqual(
      Object.keys(SHAPE_EXEMPTIONS).filter((key) => !(key in DECLARED_SPAN_ATTRIBUTES)),
      [],
    );
  });

  it("serializes a structure into a span only where that is declared and justified", () => {
    const serializing = attributeEntries().filter(({ value }) =>
      value.includes("encodeJsonStringForDiagnostics("),
    );
    assert.deepEqual(
      serializing.map(({ key }) => key).sort(),
      Object.keys(DECLARED_JSON_ATTRIBUTES).sort(),
      "a span attribute serializes a structure without a declared justification",
    );
    // The operator's launch flags in particular: names may be traced, the
    // values behind them may not.
    const launchArgs = attributeEntries().find(({ key }) =>
      key.startsWith("claude.query.extra_arg"),
    );
    assert.exists(launchArgs);
    assert.strictEqual(launchArgs?.key, "claude.query.extra_arg_names");
    assert.include(launchArgs?.value ?? "", "Object.keys(extraArgs)");
  });
});
