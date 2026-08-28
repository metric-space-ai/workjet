#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/unstable/cli";
import * as YAML from "yaml";

import {
  collectProductionClosure,
  DESKTOP_RELEASE_IMPORTERS,
  describePackages,
  EXTERNAL_RUNTIME_COMPONENTS,
  packageKey,
  renderReleaseNotice,
  VENDORED_NATIVE_COMPONENTS,
  type InstalledPackageIndex,
  type InstalledPackageMetadata,
  type ReleaseLockfile,
} from "./lib/release-notice.ts";

export const RELEASE_NOTICE_FILENAME = "NOTICE.md";
export const RELEASE_NOTICE_PRODUCT = "Workjet";

export class ReleaseNoticeOutOfDateError extends Schema.TaggedErrorClass<ReleaseNoticeOutOfDateError>()(
  "ReleaseNoticeOutOfDateError",
  {
    noticePath: Schema.String,
    reason: Schema.Literals(["missing", "stale"]),
  },
) {
  override get message(): string {
    return this.reason === "missing"
      ? `${this.noticePath} does not exist. Run 'pnpm run notice:generate'.`
      : `${this.noticePath} is out of date. Run 'pnpm run notice:generate' and commit the result.`;
  }
}

export class MissingInstalledPackagesError extends Schema.TaggedErrorClass<MissingInstalledPackagesError>()(
  "MissingInstalledPackagesError",
  {
    storePath: Schema.String,
  },
) {
  override get message(): string {
    return `No pnpm virtual store at ${this.storePath}. License metadata is read from installed manifests; run 'pnpm install' before generating the release notice.`;
  }
}

export class ReleaseNoticeClosureError extends Schema.TaggedErrorClass<ReleaseNoticeClosureError>()(
  "ReleaseNoticeClosureError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Unable to derive the production dependency closure from pnpm-lock.yaml: ${String(this.cause)}`;
  }
}

const PackageManifestFromJsonString = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Unknown),
);
const decodePackageManifest = Schema.decodeUnknownEffect(PackageManifestFromJsonString);

function normalizeRepository(manifest: Record<string, unknown>): string | undefined {
  const repository = manifest["repository"];
  const raw =
    typeof repository === "string"
      ? repository
      : typeof repository === "object" && repository !== null
        ? (repository as { url?: unknown }).url
        : undefined;
  const candidate = typeof raw === "string" && raw.length > 0 ? raw : manifest["homepage"];
  if (typeof candidate !== "string" || candidate.length === 0) return undefined;
  return candidate
    .replace(/^git\+/u, "")
    .replace(/^git:\/\//u, "https://")
    .replace(/^http:\/\//u, "https://")
    .replace(/\.git$/u, "");
}

function normalizeLicense(manifest: Record<string, unknown>): string | undefined {
  const license = manifest["license"];
  if (typeof license === "string" && license.length > 0) return license;
  if (typeof license === "object" && license !== null) {
    const type = (license as { type?: unknown }).type;
    if (typeof type === "string" && type.length > 0) return type;
  }
  const licenses = manifest["licenses"];
  if (Array.isArray(licenses)) {
    const types = licenses
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : typeof entry === "object" && entry !== null
            ? (entry as { type?: unknown }).type
            : undefined,
      )
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
    if (types.length > 0) return types.join(" OR ");
  }
  return undefined;
}

/**
 * Index every manifest in the pnpm virtual store by `name@version`. Reading the
 * installed manifests is the only offline source of license metadata: the
 * lockfile records resolutions, not licenses.
 */
export const buildInstalledPackageIndex = Effect.fn("buildInstalledPackageIndex")(function* (
  repoRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const storePath = path.join(repoRoot, "node_modules", ".pnpm");
  if (!(yield* fs.exists(storePath))) {
    return yield* new MissingInstalledPackagesError({ storePath });
  }

  const index = new Map<string, InstalledPackageMetadata>();
  const readManifest = Effect.fn("readManifest")(function* (manifestPath: string) {
    if (!(yield* fs.exists(manifestPath))) return;
    const raw = yield* fs.readFileString(manifestPath);
    const decoded = yield* decodePackageManifest(raw).pipe(Effect.option);
    if (decoded._tag === "None") return;
    const parsed = decoded.value as Record<string, unknown>;
    const name = parsed["name"];
    const version = parsed["version"];
    if (typeof name !== "string" || typeof version !== "string") return;
    const key = packageKey(name, version);
    if (index.has(key)) return;
    index.set(key, { license: normalizeLicense(parsed), repository: normalizeRepository(parsed) });
  });

  const isDirectory = Effect.fn("isDirectory")(function* (candidate: string) {
    const stat = yield* fs.stat(candidate).pipe(Effect.option);
    return stat._tag === "Some" && stat.value.type === "Directory";
  });

  for (const storeEntry of (yield* fs.readDirectory(storePath)).sort()) {
    const modulesPath = path.join(storePath, storeEntry, "node_modules");
    if (!(yield* isDirectory(modulesPath))) continue;
    for (const entry of (yield* fs.readDirectory(modulesPath)).sort()) {
      if (entry.startsWith("@")) {
        const scopePath = path.join(modulesPath, entry);
        if (!(yield* isDirectory(scopePath))) continue;
        for (const scoped of (yield* fs.readDirectory(scopePath)).sort()) {
          yield* readManifest(path.join(scopePath, scoped, "package.json"));
        }
        continue;
      }
      yield* readManifest(path.join(modulesPath, entry, "package.json"));
    }
  }

  return index satisfies InstalledPackageIndex as InstalledPackageIndex;
});

export const renderRepositoryReleaseNotice = Effect.fn("renderRepositoryReleaseNotice")(function* (
  repoRoot: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lockfile = YAML.parse(
    yield* fs.readFileString(path.join(repoRoot, "pnpm-lock.yaml")),
  ) as ReleaseLockfile;
  const closure = yield* Effect.try({
    try: () => collectProductionClosure(lockfile, DESKTOP_RELEASE_IMPORTERS),
    catch: (cause) => new ReleaseNoticeClosureError({ cause }),
  });
  const index = yield* buildInstalledPackageIndex(repoRoot);
  return renderReleaseNotice({
    product: RELEASE_NOTICE_PRODUCT,
    rootImporters: DESKTOP_RELEASE_IMPORTERS,
    workspaceImporters: closure.importers,
    packages: describePackages(closure.packages, index),
    vendored: VENDORED_NATIVE_COMPONENTS,
    externalRuntime: EXTERNAL_RUNTIME_COMPONENTS,
  });
});

export const generateReleaseNotice = Effect.fn("generateReleaseNotice")(function* (
  repoRoot: string,
  check: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const noticePath = path.join(repoRoot, RELEASE_NOTICE_FILENAME);
  const rendered = yield* renderRepositoryReleaseNotice(repoRoot);

  if (check) {
    if (!(yield* fs.exists(noticePath))) {
      return yield* new ReleaseNoticeOutOfDateError({ noticePath, reason: "missing" });
    }
    if ((yield* fs.readFileString(noticePath)) !== rendered) {
      return yield* new ReleaseNoticeOutOfDateError({ noticePath, reason: "stale" });
    }
    yield* Effect.log(`[release-notice] ${RELEASE_NOTICE_FILENAME} is up to date.`);
    return;
  }

  yield* fs.writeFileString(noticePath, rendered);
  yield* Effect.log(`[release-notice] Wrote ${noticePath}.`);
});

export const generateReleaseNoticeCommand = Command.make(
  "generate-release-notice",
  {
    repoRoot: Flag.string("repo-root").pipe(
      Flag.withDescription("Repository root to scan. Defaults to the current working directory."),
      Flag.withDefault("."),
    ),
    check: Flag.boolean("check").pipe(
      Flag.withDescription("Fail instead of writing when the committed notice is out of date."),
      Flag.withDefault(false),
    ),
  },
  ({ repoRoot, check }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      yield* generateReleaseNotice(path.resolve(repoRoot), check);
    }),
).pipe(
  Command.withDescription(
    "Generate the deterministic release NOTICE and source-offer inventory for the desktop artifact.",
  ),
);

if (import.meta.main) {
  Command.run(generateReleaseNoticeCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
