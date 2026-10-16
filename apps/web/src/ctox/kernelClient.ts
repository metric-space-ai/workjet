import { createKernel } from "./kernel/kernel.mjs";
import type { ArtifactBinding, Kernel, KernelOptions, KernelTransport } from "./kernel/index";
import { bindCtoxClient, getCtoxClient, subscribeCtoxClients } from "./ctoxClient";

export interface WorkjetKernelMount {
  readonly kernel: Kernel;
  readonly artifacts: ArtifactBinding;
  readonly api: ReturnType<Kernel["appApi"]>;
}
const mounts = new Map<string, WorkjetKernelMount>();
export function getWorkjetKernelMount(instanceId: string | null): WorkjetKernelMount | null {
  if (instanceId === null) return null;
  const mount = mounts.get(instanceId);
  return mount && getCtoxClient(instanceId) === mount.api ? mount : null;
}
export { subscribeCtoxClients as subscribeWorkjetKernelMounts };

/** One binding per mount freezes shell/library versions. The Shell retains kernel ownership. */
export function bindKernelCtoxClient(kernel: Kernel, appVersion: string): () => void {
  if (!appVersion.trim()) throw new Error("invalid_ctox_app_version");
  const api = kernel.appApi("workjet", appVersion);
  if (api.actor.id !== kernel.userId) throw new Error("invalid_ctox_actor_scope");
  const mount = { kernel, api, artifacts: kernel.artifacts.bind("workjet", appVersion) };
  mounts.set(kernel.instanceId, mount);
  const unbind = bindCtoxClient(kernel.instanceId, api);
  return () => {
    if (mounts.get(kernel.instanceId) === mount) mounts.delete(kernel.instanceId);
    unbind();
  };
}

/** Standalone hosts supply authenticated WebRTC; never a default test transport or test identity. */
export async function openKernelCtoxClient(
  options: Omit<KernelOptions, "storage"> & { transport: KernelTransport; appVersion: string },
) {
  if (!options.instanceId.trim() || !options.userId.trim() || !options.transport)
    throw new Error("invalid_ctox_kernel_scope");
  const { appVersion, ...kernelOptions } = options;
  const kernel = createKernel({ ...kernelOptions, storage: "indexeddb" });
  try {
    await kernel.ready;
    if (kernel.storageKind !== "indexeddb") throw new Error("ctox_indexeddb_required");
    const unbind = bindKernelCtoxClient(kernel, appVersion);
    const api = getCtoxClient(kernel.instanceId)!;
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
