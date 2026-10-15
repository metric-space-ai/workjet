// @effect-diagnostics nodeBuiltinImport:off -- Linux descriptor-owned IPC adapter for the scoped worker model route.
import * as NodeHttp from "node:http";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

export interface WorkerSourceModelSocketDescription {
  readonly root: string;
  readonly path: string;
  readonly directory: string;
  readonly directoryIdentity: { readonly device: string; readonly inode: string };
  readonly socketIdentity: { readonly device: string; readonly inode: string };
  readonly hostNetworkIdentity: { readonly device: string; readonly inode: string };
}

const identity = (stat: NodeFS.BigIntStats) => ({
  device: String(stat.dev),
  inode: String(stat.ino),
});

/** The host socket stays reachable through its original directory descriptor. */
export async function makeWorkerSourceModelSocket(
  root: string,
  onRequest: NodeHttp.RequestListener,
): Promise<{
  readonly description: WorkerSourceModelSocketDescription;
  readonly close: () => Promise<void>;
}> {
  if (NodeProcess.platform !== "linux" || !NodePath.isAbsolute(root))
    throw new Error("Private worker model IPC is unavailable on this host.");
  await NodeFSP.mkdir(root, { recursive: true, mode: 0o700 });
  const parent = await NodeFSP.lstat(root, { bigint: true });
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== BigInt(NodeProcess.getuid?.() ?? -1) ||
    (parent.mode & 0o077n) !== 0n
  )
    throw new Error("Worker model IPC requires a private directory.");

  const directory = await NodeFSP.mkdtemp(NodePath.join(root, "m-"));
  const original = await NodeFSP.lstat(directory, { bigint: true });
  let handle: NodeFSP.FileHandle | undefined;
  const server = NodeHttp.createServer(onRequest);
  let closed: Promise<void> | undefined;

  const close = () =>
    (closed ??= (async () => {
      // libuv's unlink is anchored too: a renamed/replaced directory is never adopted.
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await handle?.close();
      const current = await NodeFSP.lstat(directory, { bigint: true }).catch(() => undefined);
      if (current?.isDirectory() && current.dev === original.dev && current.ino === original.ino)
        await NodeFSP.rmdir(directory).catch(() => undefined);
      // Never recursively delete a directory or a replacement at its old pathname.
    })());

  try {
    handle = await NodeFSP.open(
      directory,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY | NodeFS.constants.O_NOFOLLOW,
    );
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== original.dev || opened.ino !== original.ino)
      throw new Error("Worker model IPC directory changed.");
    const ownedPath = `/proc/${NodeProcess.pid}/fd/${handle.fd}/s`;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(ownedPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await NodeFSP.chmod(ownedPath, 0o600);
    const socket = await NodeFSP.lstat(ownedPath, { bigint: true });
    if (!socket.isSocket()) throw new Error("Worker model IPC did not bind.");
    const hostNetwork = await NodeFSP.stat("/proc/self/ns/net", { bigint: true });
    return {
      description: {
        root,
        path: ownedPath,
        directory,
        directoryIdentity: identity(opened),
        socketIdentity: identity(socket),
        hostNetworkIdentity: identity(hostNetwork),
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
