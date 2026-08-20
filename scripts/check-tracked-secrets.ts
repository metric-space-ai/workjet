#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off -- The gate reads raw tracked bytes and asks Git for the file list before entering an Effect runtime.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  findSecretShapeMatches,
  SECRET_SHAPE_NAMES,
  SECRET_SHAPES,
  SOURCE_TREE_SECRET_SHAPES,
  type SecretShapeName,
} from "@t3tools/shared/secretShapes";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";

/**
 * THE TRACKED-FILE SECRET GATE.
 *
 * `docs/workjet-plan.md` carries the invariant "no raw provider, pairing,
 * capability, sudo, or SSH secrets in Git, browser storage, thread events,
 * instance registries, logs, crash reports, or support bundles". Every sink on
 * that list had a test except two, and GIT was one of them: the support-bundle
 * gate could be perfect and a key committed by hand would still be in the
 * history forever. This script is that sink's guard. It walks `git ls-files`
 * and fails when a tracked file carries committed secret material.
 *
 * It does NOT define what a secret looks like. The shapes come from
 * `@t3tools/shared/secretShapes`, the same table
 * `apps/desktop/src/support/SupportBundleRedaction.ts` redacts with, because a
 * second and drifting definition is worse than none — the copy that is not
 * updated becomes the one that leaks. What this script contributes is SCOPE:
 * which shapes survive contact with a whole source tree
 * (`SOURCE_TREE_SECRET_SHAPES`, and see each shape's `reason`), which paths are
 * outside the repository's own responsibility, and which individual files are
 * allowed to carry a planted fixture.
 *
 * Nothing it prints contains a secret. A finding is reported as shape, path,
 * line, length, and a four-character prefix; a gate that echoes the credential
 * into a CI log has moved the leak rather than closed it.
 */

/**
 * Path prefixes the gate does not scan, with the reason each is out of scope.
 * This is a SCOPE boundary, not an allow-list: an entry here says "these bytes
 * are not this repository's to vouch for", and it is deliberately tiny.
 */
export const SCAN_SCOPE_EXCLUSIONS: ReadonlyArray<{
  readonly prefix: string;
  readonly reason: string;
}> = [
  {
    prefix: ".repos/",
    reason:
      "Vendored read-only checkouts of third-party reference repositories, refreshed wholesale by `pnpm sync:repos`. They are 12,960 of the 17,870 tracked files, CI excludes them from the checkout (`!/.repos/` in every workflow's sparse-checkout), and `vp fmt` and `vp lint` already ignore them. Their TLS-fixture keys are upstream's published test material, not this repository's secrets, and no edit here can remove them.",
  },
];

/**
 * Files allowed to carry material that matches a secret shape, one entry per
 * file with the shapes it may match and why.
 *
 * Enumerated rather than wildcarded on purpose. `**\/*.test.ts` would be one
 * line and would also excuse a real key pasted into any test in the repository;
 * these three files are the ones that plant fake credentials BY DESIGN, to
 * prove the redaction gate removes them. An entry that stops matching anything
 * is an error, so the list cannot rot into a set of holes nobody remembers
 * opening.
 */
export const TRACKED_SECRET_ALLOWLIST: ReadonlyArray<{
  readonly path: string;
  readonly shapes: ReadonlyArray<SecretShapeName>;
  readonly reason: string;
}> = [
  {
    path: "apps/desktop/src/support/SupportBundleRedaction.test.ts",
    shapes: ["pem-private-key", "known-credential", "authorization-header"],
    reason:
      "The redaction gate's own canary table. Every match is a fake credential planted to prove `redactSupportText` removes it — a PEM block, an OpenSSH key body, `ghp_…`, `sk-ant-…`, a JWT, and a bearer header. Removing them would delete the test that proves the shapes are caught at all.",
  },
  {
    path: "apps/desktop/src/support/DesktopSupportBundle.test.ts",
    shapes: ["known-credential", "authorization-header"],
    reason:
      "Plants the same fake credentials into a real temporary state directory and asserts the assembled support bundle carries none of them. The canaries have to be literal for the assertion to mean anything.",
  },
  {
    path: "apps/desktop/src/support/DesktopCrashReporting.test.ts",
    shapes: ["known-credential"],
    reason:
      "Plants a fake `sk-ant-…` provider key in crash-report metadata and asserts it never reaches the uploaded extra fields.",
  },
];

/**
 * Files whose NAME says they hold credentials. These get the WHOLE table,
 * including the residue heuristics that are too noisy for source code: the
 * false-positive argument does not apply to a file that is supposed to contain
 * no code at all, and `.env` with a real value in it is the single most common
 * way a key reaches a repository.
 */
const CREDENTIAL_FILENAME =
  /(?:^|\/)(?:\.env(?:\.[^/]+)?|\.netrc|credentials(?:\.json)?|id_rsa[^/]*|id_ecdsa[^/]*|id_ed25519[^/]*|[^/]+\.(?:pem|key|p12|pfx|jks|keystore|ppk))$/u;

/**
 * …unless the name also says the file is a documented template. `.env.example`
 * exists to show which variables exist; its values are `...` and
 * `/absolute/path/to/x`, and the residue heuristics read both as credentials
 * (`PROFILE=/absolute/path/to/t3code` is 32 characters of the base64 alphabet).
 * A template is documentation, so it is scanned like documentation.
 */
const TEMPLATE_FILENAME = /\.(?:example|sample|template|dist)$/u;

export interface TrackedSecretFinding {
  readonly path: string;
  readonly shape: SecretShapeName;
  /** One-based line number of the match. */
  readonly line: number;
  /** Length of the matched text. The text itself is never carried. */
  readonly length: number;
  /** First four characters, so a human can recognize the shape at a glance. */
  readonly prefix: string;
}

export class TrackedSecretsFoundError extends Schema.TaggedErrorClass<TrackedSecretsFoundError>()(
  "TrackedSecretsFoundError",
  {
    findings: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        shape: Schema.String,
        line: Schema.Number,
        length: Schema.Number,
        prefix: Schema.String,
      }),
    ),
    staleAllowlistPaths: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const lines: Array<string> = [];
    if (this.findings.length > 0) {
      lines.push(
        `Tracked files carry ${this.findings.length} piece(s) of secret-shaped material.`,
        "Do NOT loosen the rule to make this pass. Remove the material, rotate the credential,",
        "and — only for a fixture that must stay literal — add an entry with a reason to",
        "TRACKED_SECRET_ALLOWLIST in scripts/check-tracked-secrets.ts.",
        ...this.findings.map(
          (finding) =>
            `  - ${finding.path}:${finding.line} [${finding.shape}] ${finding.length} chars starting "${finding.prefix}…"`,
        ),
      );
    }
    if (this.staleAllowlistPaths.length > 0) {
      lines.push(
        "These TRACKED_SECRET_ALLOWLIST entries no longer excuse anything and must be deleted,",
        "so the list cannot rot into holes nobody remembers opening:",
        ...this.staleAllowlistPaths.map((path) => `  - ${path}`),
      );
    }
    return lines.join("\n");
  }
}

const isExcludedFromScan = (path: string): boolean =>
  SCAN_SCOPE_EXCLUSIONS.some((exclusion) => path.startsWith(exclusion.prefix));

/** A file whose name declares it holds credentials is scanned with everything. */
export const shapesForPath = (path: string) =>
  CREDENTIAL_FILENAME.test(path) && !TEMPLATE_FILENAME.test(path)
    ? SECRET_SHAPES
    : SOURCE_TREE_SECRET_SHAPES;

const lineOf = (text: string, index: number): number => {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (text.charCodeAt(position) === 10) line += 1;
  }
  return line;
};

/**
 * Scans one file's text. Exported so the gate's own tests can drive it with
 * planted material instead of relying on the state of the working tree.
 */
export function scanTrackedFileText(
  path: string,
  text: string,
): ReadonlyArray<TrackedSecretFinding> {
  return findSecretShapeMatches(text, shapesForPath(path)).map((match) => ({
    path,
    shape: match.shape,
    line: lineOf(text, match.index),
    length: match.match.length,
    prefix: match.match.slice(0, 4),
  }));
}

/**
 * Applies the allow-list to a raw finding list and reports both what is left
 * and which allow-list entries have gone stale.
 */
export function applyAllowlist(findings: ReadonlyArray<TrackedSecretFinding>): {
  readonly failures: ReadonlyArray<TrackedSecretFinding>;
  readonly staleAllowlistPaths: ReadonlyArray<string>;
} {
  const usedPaths = new Set<string>();
  const failures = findings.filter((finding) => {
    const entry = TRACKED_SECRET_ALLOWLIST.find((candidate) => candidate.path === finding.path);
    if (entry === undefined) return true;
    if (!entry.shapes.includes(finding.shape)) return true;
    usedPaths.add(entry.path);
    return false;
  });
  return {
    failures,
    staleAllowlistPaths: TRACKED_SECRET_ALLOWLIST.filter((entry) => !usedPaths.has(entry.path)).map(
      (entry) => entry.path,
    ),
  };
}

/** Every tracked path the gate is responsible for, in `git ls-files` order. */
export function listScannablePaths(repoRoot: string): ReadonlyArray<string> {
  const listed = NodeChildProcess.execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    maxBuffer: 1 << 28,
  });
  return listed
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0 && !isExcludedFromScan(path));
}

/**
 * The scannable text of one tracked path, or `null`.
 *
 * `null` covers two cases. A path that cannot be read (a submodule gitlink, a
 * symlink to nowhere) carries no bytes this gate could vouch for. A path
 * containing a NUL byte is binary: decoding it as UTF-8 produces replacement
 * characters and nonsense matches, and a key hidden inside a compiled blob is
 * not a problem this gate can honestly claim to solve.
 */
function readScannableText(repoRoot: string, path: string): string | null {
  let bytes: Buffer;
  try {
    bytes = NodeFS.readFileSync(NodePath.resolve(repoRoot, path));
  } catch {
    return null;
  }
  return bytes.includes(0) ? null : bytes.toString("utf8");
}

export const checkTrackedSecrets = Effect.fn("checkTrackedSecrets")(function* (repoRoot: string) {
  const findings: Array<TrackedSecretFinding> = [];
  let scannedCount = 0;

  for (const path of listScannablePaths(repoRoot)) {
    const text = readScannableText(repoRoot, path);
    if (text === null) continue;
    scannedCount += 1;
    findings.push(...scanTrackedFileText(path, text));
  }

  const { failures, staleAllowlistPaths } = applyAllowlist(findings);
  if (failures.length > 0 || staleAllowlistPaths.length > 0) {
    return yield* new TrackedSecretsFoundError({ findings: failures, staleAllowlistPaths });
  }

  yield* Effect.log(
    `[tracked-secrets] Scanned ${scannedCount} tracked text file(s) for ${SOURCE_TREE_SECRET_SHAPES.length} of ${SECRET_SHAPE_NAMES.length} secret shapes. No committed secret material.`,
  );
});

export const checkTrackedSecretsCommand = Command.make(
  "check-tracked-secrets",
  {
    repoRoot: Flag.string("repo-root").pipe(
      Flag.withDescription(
        "Repository root to scan. Defaults to the repository this script is in.",
      ),
      Flag.withDefault(""),
    ),
  },
  ({ repoRoot }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const resolved =
        repoRoot === "" ? path.resolve(import.meta.dirname, "..") : path.resolve(repoRoot);
      yield* checkTrackedSecrets(resolved);
    }),
).pipe(Command.withDescription("Fail when a tracked file carries committed secret material."));

if (import.meta.main) {
  Command.run(checkTrackedSecretsCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
