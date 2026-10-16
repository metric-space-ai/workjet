import type { ArtifactBinding, CtoxAppApi, Kernel } from "./kernel/index";
import {
  bindKernelCtoxClient,
  getWorkjetKernelMount,
  type WorkjetKernelMount,
} from "./kernelClient";
import { commitActiveWorkjetSelection, readActiveWorkjetScope } from "../activeWorkjetScope";

export interface WorkjetAppModule {
  mount(
    root: HTMLElement,
    api: CtoxAppApi,
    ctx: { restored?: unknown },
  ):
    | { unmount(): void | Promise<void>; snapshot?(): unknown }
    | Promise<{ unmount(): void | Promise<void>; snapshot?(): unknown }>;
}
export type WorkjetMountOptions = { appVersion: string; restored?: unknown } & (
  | { module: WorkjetAppModule; loadModule?: never }
  | { module?: never; loadModule(binding: ArtifactBinding): Promise<WorkjetAppModule> }
);
const transitions = new WeakMap<HTMLElement, Promise<unknown>>();
/** Serialize replacements of the same DOM root, including asynchronous module teardown. */
export function mountWorkjetHost(root: HTMLElement, kernel: Kernel, options: WorkjetMountOptions) {
  const previous = transitions.get(root) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => mountWorkjetHostSerial(root, kernel, options));
  transitions.set(root, next);
  void next
    .finally(() => {
      if (transitions.get(root) === next) transitions.delete(root);
    })
    .catch(() => {});
  return next;
}
const roots = new WeakMap<HTMLElement, { unmount(): Promise<void>; snapshot(): unknown }>();
function snapshotValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  const cloned = structuredClone(value);
  const seen = new Set<object>();
  let bytes = 0;
  const visit = (entry: unknown): void => {
    if (typeof entry === "string") bytes += new TextEncoder().encode(entry).byteLength;
    else if (entry === null || typeof entry !== "object") bytes += 8;
    else if (!seen.has(entry)) {
      seen.add(entry);
      bytes += 16;
      if (entry instanceof Blob) bytes += entry.size;
      else if (entry instanceof ArrayBuffer || ArrayBuffer.isView(entry)) bytes += entry.byteLength;
      else if (entry instanceof Map)
        for (const [key, value] of entry) {
          visit(key);
          visit(value);
        }
      else if (entry instanceof Set) for (const value of entry) visit(value);
      else
        for (const [key, value] of Object.entries(entry)) {
          visit(key);
          visit(value);
        }
    }
    if (bytes > 1_048_576) throw new Error("invalid_workjet_mount_snapshot");
  };
  visit(cloned);
  return cloned;
}

/** Host boundary only: the caller supplies its authenticated kernel and actual Workjet module. */
async function mountWorkjetHostSerial(
  root: HTMLElement,
  kernel: Kernel,
  options: WorkjetMountOptions,
): Promise<{ context: WorkjetKernelMount; snapshot(): unknown; unmount(): Promise<void> }> {
  await kernel.ready;
  const previous = roots.get(root);
  const restored =
    options.restored === undefined ? previous?.snapshot() : snapshotValue(options.restored);
  await previous?.unmount();
  const selectionBefore = readActiveWorkjetScope().selectedInstanceId;
  const release = bindKernelCtoxClient(kernel, options.appVersion);
  const context = getWorkjetKernelMount(kernel.instanceId)!;
  commitActiveWorkjetSelection(kernel.instanceId);
  try {
    const module = options.module ?? (await options.loadModule(context.artifacts));
    const mounted = await module.mount(root, context.api, { restored });
    let stopping: Promise<void> | undefined;
    let finalSnapshot: unknown;
    const handle = {
      context,
      snapshot: () => snapshotValue(stopping ? finalSnapshot : mounted.snapshot?.()),
      unmount: (): Promise<void> => {
        if (stopping) return stopping;
        try {
          finalSnapshot = snapshotValue(mounted.snapshot?.());
        } catch {
          finalSnapshot = undefined;
        }
        stopping = Promise.resolve()
          .then(() => mounted.unmount())
          .finally(() => {
            release();
            if (roots.get(root) === handle) roots.delete(root);
            if (
              readActiveWorkjetScope().selectedInstanceId === kernel.instanceId &&
              getWorkjetKernelMount(kernel.instanceId) === null
            )
              commitActiveWorkjetSelection(selectionBefore);
          });
        return stopping;
      },
    };
    roots.set(root, handle);
    return handle;
  } catch (error) {
    release();
    if (getWorkjetKernelMount(kernel.instanceId) === null)
      commitActiveWorkjetSelection(selectionBefore);
    try {
      await kernel.activation.reportFailed("workjet", options.appVersion, "workjet_mount_failed");
    } catch {
      /* Preserve the original mount failure if its diagnostic transport is also unavailable. */
    }
    throw error;
  }
}
