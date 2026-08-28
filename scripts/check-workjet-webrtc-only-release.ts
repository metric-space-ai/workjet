#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- This release guard scans raw source and artifact bytes before an Effect runtime exists.

import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

/**
 * Source trees that may ship in a non-mobile Workjet product. Deliberately
 * exclude mobile and infra/relay: mobile has its own migration, while the old
 * relay implementation must never become a build input again.
 */
export const ACTIVE_PRODUCT_ROOTS = Object.freeze([
  "apps/desktop/src",
  "apps/web/src",
  "apps/server/src",
  "packages/shared/src",
  "packages/client-runtime/src",
  "packages/contracts/src",
]);

export interface ForbiddenReference {
  readonly id: string;
  readonly pattern: RegExp;
  readonly description: string;
}

/** Marker families forbidden in active source and non-mobile release bytes. */
export const FORBIDDEN_REFERENCES: ReadonlyArray<ForbiddenReference> = Object.freeze([
  {
    id: "managed-relay",
    pattern: /ManagedRelay/giu,
    description: "ManagedRelay runtime or contract",
  },
  {
    id: "t3-relay-origin",
    pattern: /\brelay\.t3\.codes\b/giu,
    description: "legacy T3 relay origin",
  },
  {
    id: "planetscale",
    pattern: /PlanetScale/giu,
    description: "PlanetScale product dependency or configuration",
  },
  {
    id: "axiom",
    pattern: /Axiom|@axiomhq\//giu,
    description: "Axiom product dependency or configuration",
  },
  {
    id: "backend-control-http",
    pattern: /\/api\/workjet\/backend-control\b/giu,
    description: "legacy Workjet backend-control HTTP endpoint",
  },
  {
    id: "device-session-http",
    pattern: /\/api\/workjet\/device-session\b/giu,
    description: "legacy Workjet device-session HTTP endpoint",
  },
  {
    id: "control-identity-assertion",
    pattern: /\bissueControlIdentityAssertion\b/gu,
    description: "legacy web-session identity assertion",
  },
  {
    id: "environment-http",
    pattern: /EnvironmentHttp|connectEnvironment/giu,
    description: "legacy environment HTTP/connect runtime",
  },
  {
    id: "clerk-web-session",
    pattern: /Clerk/giu,
    description: "Clerk remote web-session runtime or configuration",
  },
  {
    id: "dpop-web-session",
    pattern: /DPoP|WebSession|web[-_ ]session|WorkjetManagedDeviceSession/giu,
    description: "DPoP or managed web-session runtime",
  },
]);

type AllowlistEntry = {
  readonly path: string;
  readonly markerIds: ReadonlyArray<string>;
  readonly reason: string;
};

/**
 * Exact, reviewed reference-only exceptions. No active product path can be
 * allowlisted, even if an entry is accidentally added here later.
 */
export const LEGACY_REFERENCE_ALLOWLIST: ReadonlyArray<AllowlistEntry> = Object.freeze([
  {
    path: "scripts/fixtures/workjet-webrtc-only-release/legacy-markers.txt",
    markerIds: [
      "managed-relay",
      "t3-relay-origin",
      "planetscale",
      "axiom",
      "backend-control-http",
      "device-session-http",
      "control-identity-assertion",
      "environment-http",
      "clerk-web-session",
      "dpop-web-session",
    ],
    reason: "Literal canaries used only by the release guard's focused fixture test.",
  },
  {
    path: "docs/internals/t3-connect.md",
    markerIds: ["managed-relay", "t3-relay-origin", "environment-http", "clerk-web-session"],
    reason: "Historical architecture document retained as migration context, never a build input.",
  },
  {
    path: "docs/internals/environment-auth.md",
    markerIds: ["environment-http", "clerk-web-session", "dpop-web-session"],
    reason: "Historical authentication design retained as migration context, never a build input.",
  },
]);

export interface LegacyReleaseFinding {
  readonly path: string;
  readonly markerId: string;
  readonly description: string;
  readonly line: number;
  readonly column: number;
}

const normalizePath = (value: string): string =>
  value.split(NodePath.sep).join("/").replace(/^\.\//u, "");

const isWithinActiveProductRoot = (relativePath: string): boolean => {
  const normalized = normalizePath(relativePath);
  return ACTIVE_PRODUCT_ROOTS.some(
    (root) => normalized === root || normalized.startsWith(`${root}/`),
  );
};

export function isAllowlistedLegacyReference(relativePath: string, markerId: string): boolean {
  const normalized = normalizePath(relativePath);
  if (isWithinActiveProductRoot(normalized)) return false;
  return LEGACY_REFERENCE_ALLOWLIST.some(
    (entry) => entry.path === normalized && entry.markerIds.includes(markerId),
  );
}

const locationAt = (source: string, offset: number): { line: number; column: number } => {
  const prefix = source.slice(0, offset);
  const lines = prefix.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
};

export function scanLegacyReleaseText(
  relativePath: string,
  source: string,
): ReadonlyArray<LegacyReleaseFinding> {
  const findings: Array<LegacyReleaseFinding> = [];
  for (const marker of FORBIDDEN_REFERENCES) {
    marker.pattern.lastIndex = 0;
    for (const match of source.matchAll(marker.pattern)) {
      if (isAllowlistedLegacyReference(relativePath, marker.id)) continue;
      const location = locationAt(source, match.index);
      findings.push({
        path: normalizePath(relativePath),
        markerId: marker.id,
        description: marker.description,
        line: location.line,
        column: location.column,
      });
    }
  }
  return findings.sort(
    (left, right) =>
      left.line - right.line ||
      left.column - right.column ||
      left.markerId.localeCompare(right.markerId),
  );
}

// Packaged node_modules are deliberately scanned: a forbidden dependency in
// an unpacked Electron artifact is just as release-active as a bundled import.
const SKIPPED_DIRECTORY_NAMES = new Set([".git"]);

async function listFiles(root: string): Promise<ReadonlyArray<string>> {
  const rootStat = await NodeFSP.stat(root);
  if (rootStat.isFile()) return [root];
  if (!rootStat.isDirectory()) return [];

  const files: Array<string> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolutePath = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORY_NAMES.has(entry.name)) await visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  };
  await visit(root);
  return files;
}

async function readTextFile(absolutePath: string): Promise<string | null> {
  const bytes = await NodeFSP.readFile(absolutePath);
  return bytes.includes(0) ? null : bytes.toString("utf8");
}

export interface ReleaseGuardResult {
  readonly filesScanned: number;
  readonly findings: ReadonlyArray<LegacyReleaseFinding>;
}

export async function checkWorkjetWebRtcOnlyRelease(options: {
  readonly repoRoot: string;
  readonly artifactPaths?: ReadonlyArray<string>;
  /** Test seam; production callers always use ACTIVE_PRODUCT_ROOTS. */
  readonly sourceRoots?: ReadonlyArray<string>;
}): Promise<ReleaseGuardResult> {
  const repoRoot = NodePath.resolve(options.repoRoot);
  const roots = [
    ...(options.sourceRoots ?? ACTIVE_PRODUCT_ROOTS),
    ...(options.artifactPaths ?? []),
  ];
  const absoluteFiles = new Set<string>();

  for (const root of roots) {
    const absoluteRoot = NodePath.resolve(repoRoot, root);
    try {
      for (const file of await listFiles(absoluteRoot)) absoluteFiles.add(file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code === "ENOENT" &&
        (options.sourceRoots === undefined || ACTIVE_PRODUCT_ROOTS.includes(root))
      ) {
        continue;
      }
      throw error;
    }
  }

  const findings: Array<LegacyReleaseFinding> = [];
  let filesScanned = 0;
  for (const absolutePath of [...absoluteFiles].sort()) {
    const source = await readTextFile(absolutePath);
    if (source === null) continue;
    filesScanned += 1;
    const relativePath = normalizePath(NodePath.relative(repoRoot, absolutePath));
    findings.push(...scanLegacyReleaseText(relativePath, source));
  }

  return { filesScanned, findings };
}

function parseArguments(argv: ReadonlyArray<string>): {
  readonly repoRoot: string;
  readonly artifactPaths: ReadonlyArray<string>;
} {
  let repoRoot = NodePath.resolve(NodeURL.fileURLToPath(new URL("..", import.meta.url)));
  const artifactPaths: Array<string> = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo-root") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--repo-root requires a path");
      repoRoot = NodePath.resolve(value);
      index += 1;
    } else if (argument === "--artifact") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--artifact requires a path");
      artifactPaths.push(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return { repoRoot, artifactPaths };
}

async function main(): Promise<void> {
  const options = parseArguments(NodeProcess.argv.slice(2));
  const result = await checkWorkjetWebRtcOnlyRelease(options);
  if (result.findings.length > 0) {
    console.error(
      [
        `[workjet-webrtc-only] Found ${result.findings.length} forbidden legacy reference(s):`,
        ...result.findings.map(
          (finding) =>
            `  - ${finding.path}:${finding.line}:${finding.column} [${finding.markerId}] ${finding.description}`,
        ),
      ].join("\n"),
    );
    globalThis.process.exitCode = 1;
    return;
  }
  console.log(
    `[workjet-webrtc-only] Scanned ${result.filesScanned} text file(s). No forbidden legacy references.`,
  );
}

const isEntrypoint =
  NodeProcess.argv[1] !== undefined &&
  NodeURL.fileURLToPath(import.meta.url) === NodePath.resolve(NodeProcess.argv[1]);

if (isEntrypoint) {
  await main();
}
