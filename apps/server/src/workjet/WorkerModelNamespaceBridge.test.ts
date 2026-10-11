import { expect, it } from "vite-plus/test";
import {
  WORKER_MODEL_NAMESPACE_BASE_URL,
  WORKER_MODEL_NAMESPACE_PORT,
  WORKER_MODEL_NAMESPACE_SOCKET_PATH,
  workerModelNamespaceBridgeArguments,
} from "./WorkerModelNamespaceBridge.ts";
import type { WorkerSourceModelSocketDescription } from "./WorkerSourceModelSocket.ts";

const captured: WorkerSourceModelSocketDescription = {
  root: "/fixture/private-model",
  directory: "/fixture/private-model/m-assigned",
  path: "/proc/42/fd/7/s",
  directoryIdentity: { device: "1", inode: "2" },
  socketIdentity: { device: "3", inode: "4" },
  hostNetworkIdentity: { device: "5", inode: "6" },
};

it("passes the captured model and parent network identities to the native bridge", () => {
  expect(workerModelNamespaceBridgeArguments(captured)).toEqual([
    "--worker-model-bridge",
    WORKER_MODEL_NAMESPACE_SOCKET_PATH,
    "3",
    "4",
    String(WORKER_MODEL_NAMESPACE_PORT),
    "5",
    "6",
    "--",
  ]);
  expect(WORKER_MODEL_NAMESPACE_BASE_URL).toBe(`http://127.0.0.1:${WORKER_MODEL_NAMESPACE_PORT}/v1`);
});

it("rejects a malformed or missing captured identity", () => {
  expect(() =>
    workerModelNamespaceBridgeArguments({
      ...captured,
      socketIdentity: { device: "3", inode: "0" },
    }),
  ).toThrow("identity");
  expect(() =>
    workerModelNamespaceBridgeArguments({
      ...captured,
      hostNetworkIdentity: { device: "5", inode: "not-captured" },
    }),
  ).toThrow("identity");
});
