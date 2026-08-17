import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings,
  type WorktreeStorageInspection,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import {
  canonicalizeBoundary,
  collisionResistantPathHash,
  inspectWorktreeRootCandidate,
  WorktreeStorageUnavailableError,
} from "./WorktreeRootValidation.ts";
export {
  inspectWorktreeRootCandidate,
  WorktreeStorageUnavailableError,
  type WorktreeRootCandidateInspection,
} from "./WorktreeRootValidation.ts";
import * as ServerSettingsService from "../serverSettings.ts";

function sanitizePathPart(value: string, fallback: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return sanitized.length > 0 ? sanitized : fallback;
}

function effectiveRoot(settings: ServerSettings, defaultRoot: string): string {
  return settings.automaticWorktreeRoot || defaultRoot;
}

export class WorktreeStorage extends Context.Service<
  WorktreeStorage,
  {
    readonly inspect: (root: string) => Effect.Effect<WorktreeStorageInspection>;
    readonly resolveAutomaticPath: (input: {
      readonly cwd: string;
      readonly gitCommonDir: string;
      readonly ref: string;
    }) => Effect.Effect<string, WorktreeStorageUnavailableError>;
    readonly trustedRoots: Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/worktree/WorktreeStorage") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsService = yield* ServerSettingsService.ServerSettingsService;

  const readSettings = settingsService.getSettings.pipe(
    Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
  );

  const canonicalizeTrustedRoot = (root: string) =>
    canonicalizeBoundary(root).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  const inspectCandidate = (root: string) =>
    inspectWorktreeRootCandidate(root).pipe(
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const trustedRoots = Effect.gen(function* () {
    const settings = yield* readSettings;
    const roots = [
      config.worktreesDir,
      settings.automaticWorktreeRoot,
      ...settings.previousAutomaticWorktreeRoots,
    ].filter((root) => root.length > 0);
    // Settings persist the canonical path that was accepted at apply time. Do
    // not follow the path again here: a removed prior root could otherwise be
    // replaced with a symlink to `/` (or another protected location) and turn
    // the review allowlist into an ambient filesystem capability.
    return [...new Set(roots.map((root) => path.resolve(root)))];
  });

  const inspect = (root: string): Effect.Effect<WorktreeStorageInspection> =>
    Effect.gen(function* () {
      const settings = yield* readSettings;
      const defaultRoot = yield* canonicalizeTrustedRoot(config.worktreesDir);
      const configuredRoot = settings.automaticWorktreeRoot;
      const effective = yield* canonicalizeTrustedRoot(effectiveRoot(settings, defaultRoot));
      const candidate = yield* inspectCandidate(root);
      return {
        ...candidate,
        configuredRoot,
        defaultRoot,
        effectiveRoot: effective,
      } as WorktreeStorageInspection;
    });

  const resolveAutomaticPath: WorktreeStorage["Service"]["resolveAutomaticPath"] = Effect.fn(
    "WorktreeStorage.resolveAutomaticPath",
  )(function* (input) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        () =>
          new WorktreeStorageUnavailableError({
            reason: "settings-unavailable",
            message: "Automatic worktree storage settings are unavailable.",
          }),
      ),
    );
    const inspection = yield* inspectCandidate(settings.automaticWorktreeRoot);
    if (inspection.status === "invalid") {
      return yield* new WorktreeStorageUnavailableError({
        reason: inspection.reason,
        message: inspection.message,
      });
    }

    const commonDir = yield* fileSystem
      .realPath(path.resolve(input.gitCommonDir))
      .pipe(Effect.orElseSucceed(() => path.resolve(input.gitCommonDir)));
    const repositoryName =
      path.basename(commonDir) === ".git"
        ? path.basename(path.dirname(commonDir))
        : path.basename(commonDir).replace(/\.git$/i, "");
    const repositoryPart = `${sanitizePathPart(repositoryName, "repository")}-${collisionResistantPathHash(commonDir)}`;
    const refPart = `${sanitizePathPart(input.ref, "ref")}-${collisionResistantPathHash(input.ref)}`;
    return path.join(inspection.canonicalRoot, repositoryPart, refPart);
  });

  return WorktreeStorage.of({ inspect, resolveAutomaticPath, trustedRoots });
});

export const layer = Layer.effect(WorktreeStorage, make);

export interface WorktreeStorageTestOptions {
  readonly inspect?: WorktreeStorage["Service"]["inspect"];
  readonly resolveAutomaticPath?: WorktreeStorage["Service"]["resolveAutomaticPath"];
  readonly trustedRoots?: ReadonlyArray<string>;
}

/** Deterministic service layer for callers whose tests do not exercise host validation. */
export const layerTest = (options: WorktreeStorageTestOptions = {}) =>
  Layer.succeed(
    WorktreeStorage,
    WorktreeStorage.of({
      inspect:
        options.inspect ??
        (() => Effect.die("WorktreeStorage.inspect was not configured for this test")),
      resolveAutomaticPath:
        options.resolveAutomaticPath ??
        (() =>
          Effect.fail(
            new WorktreeStorageUnavailableError({
              reason: "settings-unavailable",
              message: "Automatic worktree storage was not configured for this test.",
            }),
          )),
      trustedRoots: Effect.succeed(options.trustedRoots ?? []),
    }),
  );
