import { createKernel } from "./kernel/kernel.mjs";
import type { Kernel, KernelOptions, KernelTransport } from "./kernel/index";
import { bindCtoxClient } from "./ctoxClient";

/** Borrow the Shell's real kernel. Unmount never closes a kernel owned by the Shell. */
export function bindKernelCtoxClient(kernel: Kernel, appVersion: string): () => void {
  if (!appVersion.trim()) throw new Error("invalid_ctox_app_version");
  const api = kernel.appApi("workjet", appVersion);
  if (api.actor.id !== kernel.userId) throw new Error("invalid_ctox_actor_scope");
  return bindCtoxClient(kernel.instanceId, api);
}

/** Standalone hosts supply their authenticated WebRTC transport; there is no default test transport. */
export async function openKernelCtoxClient(
  options: Omit<KernelOptions, "storage"> & {
    transport: KernelTransport;
    appVersion: string;
  },
) {
  if (!options.instanceId.trim() || !options.userId.trim() || !options.transport)
    throw new Error("invalid_ctox_kernel_scope");
  const { appVersion, ...kernelOptions } = options;
  const kernel = createKernel({ ...kernelOptions, storage: "indexeddb" });
  try {
    await kernel.ready;
    if (kernel.storageKind !== "indexeddb") throw new Error("ctox_indexeddb_required");
    const api = kernel.appApi("workjet", appVersion);
    if (api.actor.id !== kernel.userId) throw new Error("invalid_ctox_actor_scope");
    const unbind = bindCtoxClient(kernel.instanceId, api);
    let closed = false;
    return {
      kernel,
      api,
      close: async () => {
        if (closed) return;
        closed = true;
        unbind();
        await kernel.close();
      },
    };
  } catch (error) {
    await kernel.close();
    throw error;
  }
}
