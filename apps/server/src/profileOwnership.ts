// @effect-diagnostics nodeBuiltinImport:off - Process-lifetime exclusion uses the runtime's built-in SQLite.
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";
import { createHash } from "node:crypto";

export type ProfileOwnershipKind = "runtime" | "launcher" | "administration" | "database";

interface LockDatabase {
  exec(sql: string): unknown;
  close(): void;
}

export interface ProfileOwnership {
  readonly canonicalBaseDir: string;
  readonly lockPath: string;
  readonly release: () => void;
}

export class ProfileOwnershipError extends Error {
  constructor(
    readonly kind: ProfileOwnershipKind,
    options: { cause: unknown },
  ) {
    super(
      `Cannot acquire Workjet ${kind} ownership. Another process may own this profile; no automatic takeover was attempted.`,
      options,
    );
    this.name = "ProfileOwnershipError";
  }
}

/**
 * A dedicated SQLite connection holds an OS-backed write transaction for the
 * owner's lifetime. It contains no business data and is never deleted, replaced,
 * or recovered by PID/mtime guesses. Process death releases the kernel lock.
 * All cooperating runtime/launcher entrypoints must participate; this cannot
 * exclude old binaries or external tools that bypass Workjet's startup.
 */
async function acquireOwnership(
  baseDir: string,
  kind: ProfileOwnershipKind,
  fileName: string,
  mode: "shared" | "exclusive",
): Promise<ProfileOwnership> {
  let database: LockDatabase | undefined;
  try {
    await NodeFS.mkdir(baseDir, { recursive: true, mode: 0o700 });
    const canonicalBaseDir = await NodeFS.realpath(baseDir);
    const directory = NodePath.join(canonicalBaseDir, "runtime", "ownership");
    await NodeFS.mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = NodePath.join(directory, fileName);
    // Match the server's existing Node/Bun SQLite choice without a new native dependency.
    database =
      process.versions.bun !== undefined
        ? new (await import("bun:sqlite")).Database(lockPath, { create: true })
        : new (await import("node:sqlite")).DatabaseSync(lockPath);
    database.exec("PRAGMA busy_timeout = 0;");
    database.exec(mode === "exclusive" ? "BEGIN EXCLUSIVE;" : "BEGIN;");
    if (mode === "shared") database.exec("SELECT name FROM sqlite_schema;");
    const ownedDatabase = database;
    let released = false;
    return {
      canonicalBaseDir,
      lockPath,
      release() {
        if (released) return;
        released = true;
        try {
          ownedDatabase.exec("ROLLBACK;");
        } finally {
          ownedDatabase.close();
        }
      },
    };
  } catch (cause) {
    try {
      database?.close();
    } catch (closeCause) {
      throw new ProfileOwnershipError(kind, { cause: new AggregateError([cause, closeCause]) });
    }
    throw new ProfileOwnershipError(kind, { cause });
  }
}

export function acquireProfileOwnership(
  baseDir: string,
  kind: ProfileOwnershipKind,
): Promise<ProfileOwnership> {
  return acquireOwnership(baseDir, kind, `${kind}.sqlite`, "exclusive");
}

/** Live SQL clients share admission; file-level snapshot/restore requires exclusive admission. */
export async function acquireDatabaseAccess(
  dbPath: string,
  mode: "shared" | "exclusive",
): Promise<ProfileOwnership> {
  const absolutePath = NodePath.resolve(dbPath);
  await NodeFS.mkdir(NodePath.dirname(absolutePath), { recursive: true, mode: 0o700 });
  const canonicalParent = await NodeFS.realpath(NodePath.dirname(absolutePath));
  const canonicalDb = await NodeFS.realpath(absolutePath).catch(async (cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      // A dangling file symlink would resolve to a different lock after SQLite
      // creates its target. Only a genuinely absent path may use this fallback.
      const existing = await NodeFS.lstat(absolutePath).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing !== undefined) throw cause;
      return NodePath.join(canonicalParent, NodePath.basename(absolutePath));
    }
    throw cause;
  });
  const fileName = `database-${createHash("sha256").update(canonicalDb).digest("hex")}.sqlite`;
  return acquireOwnership(NodePath.dirname(canonicalDb), "database", fileName, mode);
}

export async function withDatabaseAccess<A>(dbPath: string, run: () => Promise<A>): Promise<A> {
  const ownership = await acquireDatabaseAccess(dbPath, "exclusive");
  try {
    return await run();
  } finally {
    ownership.release();
  }
}

export async function withProfileOwnership<A>(
  baseDir: string,
  kind: ProfileOwnershipKind,
  run: () => Promise<A>,
): Promise<A> {
  const ownership = await acquireProfileOwnership(baseDir, kind);
  try {
    return await run();
  } finally {
    ownership.release();
  }
}
