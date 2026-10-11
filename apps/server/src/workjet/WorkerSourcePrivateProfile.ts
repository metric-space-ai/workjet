// @effect-diagnostics nodeBuiltinImport:off -- Descriptor-owned Linux profile preparation for the scoped source route.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import type { WorkerSourceNativeProfile } from "./WorkerSourceNativeProfile.ts";
import type { WorkerNamespaceFileCapture } from "./WorkerNamespaceSpawn.ts";

const sameIdentity = (a: NodeFS.BigIntStats, b: NodeFS.BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino;
const privateDirectory = (stat: NodeFS.BigIntStats) =>
  stat.isDirectory() &&
  !stat.isSymbolicLink() &&
  stat.uid === BigInt(NodeProcess.getuid?.() ?? -1) &&
  (stat.mode & 0o077n) === 0n;
const failure = () => new Error("Original private worker profile custody is unavailable.");

export interface WorkerSourcePrivateProfile {
  readonly profile: WorkerSourceNativeProfile;
  readonly capture: WorkerNamespaceFileCapture;
  readonly verify: () => Promise<void>;
  readonly close: () => Promise<void>;
}

/** Never adopt an old profile: create and populate a new directory through its original fd. */
export async function makeWorkerSourcePrivateProfile(
  root: string,
  create: (directory: string) => WorkerSourceNativeProfile,
): Promise<WorkerSourcePrivateProfile> {
  if (
    NodeProcess.platform !== "linux" ||
    !NodePath.isAbsolute(root) ||
    NodePath.resolve(root) !== root
  )
    throw failure();
  await NodeFSP.mkdir(root, { recursive: true, mode: 0o700 });
  if ((await NodeFSP.realpath(root)) !== root) throw failure();
  const originalRoot = await NodeFSP.lstat(root, { bigint: true });
  if (!privateDirectory(originalRoot)) throw failure();
  const flags =
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW;
  const rootHandle = await NodeFSP.open(root, flags);
  let handle: NodeFSP.FileHandle | undefined;
  try {
    if (!sameIdentity(await rootHandle.stat({ bigint: true }), originalRoot)) throw failure();
    const rootFdPath = `/proc/${NodeProcess.pid}/fd/${rootHandle.fd}`;
    const created = await NodeFSP.mkdtemp(NodePath.join(rootFdPath, "profile-"));
    const original = await NodeFSP.lstat(created, { bigint: true });
    handle = await NodeFSP.open(created, flags);
    if (!privateDirectory(original) || !sameIdentity(await handle.stat({ bigint: true }), original))
      throw failure();
    const directory = NodePath.join(root, NodePath.basename(created));
    const profile = create(directory);
    if (profile.directory !== directory) throw failure();
    const fdPath = `/proc/${NodeProcess.pid}/fd/${handle.fd}`;
    let closed: Promise<void> | undefined;
    const verify = async () => {
      if (closed || !handle) throw failure();
      const [currentRoot, current, opened, resolved] = await Promise.all([
        NodeFSP.lstat(root, { bigint: true }),
        NodeFSP.lstat(directory, { bigint: true }),
        handle.stat({ bigint: true }),
        NodeFSP.realpath(directory),
      ]);
      if (
        resolved !== directory ||
        !privateDirectory(currentRoot) ||
        !sameIdentity(currentRoot, originalRoot) ||
        !privateDirectory(current) ||
        !sameIdentity(current, original) ||
        !privateDirectory(opened) ||
        !sameIdentity(opened, original)
      )
        throw failure();
    };
    // A renamed parent cannot redirect initialization, including config files containing the scoped key.
    const directories = [
      profile.environment.HOME,
      profile.environment.XDG_CONFIG_HOME,
      profile.environment.XDG_DATA_HOME,
      profile.environment.XDG_CACHE_HOME,
      NodePath.join(directory, "sessions"),
    ];
    for (const child of directories) {
      if (!child) throw failure();
      const relative = NodePath.relative(directory, child);
      if (
        relative !== "" &&
        (NodePath.isAbsolute(relative) || relative.split(NodePath.sep).includes(".."))
      )
        throw failure();
      if (relative)
        await NodeFSP.mkdir(NodePath.join(fdPath, relative), { recursive: true, mode: 0o700 });
    }
    const names = new Set<string>();
    for (const file of profile.files) {
      if (
        file.name !== NodePath.basename(file.name) ||
        file.name === "." ||
        file.name === ".." ||
        names.has(file.name)
      )
        throw failure();
      names.add(file.name);
      await NodeFSP.writeFile(NodePath.join(fdPath, file.name), file.content, {
        mode: 0o600,
        flag:
          NodeFS.constants.O_WRONLY |
          NodeFS.constants.O_CREAT |
          NodeFS.constants.O_EXCL |
          NodeFS.constants.O_NOFOLLOW,
      });
    }
    await verify();
    const ownedHandle = handle;
    const close = () => (closed ??= ownedHandle.close());
    return {
      profile,
      capture: Object.freeze({
        path: directory,
        identity: Object.freeze({ device: String(original.dev), inode: String(original.ino) }),
      }),
      verify,
      close,
    };
  } catch (error) {
    await handle?.close();
    throw error;
  } finally {
    await rootHandle.close();
  }
}
