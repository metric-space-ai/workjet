// @effect-diagnostics nodeBuiltinImport:off - Process-lifetime exclusion uses the runtime's built-in SQLite.
import * as NodeFS from "node:fs/promises";
import * as NodePath from "node:path";

export type ProfileOwnershipKind = "runtime" | "launcher" | "administration";

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
      `Cannot acquire exclusive Workjet ${kind} ownership. Another process may own this profile; no automatic takeover was attempted.`,
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
export async function acquireProfileOwnership(
  baseDir: string,
  kind: ProfileOwnershipKind,
): Promise<ProfileOwnership> {
  let database: LockDatabase | undefined;
  try {
    await NodeFS.mkdir(baseDir, { recursive: true, mode: 0o700 });
    const canonicalBaseDir = await NodeFS.realpath(baseDir);
    const directory = NodePath.join(canonicalBaseDir, "runtime", "ownership");
    await NodeFS.mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = NodePath.join(directory, `${kind}.sqlite`);
    // Match the server's existing Node/Bun SQLite choice without a new native dependency.
    database =
      process.versions.bun !== undefined
        ? new (await import("bun:sqlite")).Database(lockPath)
        : new (await import("node:sqlite")).DatabaseSync(lockPath);
    database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
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
