// @effect-diagnostics nodeBuiltinImport:off -- Real Linux Unix sockets exercise the private model IPC lifetime.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { afterEach, expect, it } from "vite-plus/test";
import { makeWorkerSourceModelSocket } from "./WorkerSourceModelSocket.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "wj-model-"));
  cleanups.push(() => NodeFSP.rm(root, { recursive: true, force: true }));
  const socket = await makeWorkerSourceModelSocket(root, (_request, response) =>
    response.writeHead(200).end("scoped-ipc"),
  );
  cleanups.push(socket.close);
  return { root, socket };
}

function request(path: string) {
  return new Promise<string>((resolve, reject) => {
    const request = NodeHttp.get({ socketPath: path, path: "/" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve(Buffer.concat(chunks).toString()));
    });
    request.once("error", reject);
  });
}

it.skipIf(NodeOS.platform() !== "linux")(
  "binds a private socket, records actual identities and closes it idempotently",
  async () => {
    const { socket } = await fixture();
    const description = socket.description;
    expect((await NodeFSP.stat(description.directory)).mode & 0o077).toBe(0);
    const stat = await NodeFSP.lstat(description.path);
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o077).toBe(0);
    expect(description.socketIdentity).toEqual({
      device: String(stat.dev),
      inode: String(stat.ino),
    });
    expect(await request(description.path)).toBe("scoped-ipc");
    await Promise.all([socket.close(), socket.close()]);
    await expect(request(description.path)).rejects.toThrow();
    expect(await NodeFSP.lstat(description.directory).catch(() => undefined)).toBeUndefined();
  },
);

it.skipIf(NodeOS.platform() !== "linux")(
  "keeps the original endpoint and preserves a replacement directory during shutdown",
  async () => {
    const { root, socket } = await fixture();
    const directory = socket.description.directory;
    const moved = NodePath.join(root, "retained");
    await NodeFSP.rename(directory, moved);
    await NodeFSP.mkdir(directory, { mode: 0o700 });
    const replacement = NodePath.join(directory, "replacement.txt");
    await NodeFSP.writeFile(replacement, "retain replacement");
    expect(await request(socket.description.path)).toBe("scoped-ipc");
    await socket.close();
    expect(await NodeFSP.readFile(replacement, "utf8")).toBe("retain replacement");
    expect(await NodeFSP.readdir(moved)).toEqual([]);
  },
);

it.skipIf(NodeOS.platform() !== "linux")(
  "rejects non-private and symbolic-link roots before allocating an endpoint",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "wj-model-"));
    cleanups.push(() => NodeFSP.rm(root, { recursive: true, force: true }));
    const link = NodePath.join(root, "link");
    await NodeFSP.symlink(root, link);
    await expect(
      makeWorkerSourceModelSocket(link, (_request, response) => response.end()),
    ).rejects.toThrow("private directory");
    await NodeFSP.unlink(link);
    await NodeFSP.chmod(root, 0o755);
    await expect(
      makeWorkerSourceModelSocket(root, (_request, response) => response.end()),
    ).rejects.toThrow("private directory");
    expect(await NodeFSP.readdir(root)).toEqual([]);
  },
);
