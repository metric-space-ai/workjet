// Scheibe C (E49.1, E41): Workjet Desktop is a direct V4 client of an instance. The host mounts
// the Workjet kernel client only when the instance's launch context reports V4 (a valid `v4`
// member, E38.3/E41). A V3 instance never gets a mount, so every gated consumer keeps its
// desktop guest path. The check runs on every instance switch and every reconnect.
import { bootV4, parseV4LaunchContext } from "./kernel/boot.mjs";
import { createKernel } from "./kernel/kernel.mjs";
import type { Kernel, KernelLoader, LoaderOptions } from "./kernel/index";
import { mountWorkjetHost, type WorkjetAppModule } from "./hostMount";

/**
 * Reads the authenticated launch context of exactly this Workjet instance through the desktop
 * control plane. Resolves the response object (only its `v4` member is used), `null` when the
 * instance answers without one; rejects when the control plane cannot reach the instance.
 */
export type WorkjetLaunchContextReader = (instanceId: string) => Promise<unknown>;

export type WorkjetCoreGeneration = "v4" | "v3";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** E41: V4 exactly when the launch context carries a `v4` member that passes the kernel contract. */
export function detectWorkjetCoreGeneration(payload: unknown): WorkjetCoreGeneration {
  if (!isRecord(payload) || payload.v4 === undefined || payload.v4 === null) return "v3";
  try {
    parseV4LaunchContext(payload);
    return "v4";
  } catch {
    // An incomplete v4 member (no signaling, no package key) cannot open a verified transport.
    return "v3";
  }
}

/**
 * Workjet selects instances by its own managed id; the core names itself in the launch context.
 * The gates (`getCtoxClient(selectedInstanceId)`) and the active selection must stay on the
 * Workjet id, so the host presents the kernel under that id. Identity checks inside the kernel
 * (session, hello, scope tokens) keep using the core id.
 */
export function scopeKernelToWorkjetInstance(kernel: Kernel, workjetInstanceId: string): Kernel {
  if (kernel.instanceId === workjetInstanceId) return kernel;
  return new Proxy(kernel, {
    get(target, property) {
      if (property === "instanceId") return workjetInstanceId;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Workjet is not a Business OS shell: the kernel runs without a shell module or service worker. */
export async function createWorkjetKernelLoader(options: LoaderOptions): Promise<KernelLoader> {
  const { serviceWorker: _serviceWorker, resolveShell: _resolveShell, ...kernelOptions } = options;
  const kernel = createKernel({ ...kernelOptions, storage: "indexeddb" });
  try {
    await kernel.ready;
  } catch (error) {
    await kernel.close();
    throw error;
  }
  let closed: Promise<void> | null = null;
  return Object.freeze({
    kernel,
    shellVersion: null,
    settle: async () => {},
    close: () => (closed ??= kernel.close()),
  });
}

export interface WorkjetV4Session {
  readonly kernel: Kernel;
  close(): Promise<void>;
}

/** Opens the authenticated V4 kernel from the launch context; the first hello is the one read. */
export async function bootWorkjetV4Session(
  instanceId: string,
  firstPayload: unknown,
  readLaunchContext: WorkjetLaunchContextReader,
): Promise<WorkjetV4Session> {
  let pending: unknown = firstPayload;
  // bootV4 re-fetches the launch context for every reconnect hello (single-use device proof).
  const fetchImpl = (async () => {
    const payload = pending === undefined ? await readLaunchContext(instanceId) : pending;
    pending = undefined;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const result = await bootV4({ fetchImpl, loaderFactory: createWorkjetKernelLoader });
  return { kernel: result.kernel, close: () => result.loader.close() };
}

export interface WorkjetV4HostOptions {
  readonly appVersion: string;
  readonly readLaunchContext: WorkjetLaunchContextReader;
  /** Test seam; default bootWorkjetV4Session. */
  readonly openSession?: (
    instanceId: string,
    payload: unknown,
    readLaunchContext: WorkjetLaunchContextReader,
  ) => Promise<WorkjetV4Session>;
  /** Test seam; default a detached element (Workjet renders its own UI, the mount only binds). */
  readonly createRoot?: () => HTMLElement;
}

export interface WorkjetV4HostState {
  readonly instanceId: string | null;
  readonly generation: WorkjetCoreGeneration | null;
}

/** Workjet's own module: the host binding is the whole mount; the UI stays Workjet's React tree. */
const bindingOnlyModule: WorkjetAppModule = {
  mount: () => ({ unmount: () => {} }),
};

interface ActiveMount {
  readonly instanceId: string;
  readonly session: WorkjetV4Session;
  readonly handle: { unmount(): Promise<void> };
}

/**
 * One controller per renderer. `sync` is serialized: an instance switch or reconnect waits for
 * the previous transition, then reads the launch context again and mounts, keeps or unmounts.
 */
export function createWorkjetV4Host(options: WorkjetV4HostOptions) {
  const openSession = options.openSession ?? bootWorkjetV4Session;
  // The root is only the mount's serialization key; nothing renders into it.
  const root =
    options.createRoot?.() ??
    (typeof document === "undefined"
      ? (Object.create(null) as HTMLElement)
      : document.createElement("div"));
  let active: ActiveMount | null = null;
  let state: WorkjetV4HostState = { instanceId: null, generation: null };
  let chain: Promise<unknown> = Promise.resolve();
  let disposed = false;
  const listeners = new Set<() => void>();
  const publish = (next: WorkjetV4HostState) => {
    if (next.instanceId === state.instanceId && next.generation === state.generation) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const unmount = async () => {
    const current = active;
    if (!current) return;
    active = null;
    try {
      await current.handle.unmount();
    } finally {
      await current.session.close().catch(() => {});
    }
  };
  const transition = async (instanceId: string | null): Promise<WorkjetV4HostState> => {
    if (disposed || instanceId === null) {
      await unmount();
      publish({ instanceId: null, generation: null });
      return state;
    }
    let payload: unknown;
    try {
      payload = await options.readLaunchContext(instanceId);
    } catch {
      // Unreachable control plane: keep a live V4 mount of this instance (the kernel reconnects
      // itself); never mount on an unverified answer. The next reconnect checks again.
      if (active?.instanceId !== instanceId) {
        await unmount();
        publish({ instanceId, generation: null });
      }
      return state;
    }
    if (disposed) return state;
    if (detectWorkjetCoreGeneration(payload) === "v3") {
      await unmount();
      publish({ instanceId, generation: "v3" });
      return state;
    }
    if (active?.instanceId === instanceId) {
      publish({ instanceId, generation: "v4" });
      return state;
    }
    await unmount();
    let session: WorkjetV4Session;
    try {
      session = await openSession(instanceId, payload, options.readLaunchContext);
    } catch (error) {
      // A V4 instance whose transport does not come up stays unmounted; no V3 guest fallback.
      publish({ instanceId, generation: null });
      throw error;
    }
    try {
      if (disposed) throw new Error("workjet_v4_host_disposed");
      const handle = await mountWorkjetHost(
        root,
        scopeKernelToWorkjetInstance(session.kernel, instanceId),
        { appVersion: options.appVersion, module: bindingOnlyModule },
      );
      active = { instanceId, session, handle };
      publish({ instanceId, generation: "v4" });
    } catch (error) {
      await session.close().catch(() => {});
      publish({ instanceId, generation: null });
      throw error;
    }
    return state;
  };
  const sync = (instanceId: string | null): Promise<WorkjetV4HostState> => {
    const next = chain.catch(() => {}).then(() => transition(instanceId?.trim() || null));
    chain = next;
    return next;
  };
  return {
    sync,
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async dispose() {
      disposed = true;
      await chain.catch(() => {});
      await unmount();
      publish({ instanceId: null, generation: null });
    },
  };
}
