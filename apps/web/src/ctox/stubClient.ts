import { bindCtoxClient } from "./ctoxClient";
import { createStubKernel } from "./stub/ctox-app-api-stub.mjs";
import type { StubKernelOptions } from "./stub/index";

/** Explicit development/test host only. Production receives its API from the V4 Shell mount. */
export async function openStubCtoxClient(
  options: StubKernelOptions & { instanceId: string; userId: string; appVersion: string },
) {
  if (!options.instanceId.trim() || !options.userId.trim() || !options.appVersion.trim())
    throw new Error("invalid_stub_scope");
  const { appVersion, ...kernelOptions } = options;
  const kernel = createStubKernel(kernelOptions);
  await kernel.ready;
  const api = kernel.appApi("workjet", appVersion);
  const unbind = bindCtoxClient(options.instanceId, api);
  let closed = false;
  return {
    api,
    kernel,
    close: async () => {
      if (closed) return;
      closed = true;
      unbind();
      await kernel.close();
    },
  };
}
