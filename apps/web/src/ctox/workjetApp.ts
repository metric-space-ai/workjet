import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryHistory } from "@tanstack/react-router";
import { AppRoot } from "../AppRoot";
import { getRouter } from "../router";
import { getBoundCtoxClientInstance, type CtoxAppApi } from "./ctoxClient";
import { getWorkjetKernelMount } from "./kernelClient";
import { mountWorkjetHost } from "./hostMount";
import type { Kernel } from "./kernel/index";

/** V4 app entry (§10.2a): the existing Workjet UI, with Shell/Core identity rather than a server login. */
export function mount(root: HTMLElement, api: CtoxAppApi, _ctx: { restored?: unknown }) {
  const instanceId = getBoundCtoxClientInstance(api);
  if (instanceId === null || getWorkjetKernelMount(instanceId)?.api !== api)
    throw new Error("ctox_host_unbound");
  const router = getRouter(createMemoryHistory({ initialEntries: ["/"] }));
  const tree = createRoot(root);
  tree.render(createElement(AppRoot, { router }));
  // Form/focus snapshots remain the Shell/UI module's generic lifecycle (§10.2a), not a second data store.
  return { unmount: () => tree.unmount() };
}

/** The desktop/Shell bootstrap passes its already authenticated real kernel. */
export function mountWorkjet(
  root: HTMLElement,
  kernel: Kernel,
  options: { appVersion: string; restored?: unknown },
) {
  return mountWorkjetHost(root, kernel, { ...options, module: { mount } });
}
