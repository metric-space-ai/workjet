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
    // Kernel pin eca39cf84 adds the read-only navigation probe; the dev stub knows no targets, and
    // its navigate lacks the kernel's ref overload (Promise<boolean>), which the stub never resolves.
    shell: {
      ...legacy.shell,
      canNavigate: () => false,
      navigate: legacy.shell.navigate as CtoxAppApi["shell"]["navigate"],
    },
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
    // The legacy dev stub predates E51 api.prefs (ctox #912) and refuses it like record_id.
    prefs: {
      get: () => {
        throw new Error("legacy_stub_prefs_not_supported");
      },
      set: () => {
        throw new Error("legacy_stub_prefs_not_supported");
      },
      delete: () => {
        throw new Error("legacy_stub_prefs_not_supported");
      },
    },
    metrics: {
      get: () => {
        const value = legacy.metrics.get();
        return {
          ...value,
          collections: {},
          commands: [],
          link: { ...value.link, state: value.link.state === "online" ? "online" : "offline" },
        };
      },
      subscribe: (callback) => legacy.metrics.subscribe(() => callback(api.metrics.get())),
      commands: [],
    },
    // Legacy stub fixture (pre-K-WJ-2 files API); only the forms below are modelled.
    files: {
      ...legacy.files,
      put: ((blob: Blob, meta?: { id?: string; name?: string; mime?: string }) => {
        if (!(blob instanceof Blob)) throw new Error("legacy_stub_put_requires_blob");
        const handle = legacy.files.put(blob, meta);
        return {
          ...handle,
          result: handle.result.then((value) => ({ ...normalizeResult(value), ref: value.ref })),
        };
      }) as CtoxAppApi["files"]["put"],
      list: () => Promise.reject(new Error("legacy_stub_files_list_unsupported")),
      delete: () => Promise.reject(new Error("legacy_stub_files_delete_unsupported")),
    } as unknown as CtoxAppApi["files"],
    // Legacy stub fixture: model.run (#830) is not modelled.
    model: {
      run: () => Promise.reject(new Error("legacy_stub_model_unsupported")),
    } as unknown as CtoxAppApi["model"],
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
