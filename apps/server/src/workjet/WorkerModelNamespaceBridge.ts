// @effect-diagnostics nodeBuiltinImport:off -- Fixed private model mount path for the native namespace bridge.
import type { WorkerSourceModelSocketDescription } from "./WorkerSourceModelSocket.ts";

/** This port is private to the worker network namespace. It is never a host endpoint. */
export const WORKER_MODEL_NAMESPACE_PORT = 23197;
export const WORKER_MODEL_NAMESPACE_BASE_URL = `http://127.0.0.1:${WORKER_MODEL_NAMESPACE_PORT}/v1`;
export const WORKER_MODEL_NAMESPACE_SOCKET_PATH = "/run/workjet/model.sock";

/** The caller must mount the captured socket and runtime inside an enforced worker namespace. */
export function workerModelNamespaceBridgeArguments(
  socket: WorkerSourceModelSocketDescription,
): readonly string[] {
  const identity = [
    socket.socketIdentity.device,
    socket.socketIdentity.inode,
    String(WORKER_MODEL_NAMESPACE_PORT),
    socket.hostNetworkIdentity.device,
    socket.hostNetworkIdentity.inode,
  ];
  if (identity.some((value) => !/^\d+$/.test(value)) || socket.socketIdentity.inode === "0")
    throw new Error("Invalid worker model bridge identity");
  return ["--worker-model-bridge", WORKER_MODEL_NAMESPACE_SOCKET_PATH, ...identity, "--"];
}
