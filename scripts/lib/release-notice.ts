import * as Schema from "effect/Schema";

/**
 * Deterministic release NOTICE model.
 *
 * Every function in this module is pure: it takes an already-parsed pnpm
 * lockfile plus an already-built installed-package index and returns data or
 * Markdown. Nothing here reads the filesystem, the clock, or the network, so
 * the same inputs always render the same bytes.
 */

export class ReleaseNoticeImporterMissingError extends Schema.TaggedErrorClass<ReleaseNoticeImporterMissingError>()(
  "ReleaseNoticeImporterMissingError",
  {
    importer: Schema.String,
    referencedBy: Schema.String,
  },
) {
  override get message(): string {
    return `pnpm-lock.yaml has no importer '${this.importer}' referenced by '${this.referencedBy}'.`;
  }
}

export class ReleaseNoticeSnapshotMissingError extends Schema.TaggedErrorClass<ReleaseNoticeSnapshotMissingError>()(
  "ReleaseNoticeSnapshotMissingError",
  {
    snapshot: Schema.String,
    referencedBy: Schema.String,
  },
) {
  override get message(): string {
    return `pnpm-lock.yaml has no snapshot '${this.snapshot}' referenced by '${this.referencedBy}'. The lockfile is not self-consistent; run 'pnpm install --lockfile-only' before generating the release notice.`;
  }
}

export interface LockImporterDependency {
  readonly specifier?: string;
  readonly version: string;
}

export interface LockImporter {
  readonly dependencies?: Readonly<Record<string, LockImporterDependency>>;
  readonly optionalDependencies?: Readonly<Record<string, LockImporterDependency>>;
  readonly devDependencies?: Readonly<Record<string, LockImporterDependency>>;
}

export interface LockSnapshot {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

export interface ReleaseLockfile {
  readonly importers?: Readonly<Record<string, LockImporter>>;
  readonly snapshots?: Readonly<Record<string, LockSnapshot>>;
}

/**
 * Workspace importers whose production dependency closure can reach the
 * packaged desktop artifact. `apps/desktop` is the Electron main process,
 * `apps/server` is the bundled backend, and `apps/web` is the bundled client.
 * Workspace links are followed transitively, so the `packages/*` importers do
 * not need to be listed here.
 */
export const DESKTOP_RELEASE_IMPORTERS = ["apps/desktop", "apps/server", "apps/web"] as const;

/**
 * Package-name globs that `DESKTOP_FILE_EXCLUSIONS` in
 * `scripts/build-desktop-artifact.ts` removes from the packaged artifact. They
 * stay in the production dependency graph, so the notice lists them separately
 * instead of attributing code that is not shipped.
 */
export const DESKTOP_EXCLUDED_PACKAGE_PREFIXES = ["@anthropic-ai/claude-agent-sdk-"] as const;

const PLATFORM_SIBLING_TOKENS = [
  "android",
  "darwin",
  "freebsd",
  "linux",
  "openharmony",
  "sunos",
  "win32",
] as const;

export interface ResolvedPackage {
  /** Bare package name, e.g. `effect`. */
  readonly name: string;
  /** Bare version without pnpm peer or patch suffixes, e.g. `4.0.0-beta.103`. */
  readonly version: string;
}

export interface InstalledPackageMetadata {
  readonly license: string | undefined;
  readonly repository: string | undefined;
}

export type InstalledPackageIndex = ReadonlyMap<string, InstalledPackageMetadata>;

export function packageKey(name: string, version: string): string {
  return `${name}@${version}`;
}

/** Strip pnpm peer/patch suffixes: `foo@1.0.0(bar@2)` becomes `foo@1.0.0`. */
export function stripSnapshotSuffix(snapshotKey: string): string {
  const parenthesis = snapshotKey.indexOf("(");
  return parenthesis >= 0 ? snapshotKey.slice(0, parenthesis) : snapshotKey;
}

export function parseSnapshotKey(snapshotKey: string): ResolvedPackage {
  const bare = stripSnapshotSuffix(snapshotKey);
  const separator = bare.lastIndexOf("@");
  if (separator <= 0) return { name: bare, version: "" };
  return { name: bare.slice(0, separator), version: bare.slice(separator + 1) };
}

/**
 * pnpm records a dependency either as a plain resolution for its own name
 * (`effect: 4.0.0`) or, for aliases, as a complete snapshot key
 * (`vite: '@voidzero-dev/vite-plus-core@0.2.2(...)'`).
 */
export function resolveSnapshotKey(dependencyName: string, resolution: string): string {
  return /^[0-9]/.test(resolution) ? `${dependencyName}@${resolution}` : resolution;
}

/** POSIX-only relative path join used to follow `link:` workspace resolutions. */
export function resolveImporterLink(importer: string, relative: string): string {
  const segments = importer.split("/").filter((segment) => segment.length > 0);
  for (const segment of relative.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments.join("/");
}

export interface ProductionClosure {
  /** Workspace importers reachable from the roots, sorted. */
  readonly importers: readonly string[];
  /** External packages reachable from the roots, sorted and de-duplicated. */
  readonly packages: readonly ResolvedPackage[];
}

/**
 * Collect the production dependency closure of the given workspace importers.
 *
 * Only `dependencies` and `optionalDependencies` are followed. pnpm never
 * records transitive dev dependencies in `snapshots`, so the closure is
 * production-only by construction.
 */
export function collectProductionClosure(
  lockfile: ReleaseLockfile,
  rootImporters: readonly string[] = DESKTOP_RELEASE_IMPORTERS,
): ProductionClosure {
  const importers = lockfile.importers ?? {};
  const snapshots = lockfile.snapshots ?? {};
  const visitedImporters = new Set<string>();
  const visitedSnapshots = new Set<string>();

  const visitSnapshot = (snapshotKey: string, referencedBy: string): void => {
    if (visitedSnapshots.has(snapshotKey)) return;
    const snapshot = snapshots[snapshotKey];
    if (snapshot === undefined) {
      throw new ReleaseNoticeSnapshotMissingError({ snapshot: snapshotKey, referencedBy });
    }
    visitedSnapshots.add(snapshotKey);
    for (const group of [snapshot.dependencies, snapshot.optionalDependencies]) {
      for (const [name, resolution] of Object.entries(group ?? {})) {
        if (resolution.startsWith("link:")) continue;
        visitSnapshot(resolveSnapshotKey(name, resolution), snapshotKey);
      }
    }
  };

  const visitImporter = (importer: string, referencedBy: string): void => {
    if (visitedImporters.has(importer)) return;
    const entry = importers[importer];
    if (entry === undefined) {
      throw new ReleaseNoticeImporterMissingError({ importer, referencedBy });
    }
    visitedImporters.add(importer);
    for (const group of [entry.dependencies, entry.optionalDependencies]) {
      for (const [name, dependency] of Object.entries(group ?? {})) {
        const resolution = dependency.version;
        if (resolution.startsWith("link:")) {
          visitImporter(resolveImporterLink(importer, resolution.slice("link:".length)), importer);
          continue;
        }
        visitSnapshot(resolveSnapshotKey(name, resolution), importer);
      }
    }
  };

  for (const root of rootImporters) visitImporter(root, "<release roots>");

  const packages = new Map<string, ResolvedPackage>();
  for (const snapshotKey of visitedSnapshots) {
    const resolved = parseSnapshotKey(snapshotKey);
    packages.set(packageKey(resolved.name, resolved.version), resolved);
  }

  return {
    importers: [...visitedImporters].sort(),
    packages: [...packages.values()].sort(comparePackages),
  };
}

export function comparePackages(left: ResolvedPackage, right: ResolvedPackage): number {
  if (left.name !== right.name) return left.name < right.name ? -1 : 1;
  if (left.version === right.version) return 0;
  return left.version < right.version ? -1 : 1;
}

export function isExcludedFromArtifact(name: string): boolean {
  return DESKTOP_EXCLUDED_PACKAGE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Platform-variant packages (`@scope/foo-darwin-arm64`) are only installed for
 * the generating host, so their metadata is missing for every other platform.
 * Their sibling variants at the identical version are published by the same
 * project under the same terms; resolving through the sibling family keeps the
 * generated notice identical on every host instead of leaking the host's
 * installed subset into the release gate.
 */
export function resolvePlatformSiblingLicense(
  target: ResolvedPackage,
  index: InstalledPackageIndex,
): string | undefined {
  const token = PLATFORM_SIBLING_TOKENS.find(
    (candidate) => target.name.includes(`-${candidate}-`) || target.name.endsWith(`-${candidate}`),
  );
  if (token === undefined) return undefined;
  const prefix = `${target.name.slice(0, target.name.indexOf(`-${token}`))}-`;
  const licenses = new Set<string>();
  for (const [key, metadata] of index) {
    const separator = key.lastIndexOf("@");
    const name = key.slice(0, separator);
    const version = key.slice(separator + 1);
    if (version !== target.version) continue;
    if (name === target.name || !name.startsWith(prefix)) continue;
    if (metadata.license === undefined) continue;
    licenses.add(metadata.license);
  }
  return licenses.size === 1 ? [...licenses][0] : undefined;
}

export type LicenseOrigin = "manifest" | "platform-sibling" | "unresolved";

export interface NoticePackage extends ResolvedPackage {
  readonly license: string;
  readonly licenseOrigin: LicenseOrigin;
  readonly repository: string | undefined;
}

export const UNRESOLVED_LICENSE = "UNRESOLVED";

export function describePackages(
  packages: readonly ResolvedPackage[],
  index: InstalledPackageIndex,
): readonly NoticePackage[] {
  return packages.map((entry) => {
    const metadata = index.get(packageKey(entry.name, entry.version));
    if (metadata?.license !== undefined) {
      return {
        ...entry,
        license: metadata.license,
        licenseOrigin: "manifest" as const,
        repository: metadata.repository,
      };
    }
    const sibling = resolvePlatformSiblingLicense(entry, index);
    return {
      ...entry,
      license: sibling ?? UNRESOLVED_LICENSE,
      licenseOrigin:
        sibling === undefined ? ("unresolved" as const) : ("platform-sibling" as const),
      repository: metadata?.repository,
    };
  });
}

export interface VendoredComponent {
  /** Repository-relative path of the vendored component. */
  readonly path: string;
  readonly component: string;
  readonly version: string;
  /** SPDX expression declared by the component manifest. */
  readonly license: string;
  /** License texts retained next to the component. */
  readonly licenseFiles: readonly string[];
  /** Upstream provenance sentence; empty for wholly first-party components. */
  readonly upstream: string;
  /** Whether the component's build output is redistributed in the desktop artifact. */
  readonly shipped: boolean;
}

/**
 * Vendored native components and their license boundaries. Every field is
 * transcribed from the component manifest plus
 * `docs/workjet-source-provenance.md`; the values are asserted by
 * `scripts/generate-release-notice.test.ts` against the checked-in manifests so
 * this table cannot silently drift from the tree.
 */
export const VENDORED_NATIVE_COMPONENTS: readonly VendoredComponent[] = [
  {
    path: "native/libghostty-vt",
    component: "libghostty-vt C headers",
    version: "upstream revision 9f62873bf195e4d8a762d768a1405a5f2f7b1697",
    license: "MIT",
    licenseFiles: ["native/libghostty-vt/LICENSE"],
    upstream:
      "Ghostty terminal VT library (Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors); only the C headers are vendored, and they are consumed by the Android build of apps/mobile, not by the desktop artifact. The upstream MIT notice is retained verbatim.",
    shipped: false,
  },
  {
    path: "native/pdf-parse",
    component: "ctox-pdf-parse",
    version: "0.1.0",
    license: "Apache-2.0 AND (MIT OR AGPL-3.0-only)",
    licenseFiles: [
      "native/pdf-parse/LICENSE.Apache-2.0",
      "native/pdf-parse/LICENSE.MIT",
      "native/pdf-parse/LICENSE.AGPL-3.0-only",
    ],
    upstream:
      "Rust transposition of run-llama/liteparse v1.4.5 (commit 67726fc153393439f43d70268ba67d08bf49ed87); LiteParse-derived material stays Apache-2.0.",
    shipped: false,
  },
  {
    path: "native/provider-gateway",
    component: "workjet-provider-gateway",
    version: "0.1.0",
    license: "MIT OR AGPL-3.0-only",
    licenseFiles: [
      "native/provider-gateway/LICENSE.MIT",
      "native/provider-gateway/LICENSE.AGPL-3.0-only",
      "native/provider-gateway/LICENSE.upstream",
    ],
    upstream:
      "Rust port of router-for-me/CLIProxyAPI at commit a88197f845c979132c8978ea223c6af05cc81536; the upstream MIT notice is retained as LICENSE.upstream.",
    shipped: false,
  },
  {
    path: "native/provider-gateway-workjet-host",
    component: "workjet-provider-gateway-host",
    version: "0.1.0",
    license: "MIT OR AGPL-3.0-only",
    licenseFiles: ["native/provider-gateway/LICENSE.MIT"],
    upstream: "First-party Workjet host wrapper around the provider gateway.",
    shipped: false,
  },
  {
    path: "native/resource-monitor",
    component: "t3-resource-monitor",
    version: "0.1.0",
    license: "MIT",
    licenseFiles: ["LICENSE"],
    upstream: "First-party T3 Code component; covered by the repository-root MIT license.",
    shipped: true,
  },
  {
    path: "native/web-stack",
    component: "ctox-web-stack",
    version: "0.1.0",
    license: "MIT AND ISC AND (MIT OR AGPL-3.0-only)",
    licenseFiles: ["native/web-stack/LICENSE.MIT", "native/web-stack/LICENSE.AGPL-3.0-only"],
    upstream:
      "CloakBrowser- and puppeteer-extra-derived assets remain MIT, google-search-derived portions remain ISC; the exact commits and file families are recorded in native/web-stack/UPSTREAM.md.",
    shipped: false,
  },
];

export interface ExternalRuntimeComponent {
  readonly component: string;
  readonly license: string;
  readonly note: string;
}

/**
 * Components a Workjet installation may obtain and execute at runtime that are
 * NOT redistributed inside the desktop artifact. They are listed so the notice
 * is complete about what the product uses, and explicitly marked as
 * not-redistributed so the notice makes no unsupported distribution claim.
 */
export const EXTERNAL_RUNTIME_COMPONENTS: readonly ExternalRuntimeComponent[] = [
  {
    component:
      "Greppy 0.3.1 (metric-space-ai/greppy, commit de078b47d1df5df7c086e4591162517328f979ec)",
    license: "Apache-2.0",
    note: "No Greppy source is vendored in this repository and no Greppy binary is packaged in the desktop artifact. Workjet pins the upstream source archive in packages/workjet-capabilities/src/greppyRuntime.ts and, on explicit user opt-in, downloads and builds it on the user's machine into the server state directory. The Apache-2.0 LICENSE, NOTICE, and THIRD_PARTY.md that ship inside that archive are the applicable notices for the resulting local build; the pinned model weights carry their own separate terms and are not licensed under Greppy's Apache-2.0 software license.",
  },
  {
    component: "CTOX Business OS shell (pinned release archive)",
    license: "See the CTOX release; AGPL-3.0-only unless the dual option applies",
    note: "The verified shell archive is fetched at build time by scripts/prepare-ctox-business-os-shell.ts and IS copied into the packaged artifact as the 'ctox-business-os-shell' extra resource. Its licensing follows the CTOX release it was built from; see docs/workjet-electron-guest-shell-license-review.md.",
  },
];

export interface ReleaseNoticeInput {
  readonly product: string;
  readonly rootImporters: readonly string[];
  readonly workspaceImporters: readonly string[];
  readonly packages: readonly NoticePackage[];
  readonly vendored: readonly VendoredComponent[];
  readonly externalRuntime: readonly ExternalRuntimeComponent[];
}

export function groupPackagesByLicense(
  packages: readonly NoticePackage[],
): readonly (readonly [string, readonly NoticePackage[]])[] {
  const groups = new Map<string, NoticePackage[]>();
  for (const entry of packages) {
    const group = groups.get(entry.license);
    if (group === undefined) groups.set(entry.license, [entry]);
    else group.push(entry);
  }
  return [...groups.entries()]
    .map(([license, entries]) => [license, [...entries].sort(comparePackages)] as const)
    .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1));
}

function renderPackageLine(entry: NoticePackage): string {
  const suffix = entry.repository === undefined ? "" : ` — ${entry.repository}`;
  const origin =
    entry.licenseOrigin === "platform-sibling" ? " (license from platform sibling)" : "";
  return `- \`${entry.name}@${entry.version}\`${origin}${suffix}`;
}

/**
 * Render the release NOTICE. The output contains no timestamp, no host path and
 * no locale-dependent ordering, so re-running the generator on an unchanged
 * tree reproduces the file byte for byte.
 */
export function renderReleaseNotice(input: ReleaseNoticeInput): string {
  const shipped = input.packages.filter((entry) => !isExcludedFromArtifact(entry.name));
  const excluded = input.packages.filter((entry) => isExcludedFromArtifact(entry.name));
  const unresolved = shipped.filter((entry) => entry.licenseOrigin === "unresolved");
  const lines: string[] = [];

  lines.push(`# ${input.product} release NOTICE`);
  lines.push("");
  lines.push(
    "Generated by `node scripts/generate-release-notice.ts`. Do not edit by hand; edit the",
    "generator or the component manifests it reads and regenerate. The generator is offline",
    "and deterministic: it derives the production dependency closure from `pnpm-lock.yaml`",
    "and license metadata from the installed package manifests, and it emits no timestamp.",
  );
  lines.push("");
  lines.push(
    "This notice records attribution obligations for the packaged desktop artifact. It is not",
    "legal advice and it grants no rights beyond the licenses it names.",
  );
  lines.push("");

  lines.push("## 1. Workjet application");
  lines.push("");
  lines.push(
    "The Workjet application is derived from T3 Code and remains under the MIT License. The",
    "original copyright and permission notice is retained verbatim in the repository-root",
    "[`LICENSE`](LICENSE) file and is packaged with every desktop artifact under",
    "`Resources/legal/LICENSE`.",
  );
  lines.push("");
  lines.push(
    "Metric Space AI components shared with Workjet carry `SPDX-License-Identifier: MIT OR",
    "AGPL-3.0-only`. Workjet releases select the MIT option for those components. The full",
    "policy is [`LICENSE_POLICY.md`](LICENSE_POLICY.md); the per-component provenance is",
    "[`docs/workjet-source-provenance.md`](docs/workjet-source-provenance.md).",
  );
  lines.push("");

  lines.push("## 2. Vendored native components");
  lines.push("");
  for (const component of input.vendored) {
    lines.push(`### \`${component.path}\``);
    lines.push("");
    lines.push(`- Component: \`${component.component}\` ${component.version}`);
    lines.push(`- License: \`${component.license}\``);
    lines.push(
      `- Redistributed in the desktop artifact: ${component.shipped ? "yes" : "not currently packaged"}`,
    );
    lines.push(
      `- Retained license texts: ${component.licenseFiles.map((file) => `\`${file}\``).join(", ")}`,
    );
    if (component.upstream.length > 0) lines.push(`- Upstream: ${component.upstream}`);
    lines.push("");
  }

  lines.push("## 3. External runtime components");
  lines.push("");
  for (const component of input.externalRuntime) {
    lines.push(`### ${component.component}`);
    lines.push("");
    lines.push(`- License: ${component.license}`);
    lines.push(`- ${component.note}`);
    lines.push("");
  }

  lines.push(`## 4. Third-party npm packages (${shipped.length})`);
  lines.push("");
  lines.push(
    "Production dependency closure of the release importers",
    `(${input.rootImporters.map((importer) => `\`${importer}\``).join(", ")}), following workspace`,
    "links transitively. Development dependencies are excluded. Workspace importers reached:",
    `${input.workspaceImporters.map((importer) => `\`${importer}\``).join(", ")}.`,
  );
  lines.push("");
  for (const [license, entries] of groupPackagesByLicense(shipped)) {
    lines.push(`### ${license} (${entries.length})`);
    lines.push("");
    for (const entry of entries) lines.push(renderPackageLine(entry));
    lines.push("");
  }

  lines.push(`## 5. Packages excluded from the packaged artifact (${excluded.length})`);
  lines.push("");
  lines.push(
    "These packages are production dependencies in the lockfile but are removed from the",
    "artifact by `DESKTOP_FILE_EXCLUSIONS` in `scripts/build-desktop-artifact.ts`. They are",
    "listed for completeness; their code is not redistributed.",
  );
  lines.push("");
  if (excluded.length === 0) lines.push("_None._");
  for (const entry of excluded) {
    lines.push(`- \`${entry.name}@${entry.version}\` — ${entry.license}`);
  }
  lines.push("");

  lines.push(`## 6. Unresolved license metadata (${unresolved.length})`);
  lines.push("");
  if (unresolved.length === 0) {
    lines.push("_None. Every packaged dependency resolved to a declared license._");
  } else {
    lines.push(
      "These packages declare no license in their manifest and have no platform sibling to",
      "resolve through. They must be resolved manually before a public release.",
    );
    lines.push("");
    for (const entry of unresolved) lines.push(`- \`${entry.name}@${entry.version}\``);
  }
  lines.push("");

  lines.push("## 7. Source offer");
  lines.push("");
  lines.push(
    "Components licensed `MIT OR AGPL-3.0-only` are distributed in Workjet releases under the",
    "MIT option, which imposes no source-distribution obligation beyond retaining the notices",
    "reproduced here. Metric Space AI nevertheless publishes the complete corresponding source",
    "for those components, and for every first-party component in this notice, in the Workjet",
    "repository at the release tag that produced the artifact.",
  );
  lines.push("");
  lines.push(
    "For any component in this artifact that is distributed under AGPL-3.0-only rather than the",
    "MIT option — see section 2 for the per-component license expression and section 3 for the",
    "CTOX Business OS shell — the complete corresponding source is available for at least three",
    "years from the date of distribution, at no charge beyond the cost of transfer, by written",
    "request to Metric Space AI. This offer accompanies each binary distribution.",
  );
  lines.push("");
  lines.push(
    "Third-party packages in section 4 are redistributed under their own licenses; their",
    "corresponding source is available from the registry and repository each package names.",
  );
  lines.push("");

  return `${lines
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trimEnd()}\n`;
}
