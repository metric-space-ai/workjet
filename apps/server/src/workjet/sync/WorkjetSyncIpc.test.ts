// @effect-diagnostics nodeBuiltinImport:off
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { requestSyncAuthority } from "./WorkjetSyncIpc.ts";

const request = { version: 1, requestId: "request", operation: { type: "hello" as const } };
const response = {
  version: 1,
  requestId: "request",
  result: { type: "ready", nodeId: 1, scopeId: "scope", protocolVersion: 1 },
};
function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.byteLength);
  return Buffer.concat([header, body]);
}
async function withSocket(
  action: (socket: net.Socket) => void,
  test: (endpoint: string) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), "sync-ipc-"));
  const endpoint =
    process.platform === "win32"
      ? `\\\\.\\pipe\\sync-${path.basename(root)}`
      : path.join(root, "ipc");
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.once("data", () => action(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  try {
    await test(endpoint);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}
describe("native CTOX Sync IPC", () => {
  it("roundtrips admission, replay and revocation as distinct membership receipts", async () => {
    const worker = { nodeId: 4, identity: "ed25519:test-worker", dataReplica: true, revoked: false };
    for (const [operation, result] of [
      [{ type: "admitWorker", worker }, { type: "workerApplied", worker }],
      [{ type: "admitWorker", worker }, { type: "workerReplayed", worker }],
      [
        { type: "revokeWorker", nodeId: 4 },
        { type: "workerApplied", worker: { ...worker, revoked: true } },
      ],
    ] as const) {
      const expected = { version: 1, requestId: "membership", result };
      await withSocket(
        (socket) => socket.end(frame(expected)),
        async (endpoint) => {
          await expect(
            requestSyncAuthority(endpoint, { version: 1, requestId: "membership", operation }),
          ).resolves.toEqual(expected);
        },
      );
    }
  });
  it("decodes fragmented replies on the local transport", async () => {
    await withSocket(
      (socket) => {
        const bytes = frame(response);
        socket.write(bytes.subarray(0, 2));
        socket.end(bytes.subarray(2));
      },
      async (endpoint) => {
        await expect(requestSyncAuthority(endpoint, request)).resolves.toEqual(response);
      },
    );
  });
  it("rejects a mismatched request ID or protocol", async () => {
    for (const invalid of [
      { ...response, requestId: "old-request" },
      { ...response, version: 2 },
    ]) {
      await withSocket(
        (socket) => socket.end(frame(invalid)),
        async (endpoint) => {
          await expect(requestSyncAuthority(endpoint, request)).rejects.toThrow("does not match");
        },
      );
    }
  });
  it("rejects oversized and truncated replies", async () => {
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(65537);
    for (const invalid of [oversized, frame(response).subarray(0, 8)]) {
      await withSocket(
        (socket) => socket.end(invalid),
        async (endpoint) => {
          await expect(requestSyncAuthority(endpoint, request)).rejects.toThrow();
        },
      );
    }
  });
  it("cancels an unanswered native request", async () => {
    const controller = new AbortController();
    await withSocket(
      () => controller.abort(),
      async (endpoint) => {
        await expect(requestSyncAuthority(endpoint, request, controller.signal)).rejects.toThrow(
          "aborted",
        );
      },
    );
  });
  it("rejects TCP and HTTP endpoints", async () => {
    for (const endpoint of ["localhost:3000", "http://localhost/api", "tcp://127.0.0.1:3000"]) {
      await expect(requestSyncAuthority(endpoint, request)).rejects.toThrow("local Unix socket");
    }
  });
});
