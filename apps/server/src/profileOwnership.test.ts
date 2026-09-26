// @effect-diagnostics nodeBuiltinImport:off - Real SQLite/filesystem and bounded child-process exclusion tests.
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "@effect/vitest";
import {
  acquireProfileOwnership,
  acquireDatabaseAccess,
  ProfileOwnershipError,
  withProfileOwnership,
} from "./profileOwnership.ts";

async function withProfile(run: (root: string) => Promise<void>): Promise<void> {
  const root = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workjet-profile-owner-"));
  try {
    await run(root);
  } finally {
    await NodeFS.rm(root, { recursive: true, force: true });
  }
}

it("excludes a second owner through a profile alias and reopens after release", () =>
  withProfile(async (root) => {
    const base = NodePath.join(root, "profile");
    const owner = await acquireProfileOwnership(base, "runtime");
    try {
      const alias = NodePath.join(root, "alias");
      await NodeFS.symlink(base, alias, "dir");
      await expect(acquireProfileOwnership(alias, "runtime")).rejects.toBeInstanceOf(
        ProfileOwnershipError,
      );
      owner.release();
      owner.release();
      await withProfileOwnership(alias, "runtime", async () => {
        await expect(acquireProfileOwnership(base, "runtime")).rejects.toBeInstanceOf(
          ProfileOwnershipError,
        );
      });
    } finally {
      owner.release();
    }
  }));

it("admits live database clients together and excludes file restore through a symlink", () =>
  withProfile(async (root) => {
    const dbPath = NodePath.join(root, "state.sqlite");
    await NodeFS.writeFile(dbPath, "");
    const alias = NodePath.join(root, "alias.sqlite");
    await NodeFS.symlink(dbPath, alias);
    const reader = await acquireDatabaseAccess(dbPath, "shared");
    try {
      const second = await acquireDatabaseAccess(alias, "shared");
      try {
        expect(second.lockPath).toBe(reader.lockPath);
        await expect(acquireDatabaseAccess(alias, "exclusive")).rejects.toBeInstanceOf(
          ProfileOwnershipError,
        );
      } finally {
        second.release();
      }
    } finally {
      reader.release();
    }
    const restore = await acquireDatabaseAccess(alias, "exclusive");
    try {
      await expect(acquireDatabaseAccess(dbPath, "shared")).rejects.toBeInstanceOf(
        ProfileOwnershipError,
      );
    } finally {
      restore.release();
    }
  }));

it("restores reader exclusion when an existing admission file was in WAL mode", () =>
  withProfile(async (root) => {
    const dbPath = NodePath.join(root, "state.sqlite");
    const initial = await acquireDatabaseAccess(dbPath, "shared");
    const lockPath = initial.lockPath;
    initial.release();
    const database =
      process.versions.bun !== undefined
        ? new (await import("bun:sqlite")).Database(lockPath, { create: true })
        : new (await import("node:sqlite")).DatabaseSync(lockPath);
    try {
      database.exec("PRAGMA journal_mode = WAL;");
    } finally {
      database.close();
    }
    const reader = await acquireDatabaseAccess(dbPath, "shared");
    try {
      await expect(acquireDatabaseAccess(dbPath, "exclusive")).rejects.toBeInstanceOf(
        ProfileOwnershipError,
      );
    } finally {
      reader.release();
    }
  }));

it("refuses a dangling database alias instead of changing lock identity after creation", () =>
  withProfile(async (root) => {
    const alias = NodePath.join(root, "alias.sqlite");
    await NodeFS.symlink(NodePath.join(root, "missing.sqlite"), alias);
    await expect(acquireDatabaseAccess(alias, "shared")).rejects.toThrow();
  }));

it("keeps independent profiles and ownership domains separate", () =>
  withProfile(async (root) => {
    await withProfileOwnership(root, "launcher", async () => {
      await withProfileOwnership(root, "runtime", async () => {
        await withProfileOwnership(NodePath.join(root, "other"), "runtime", async () => {});
        await expect(acquireProfileOwnership(root, "launcher")).rejects.toBeInstanceOf(
          ProfileOwnershipError,
        );
      });
    });
  }));

it("releases ownership when guarded work fails without replacing its lock file", () =>
  withProfile(async (root) => {
    const owner = await acquireProfileOwnership(root, "runtime");
    const before = await NodeFS.stat(owner.lockPath);
    owner.release();
    const failure = new Error("guarded operation failed");
    await expect(
      withProfileOwnership(root, "runtime", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    await withProfileOwnership(root, "runtime", async () => {
      expect((await NodeFS.stat(owner.lockPath)).ino).toBe(before.ino);
    });
  }));

it("excludes another process and recovers kernel ownership after its abrupt exit", () =>
  withProfile(async (root) => {
    const initial = await acquireProfileOwnership(root, "runtime");
    const lockPath = initial.lockPath;
    const inode = (await NodeFS.stat(lockPath)).ino;
    initial.release();
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      const db = process.versions.bun !== undefined
        ? new (await import('bun:sqlite')).Database(process.argv[1], { create: true })
        : new (await import('node:sqlite')).DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout=0;');
      db.exec('BEGIN EXCLUSIVE;');
      process.on('disconnect', () => process.exit(0));
      process.send('locked');
    `,
        lockPath,
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    try {
      const [receipt] = await once(child, "message", { signal: AbortSignal.timeout(5_000) });
      expect(receipt).toBe("locked");
      await expect(acquireProfileOwnership(root, "runtime")).rejects.toBeInstanceOf(
        ProfileOwnershipError,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit", { signal: AbortSignal.timeout(5_000) });
        child.kill("SIGKILL");
        await exited;
      }
    }
    await withProfileOwnership(root, "runtime", async () => {
      expect((await NodeFS.stat(lockPath)).ino).toBe(inode);
    });
  }));
