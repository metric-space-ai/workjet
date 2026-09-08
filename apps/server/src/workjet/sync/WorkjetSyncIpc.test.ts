// @effect-diagnostics nodeBuiltinImport:off
import * as NodeNet from "node:net";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
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
const withSocket = Effect.fn("withSocket")(function* (
  action: (socket: NodeNet.Socket) => void,
  test: (endpoint: string) => Promise<void>,
) {
  const platform = yield* HostProcessPlatform;
  yield* Effect.tryPromise(async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sync-ipc-"));
    const endpoint =
      platform === "win32"
        ? `\\\\.\\pipe\\sync-${NodePath.basename(root)}`
        : NodePath.join(root, "ipc");
    const sockets = new Set<NodeNet.Socket>();
    const server = NodeNet.createServer((socket) => {
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
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
describe("native CTOX Sync IPC", () => {
  it.effect("roundtrips admission, replay and revocation as distinct membership receipts", () =>
    Effect.gen(function* () {
      const worker = {
        nodeId: 4,
        identity: "ed25519:test-worker",
        dataReplica: true,
        revoked: false,
      };
      for (const [operation, result] of [
        [
          { type: "admitWorker", worker },
          { type: "workerApplied", worker },
        ],
        [
          { type: "admitWorker", worker },
          { type: "workerReplayed", worker },
        ],
        [
          { type: "revokeWorker", nodeId: 4 },
          { type: "workerApplied", worker: { ...worker, revoked: true } },
        ],
      ] as const) {
        const expected = { version: 1, requestId: "membership", result };
        yield* withSocket(
          (socket) => socket.end(frame(expected)),
          async (endpoint) => {
            await expect(
              requestSyncAuthority(endpoint, { version: 1, requestId: "membership", operation }),
            ).resolves.toEqual(expected);
          },
        );
      }
    }),
  );
  it.effect("decodes fragmented replies on the local transport", () =>
    withSocket(
      (socket) => {
        const bytes = frame(response);
        socket.write(bytes.subarray(0, 2));
        socket.end(bytes.subarray(2));
      },
      async (endpoint) => {
        await expect(requestSyncAuthority(endpoint, request)).resolves.toEqual(response);
      },
    ),
  );
  it.effect("rejects a mismatched request ID or protocol", () =>
    Effect.gen(function* () {
      for (const invalid of [
        { ...response, requestId: "old-request" },
        { ...response, version: 2 },
      ]) {
        yield* withSocket(
          (socket) => socket.end(frame(invalid)),
          async (endpoint) => {
            await expect(requestSyncAuthority(endpoint, request)).rejects.toThrow("does not match");
          },
        );
      }
    }),
  );
  it.effect("rejects oversized and truncated replies", () =>
    Effect.gen(function* () {
      const oversized = Buffer.alloc(4);
      oversized.writeUInt32BE(65537);
      for (const invalid of [oversized, frame(response).subarray(0, 8)]) {
        yield* withSocket(
          (socket) => socket.end(invalid),
          async (endpoint) => {
            await expect(requestSyncAuthority(endpoint, request)).rejects.toThrow();
          },
        );
      }
    }),
  );
  it.effect("cancels an unanswered native request", () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      yield* withSocket(
        () => controller.abort(),
        async (endpoint) => {
          await expect(requestSyncAuthority(endpoint, request, controller.signal)).rejects.toThrow(
            "aborted",
          );
        },
      );
    }),
  );
  it.effect("rejects TCP and HTTP endpoints", () =>
    Effect.tryPromise(async () => {
      for (const endpoint of ["localhost:3000", "http://localhost/api", "tcp://127.0.0.1:3000"]) {
        await expect(requestSyncAuthority(endpoint, request)).rejects.toThrow("local Unix socket");
      }
    }),
  );
});
