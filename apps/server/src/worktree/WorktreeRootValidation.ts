// @effect-diagnostics nodeBuiltinImport:off -- host validation needs statfs and exclusive file creation.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, statfs, unlink } from "node:fs/promises";
import { homedir } from "node:os";

import type { WorktreeStorageInvalidReason } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";

export type WorktreeRootCandidateInspection =
  | {
      readonly status: "valid";
      readonly requestedRoot: string;
      readonly canonicalRoot: string;
      readonly writable: true;
      readonly availableBytes: number;
    }
  | {
      readonly status: "invalid";
      readonly requestedRoot: string;
      readonly canonicalRoot: string | null;
      readonly writable: boolean;
      readonly availableBytes: number | null;
      readonly reason: WorktreeStorageInvalidReason;
      readonly message: string;
    };

export class WorktreeStorageUnavailableError extends Data.TaggedError(
  "WorktreeStorageUnavailableError",
)<{
  readonly reason: WorktreeStorageInvalidReason | "settings-unavailable";
  readonly message: string;
}> {}

export class WorktreeRootValidationPlatformError extends Data.TaggedError(
  "WorktreeRootValidationPlatformError",
)<{
  readonly cause: unknown;
}> {}

function invalidInspection(input: {
  readonly requestedRoot: string;
  readonly canonicalRoot?: string | null;
  readonly writable?: boolean;
  readonly availableBytes?: number | null;
  readonly reason: WorktreeStorageInvalidReason;
  readonly message: string;
}): WorktreeRootCandidateInspection {
  return {
    status: "invalid",
    requestedRoot: input.requestedRoot,
    canonicalRoot: input.canonicalRoot ?? null,
    writable: input.writable ?? false,
    availableBytes: input.availableBytes ?? null,
    reason: input.reason,
    message: input.message,
  };
}

function isWithin(
  path: {
    readonly relative: (from: string, to: string) => string;
    readonly isAbsolute: (value: string) => boolean;
  },
  candidate: string,
  root: string,
): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export const canonicalizeBoundary = (value: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const resolved = path.resolve(value);
    return yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
  });

/** Stable hash used to keep human-readable path components collision resistant. */
export function collisionResistantPathHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export interface WorktreeRootValidationPlatform {
  readonly homeDirectory: string;
  readonly checkWritable: (
    root: string,
  ) => Effect.Effect<void, WorktreeRootValidationPlatformError>;
  readonly readAvailableBytes: (
    root: string,
  ) => Effect.Effect<number, WorktreeRootValidationPlatformError>;
}

const nodeValidationPlatform: WorktreeRootValidationPlatform = {
  homeDirectory: homedir(),
  checkWritable: (root) =>
    Effect.tryPromise({
      try: async () => {
        const probePath = `${root}/.workjet-write-probe-${process.pid}-${randomUUID()}`;
        const handle = await open(
          probePath,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600,
        );
        try {
          await handle.close();
        } finally {
          await unlink(probePath).catch(() => undefined);
        }
      },
      catch: (cause) => new WorktreeRootValidationPlatformError({ cause }),
    }),
  readAvailableBytes: (root) =>
    Effect.tryPromise({
      try: async () => {
        const info = await statfs(root, { bigint: true });
        return Number(info.bavail * info.bsize);
      },
      catch: (cause) => new WorktreeRootValidationPlatformError({ cause }),
    }),
};

/** Inspect one requested automatic root with an injectable host boundary for focused tests. */
export const inspectWorktreeRootCandidateWithPlatform = Effect.fn(
  "WorktreeStorage.inspectRootCandidateWithPlatform",
)(function* (requestedRoot: string, platform: WorktreeRootValidationPlatform) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const trimmedRoot = requestedRoot.trim();
  const usesDefault = trimmedRoot.length === 0;

  if (!usesDefault && !path.isAbsolute(trimmedRoot)) {
    return invalidInspection({
      requestedRoot: trimmedRoot,
      reason: "absolute-path-required",
      message: "Enter an absolute path on the selected server.",
    });
  }

  const resolvedRoot = path.resolve(usesDefault ? config.worktreesDir : trimmedRoot);
  const canonicalRootResult = yield* fileSystem.realPath(resolvedRoot).pipe(Effect.result);
  if (canonicalRootResult._tag === "Failure") {
    return invalidInspection({
      requestedRoot: trimmedRoot,
      reason: "not-found",
      message: "The directory does not exist on the selected server.",
    });
  }
  const canonicalRoot = canonicalRootResult.success;
  const rootInfo = yield* fileSystem.stat(canonicalRoot).pipe(Effect.result);
  if (rootInfo._tag === "Failure") {
    return invalidInspection({
      requestedRoot: trimmedRoot,
      canonicalRoot,
      reason: "not-found",
      message: "The directory could not be inspected on the selected server.",
    });
  }
  if (rootInfo.success.type !== "Directory") {
    return invalidInspection({
      requestedRoot: trimmedRoot,
      canonicalRoot,
      reason: "not-directory",
      message: "The path must be an existing directory.",
    });
  }

  if (!usesDefault) {
    if (path.dirname(canonicalRoot) === canonicalRoot) {
      return invalidInspection({
        requestedRoot: trimmedRoot,
        canonicalRoot,
        reason: "filesystem-root",
        message: "The filesystem root cannot store automatic worktrees.",
      });
    }

    const [
      canonicalHome,
      canonicalProject,
      canonicalBase,
      canonicalState,
      canonicalSecrets,
      canonicalDatabase,
    ] = yield* Effect.all(
      [
        canonicalizeBoundary(platform.homeDirectory),
        canonicalizeBoundary(config.cwd),
        canonicalizeBoundary(config.baseDir),
        canonicalizeBoundary(config.stateDir),
        canonicalizeBoundary(config.secretsDir),
        canonicalizeBoundary(config.dbPath),
      ],
      { concurrency: "unbounded" },
    );

    if (canonicalRoot === canonicalHome) {
      return invalidInspection({
        requestedRoot: trimmedRoot,
        canonicalRoot,
        reason: "home-directory",
        message: "The home directory itself cannot store automatic worktrees.",
      });
    }
    if (canonicalRoot === canonicalProject) {
      return invalidInspection({
        requestedRoot: trimmedRoot,
        canonicalRoot,
        reason: "project-boundary",
        message: "The project root cannot store automatic worktrees.",
      });
    }
    if (isWithin(path, canonicalRoot, canonicalProject)) {
      return invalidInspection({
        requestedRoot: trimmedRoot,
        canonicalRoot,
        reason: "inside-checkout",
        message: "Automatic worktrees cannot be stored inside the current checkout.",
      });
    }

    const serverBoundaries = [canonicalBase, canonicalState, canonicalSecrets, canonicalDatabase];
    if (serverBoundaries.some((boundary) => isWithin(path, canonicalRoot, boundary))) {
      return invalidInspection({
        requestedRoot: trimmedRoot,
        canonicalRoot,
        reason: "server-boundary",
        message: "Choose a location outside the server base, state, secrets, and database paths.",
      });
    }

    const protectedLocations = [
      canonicalHome,
      canonicalProject,
      canonicalBase,
      canonicalState,
      canonicalSecrets,
      canonicalDatabase,
    ];
    if (protectedLocations.some((protectedPath) => isWithin(path, protectedPath, canonicalRoot))) {
      return invalidInspection({
        requestedRoot: trimmedRoot,
        canonicalRoot,
        reason: "contains-protected-location",
        message: "The directory contains a protected server, project, or home location.",
      });
    }
  }

  const writableResult = yield* platform.checkWritable(canonicalRoot).pipe(Effect.result);
  if (writableResult._tag === "Failure") {
    return invalidInspection({
      requestedRoot: trimmedRoot,
      canonicalRoot,
      reason: "not-writable",
      message: "The selected server cannot write to this directory.",
    });
  }

  const availableResult = yield* platform.readAvailableBytes(canonicalRoot).pipe(Effect.result);
  if (availableResult._tag === "Failure" || !Number.isSafeInteger(availableResult.success)) {
    return invalidInspection({
      requestedRoot: trimmedRoot,
      canonicalRoot,
      writable: true,
      reason: "space-unavailable",
      message: "Available space could not be reported for this directory.",
    });
  }

  return {
    status: "valid",
    requestedRoot: trimmedRoot,
    canonicalRoot,
    writable: true,
    availableBytes: Math.max(0, availableResult.success),
  } satisfies WorktreeRootCandidateInspection;
});

/** Inspect one requested automatic root without reading or mutating settings. */
export const inspectWorktreeRootCandidate = Effect.fn("WorktreeStorage.inspectRootCandidate")(
  function* (requestedRoot: string) {
    return yield* inspectWorktreeRootCandidateWithPlatform(requestedRoot, nodeValidationPlatform);
  },
);
