// @effect-diagnostics nodeBuiltinImport:off -- Descriptor-owned Linux profile preparation for the scoped source route.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeCrypto from "node:crypto";
import type { WorkerSourceNativeProfile } from "./WorkerSourceNativeProfile.ts";
import type { WorkerNamespaceFileCapture } from "./WorkerNamespaceSpawn.ts";
import type { WorkerSourceProfileCustody } from "./WorkerSourceCustodyStore.ts";

const sameIdentity = (a: NodeFS.BigIntStats, b: NodeFS.BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino;
const matchesCapture = (stat: NodeFS.BigIntStats, capture: WorkerNamespaceFileCapture) =>
  String(stat.dev) === capture.identity.device && String(stat.ino) === capture.identity.inode;
const privateDirectory = (stat: NodeFS.BigIntStats) =>
  stat.isDirectory() &&
  !stat.isSymbolicLink() &&
  stat.uid === BigInt(NodeProcess.getuid?.() ?? -1) &&
  (stat.mode & 0o077n) === 0n;
const failure = (cause?: unknown) =>
  new Error("Original private worker profile custody is unavailable.", { cause });

export interface WorkerSourcePrivateProfile {
  readonly profile: WorkerSourceNativeProfile;
  readonly capture: WorkerNamespaceFileCapture;
  readonly custody: WorkerSourceProfileCustody;
  readonly verify: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/** Recovery accepts only the server's original persisted root and child identities.
 * No old profile/config credentials are read; scoped config is regenerated through the held fd. */
export async function makeWorkerSourcePrivateProfile(
  root: string,
  create: (directory: string) => WorkerSourceNativeProfile,
  persistence?: {
    readonly original: WorkerSourceProfileCustody | null;
    readonly capture: (custody: WorkerSourceProfileCustody) => Promise<void>;
  },
): Promise<WorkerSourcePrivateProfile> {
  if (
    NodeProcess.platform !== "linux" ||
    !NodePath.isAbsolute(root) ||
    NodePath.resolve(root) !== root
  ) throw failure();
  const restored = persistence?.original ?? undefined;
  if (restored && (restored.root.path !== root ||
    NodePath.dirname(restored.profile.path) !== root ||
    !NodePath.basename(restored.profile.path).startsWith("profile-")))
    throw failure();
  if (!restored) await NodeFSP.mkdir(root, { recursive: true, mode: 0o700 });
  if ((await NodeFSP.realpath(root)) !== root) throw failure();
  const originalRoot = await NodeFSP.lstat(root, { bigint: true });
  if (!privateDirectory(originalRoot) || (restored && !matchesCapture(originalRoot, restored.root)))
    throw failure();
  const flags = NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW;
  const rootHandle = await NodeFSP.open(root, flags);
  let handle: NodeFSP.FileHandle | undefined;
  try {
    if (!sameIdentity(await rootHandle.stat({ bigint: true }), originalRoot)) throw failure();
    const rootFdPath = `/proc/${NodeProcess.pid}/fd/${rootHandle.fd}`;
    const created = restored
      ? NodePath.join(rootFdPath, NodePath.basename(restored.profile.path))
      : await NodeFSP.mkdtemp(NodePath.join(rootFdPath, "profile-"));
    const original = await NodeFSP.lstat(created, { bigint: true });
    handle = await NodeFSP.open(created, flags);
    if (!privateDirectory(original) || !sameIdentity(await handle.stat({ bigint: true }), original) ||
      (restored && !matchesCapture(original, restored.profile))) throw failure();
    const directory = NodePath.join(root, NodePath.basename(created));
    const profile = create(directory);
    if (profile.directory !== directory) throw failure();
    const fdPath = `/proc/${NodeProcess.pid}/fd/${handle.fd}`;
    const capture = Object.freeze({
      path: directory,
      identity: Object.freeze({ device: String(original.dev), inode: String(original.ino) }),
    });
    const custody = Object.freeze({
      root: Object.freeze({
        path: root,
        identity: Object.freeze({ device: String(originalRoot.dev), inode: String(originalRoot.ino) }),
      }),
      profile: capture,
    });
    let closed: Promise<void> | undefined;
    const verify = async () => {
      if (closed || !handle) throw failure();
      const [currentRoot, current, opened, resolved] = await Promise.all([
        NodeFSP.lstat(root, { bigint: true }),
        NodeFSP.lstat(directory, { bigint: true }),
        handle.stat({ bigint: true }),
        NodeFSP.realpath(directory),
      ]).catch((cause) => { throw failure(cause); });
      if (resolved !== directory || !privateDirectory(currentRoot) ||
        !sameIdentity(currentRoot, originalRoot) || !privateDirectory(current) ||
        !sameIdentity(current, original) || !privateDirectory(opened) ||
        !sameIdentity(opened, original)) throw failure();
    };
    if (persistence) {
      await verify();
      await persistence.capture(custody);
      await verify();
    }
    const directories = [
      profile.environment.HOME,
      profile.environment.XDG_CONFIG_HOME,
      profile.environment.XDG_DATA_HOME,
      profile.environment.XDG_CACHE_HOME,
      NodePath.join(directory, "sessions"),
    ];
    // Open every nested component without following symlinks, including on recovery.
    for (const child of directories) {
      if (!child) throw failure();
      const relative = NodePath.relative(directory, child);
      if (relative !== "" &&
        (NodePath.isAbsolute(relative) || relative.split(NodePath.sep).includes("..")))
        throw failure();
      let parent = handle;
      const children: NodeFSP.FileHandle[] = [];
      try {
        for (const part of relative.split(NodePath.sep).filter(Boolean)) {
          const next = `/proc/${NodeProcess.pid}/fd/${parent.fd}/${part}`;
          try { await NodeFSP.mkdir(next, { mode: 0o700 }); }
          catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
          }
          const opened = await NodeFSP.open(next, flags);
          children.push(opened);
          if (!privateDirectory(await opened.stat({ bigint: true }))) throw failure();
          parent = opened;
        }
      } finally {
        for (const opened of children.reverse()) await opened.close();
      }
    }
    const names = new Set<string>();
    for (const file of profile.files) {
      if (file.name !== NodePath.basename(file.name) || file.name === "." || file.name === ".." ||
        names.has(file.name)) throw failure();
      names.add(file.name);
      const destination = NodePath.join(fdPath, file.name);
      const staged = restored ? NodePath.join(fdPath, `.${file.name}.${NodeCrypto.randomUUID()}.stage`) : destination;
      try {
        await NodeFSP.writeFile(staged, file.content, {
          mode: 0o600,
          flag: NodeFS.constants.O_WRONLY | NodeFS.constants.O_CREAT |
            NodeFS.constants.O_EXCL | NodeFS.constants.O_NOFOLLOW,
        });
        if (restored) await NodeFSP.rename(staged, destination);
      } finally {
        if (restored) await NodeFSP.unlink(staged).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code !== "ENOENT") throw cause;
        });
      }
    }
    await verify();
    const ownedHandle = handle;
    const close = () => (closed ??= ownedHandle.close());
    return { profile, capture, custody, verify, close };
  } catch (error) {
    await handle?.close();
    throw error;
  } finally {
    await rootHandle.close();
  }
}
