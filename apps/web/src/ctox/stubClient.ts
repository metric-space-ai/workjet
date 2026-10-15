import { bindCtoxClient } from "./ctoxClient";
import { createStubKernel } from "./stub/ctox-app-api-stub.mjs";
import type { StubKernelOptions } from "./stub/index";
import type { CtoxAppApi, WriteResult } from "./ctoxClient";
import type { WriteResult as StubWriteResult } from "./stub/index";

/** The historical test host has numeric sequences; the real API uses decimal strings. */
function normalizeResult(result: StubWriteResult): WriteResult {
  const { seq, ...rest } = result;
  return { ...rest, ...(seq === undefined ? {} : { seq: String(seq) }) };
}

/** Explicit development/test host only. Production receives its API from the V4 Shell mount. */
export async function openStubCtoxClient(
  options: StubKernelOptions & { instanceId: string; userId: string; appVersion: string },
) {
  if (!options.instanceId.trim() || !options.userId.trim() || !options.appVersion.trim())
    throw new Error("invalid_stub_scope");
  const { appVersion, ...kernelOptions } = options;
  const kernel = createStubKernel(kernelOptions);
  await kernel.ready;
  const legacy = kernel.appApi("workjet", appVersion);
  const api: CtoxAppApi = {
    ...legacy,
    put: (collection, doc) => {
      const handle = legacy.put(collection, doc);
      return { ...handle, result: handle.result.then(normalizeResult) };
    },
    patch: (collection, id, patch) => {
      const handle = legacy.patch(collection, id, patch);
      return { ...handle, result: handle.result.then(normalizeResult) };
    },
    remove: (collection, id) => {
      const handle = legacy.remove(collection, id);
      return { ...handle, result: handle.result.then(normalizeResult) };
    },
    command: (type, payload, commandOptions) => {
      if (commandOptions?.record_id !== undefined)
        throw new Error("legacy_stub_record_id_not_supported");
      const handle = legacy.command(type, payload);
      return { ...handle, result: handle.result.then(normalizeResult) };
    },
    metrics: {
      get: () => {
        const value = legacy.metrics.get();
        return {
          ...value,
          link: { ...value.link, state: value.link.state === "online" ? "online" : "offline" },
        };
      },
      subscribe: (callback) => legacy.metrics.subscribe(() => callback(api.metrics.get())),
    },
    files: {
      ...legacy.files,
      put: (blob, meta) => {
        const handle = legacy.files.put(blob, meta);
        return {
          ...handle,
          result: handle.result.then((value) => ({ ...normalizeResult(value), ref: value.ref })),
        };
      },
    },
  };
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
