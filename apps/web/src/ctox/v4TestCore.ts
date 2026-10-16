// Test host for Scheibe C consumer gates: a memory kernel on the vendored fake core with the
// active Workjet manifest and the foreign-collection owner published before it opens (E35 Nr. 3).
import { vi } from "vite-plus/test";
import { createKernel } from "./kernel/kernel.mjs";
import { MemoryCoreTransport } from "./kernel/fake-core.mjs";
import type { Kernel } from "./kernel/index";
import { bindKernelCtoxClient } from "./kernelClient";
import { getCtoxClient } from "./ctoxClient";
import { WORKJET_APP_ID, WORKJET_FOREIGN_COLLECTIONS, workjetAppManifest } from "./workjetAppManifest";
import { commitActiveWorkjetSelection } from "../activeWorkjetScope";

const APP_VER = "v4-consumers";
let sequence = 0;
export const openV4Kernels: { kernel: Kernel; release: () => void }[] = [];
/** afterEach: clear the selection and close every kernel this host opened. */
export async function closeV4Kernels() {
  commitActiveWorkjetSelection(null);
  for (const { kernel, release } of openV4Kernels.splice(0)) {
    release();
    await kernel.close();
  }
}

export async function openV4(select = true) {
  const instanceId = `v4-consumer-${++sequence}`;
  const transport = new MemoryCoreTransport({ namespace: instanceId, latencyMs: 0 });
  await transport.push("business_app_versions", [
    {
      id: `${WORKJET_APP_ID}@${APP_VER}`,
      app_id: WORKJET_APP_ID,
      app_ver: APP_VER,
      manifest: workjetAppManifest(APP_VER),
    },
    {
      id: "ctox@v4-consumers",
      app_id: "ctox",
      app_ver: "v4-consumers",
      manifest: {
        app_id: "ctox",
        app_ver: "v4-consumers",
        min_app_api: "4.0",
        collections: Object.fromEntries(
          [...new Set(WORKJET_FOREIGN_COLLECTIONS)].map((name) => [name, { class: "eager" }]),
        ),
        handlers: {},
      },
    },
  ]);
  await transport.push("business_apps", [
    { id: "ctox", title: "Crew", active_ver: "v4-consumers" },
    { id: WORKJET_APP_ID, title: "Workjet", active_ver: APP_VER },
    { id: "shell", title: "Shell", active_ver: "v4-consumers-shell" },
  ]);
  const kernel = createKernel({
    instanceId,
    userId: "consumer-owner",
    storage: "memory",
    dbName: `${instanceId}-db`,
    multiTab: false,
    transport,
  });
  await kernel.ready;
  const apps = kernel.appApi(WORKJET_APP_ID, APP_VER).query<{ id: string }>("business_apps", {});
  const offApps = apps.subscribe(() => {});
  await vi
    .waitFor(
      () => {
        if (!apps.get().some((row) => row.id === "shell")) throw new Error("shell not synced");
      },
      { timeout: 2_000, interval: 5 },
    )
    .finally(offApps);
  const release = bindKernelCtoxClient(kernel, APP_VER);
  openV4Kernels.push({ kernel, release });
  if (select) commitActiveWorkjetSelection(instanceId);
  const api = getCtoxClient(instanceId)!;
  const seed = async (collection: string, docs: { id: string; [key: string]: unknown }[]) => {
    const live = api.query<{ id: string }>(collection, {});
    const off = live.subscribe(() => {});
    try {
      await transport.push(collection, docs);
      await vi.waitFor(
        () => {
          const ids = new Set(live.get().map((row) => row.id));
          if (!docs.every((doc) => ids.has(doc.id))) throw new Error(`${collection} not synced`);
        },
        { timeout: 2_000, interval: 5 },
      );
    } finally {
      off();
    }
  };
  return { instanceId, release, seed };
}

