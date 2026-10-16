// Scheibe C consumers: thread state, Luma, gateway and calendar atoms read the local kernel on a
// V4 instance (bound kernel client) and keep the legacy environment RPC atom on V3.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { EnvironmentId, ThreadId } from "@workjet/contracts";
import { createKernel } from "./kernel/kernel.mjs";
import { MemoryCoreTransport } from "./kernel/fake-core.mjs";
import type { Kernel } from "./kernel/index";
import { bindKernelCtoxClient } from "./kernelClient";
import { getCtoxClient } from "./ctoxClient";
import { WORKJET_APP_ID, WORKJET_FOREIGN_COLLECTIONS, workjetAppManifest } from "./workjetAppManifest";
import { gateCtoxReadFamily } from "./v4GatedAtoms";
import { CtoxLocalReadError } from "./projectReadData";
import { commitActiveWorkjetSelection } from "../activeWorkjetScope";
import { serverEnvironment } from "../state/server";
import { environmentThreads } from "../state/threads";

const APP_VER = "v4-consumers";
let sequence = 0;
const open: { kernel: Kernel; release: () => void }[] = [];
afterEach(async () => {
  commitActiveWorkjetSelection(null);
  for (const { kernel, release } of open.splice(0)) {
    release();
    await kernel.close();
  }
});

async function openV4(select = true) {
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
  open.push({ kernel, release });
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

function isLocalFailure(result: unknown): boolean {
  if (!AsyncResult.isAsyncResult(result) || !AsyncResult.isFailure(result)) return false;
  const error = Cause.squash(result.cause);
  return error instanceof CtoxLocalReadError;
}
const environmentId = EnvironmentId.make("consumer-computer");

describe("gateCtoxReadFamily", () => {
  it("V3 reads and refreshes the legacy atom; a bound V4 kernel switches live to the local read", async () => {
    let legacyReads = 0;
    const legacy = Atom.family((key: string) =>
      Atom.make(() => {
        legacyReads++;
        return `legacy:${key}`;
      }),
    );
    const local = Atom.family((key: string) => Atom.make(() => `v4:${key}`));
    const gated = gateCtoxReadFamily(
      (input: { id: string }) => legacy(input.id),
      (input: { id: string }) => local(input.id),
    );
    const registry = AtomRegistry.make();
    const atom = gated({ id: "x" });
    const values: string[] = [];
    const off = registry.subscribe(atom, (value) => values.push(value), { immediate: true });
    expect(registry.get(atom)).toBe("legacy:x");
    registry.refresh(atom);
    expect(legacyReads).toBe(2);
    const { release } = await openV4();
    await vi.waitFor(() => expect(registry.get(atom)).toBe("v4:x"));
    release();
    await vi.waitFor(() => expect(registry.get(atom)).toBe("legacy:x"));
    off();
    expect(values).toContain("v4:x");
  });
});

describe("Scheibe C consumers on V4: local kernel reads, no environment RPC", () => {
  it("gateway status", async () => {
    const { seed } = await openV4();
    await seed("workjet_gateway_state", [
      {
        id: "gateway",
        schemaVersion: 1,
        phase: "ready",
        pid: null,
        providerEndpoint: null,
        managementEndpoint: null,
        failureReason: null,
        configuredAccountCount: 2,
        configuredModelCount: 3,
      },
    ]);
    const registry = AtomRegistry.make();
    const atom = serverEnvironment.workjetGatewayStatus({ environmentId, input: {} });
    const off = registry.subscribe(atom, () => {});
    try {
      const result = registry.get(atom);
      expect(AsyncResult.isSuccess(result)).toBe(true);
      if (AsyncResult.isSuccess(result)) expect(result.value.configuredModelCount).toBe(3);
    } finally {
      off();
    }
  });

  it("calendar accounts", async () => {
    const { seed, instanceId } = await openV4();
    await seed("workjet_connections", [
      {
        id: "connection-1",
        environment_id: environmentId,
        connectionId: "connection-1",
        instanceId,
        displayName: "Consumer",
        source: "ctox",
        status: "ready",
        reason: null,
      },
    ]);
    await seed("workjet_calendar_state", [{ id: "accounts", truncated: false }]);
    const registry = AtomRegistry.make();
    const atom = serverEnvironment.calendarAccounts({
      environmentId,
      input: { connectionId: "connection-1" as never, instanceId },
    });
    const off = registry.subscribe(atom, () => {});
    try {
      const result = registry.get(atom);
      // Local read: either the decoded projection or a typed local error, never an RPC wait.
      expect(AsyncResult.isSuccess(result) || isLocalFailure(result)).toBe(true);
      expect(AsyncResult.isWaiting(result)).toBe(false);
    } finally {
      off();
    }
  });

  it("Luma configuration", async () => {
    await openV4();
    const registry = AtomRegistry.make();
    const atom = serverEnvironment.lumaConfiguration({
      environmentId,
      input: { connectionId: "connection-1", instanceId: "i" } as never,
    });
    const off = registry.subscribe(atom, () => {});
    try {
      // No connection row: the local correlation guard refuses, without reaching the RPC.
      expect(isLocalFailure(registry.get(atom))).toBe(true);
    } finally {
      off();
    }
  });

  it("thread state", async () => {
    await openV4();
    const registry = AtomRegistry.make();
    const atom = environmentThreads.stateAtom(environmentId, ThreadId.make("missing-thread"));
    const off = registry.subscribe(atom, () => {});
    try {
      const result = registry.get(atom);
      expect(AsyncResult.isSuccess(result)).toBe(true);
      if (AsyncResult.isSuccess(result)) expect(result.value.status).toBe("empty");
    } finally {
      off();
    }
  });
});

describe("Scheibe C consumers on V3: unchanged environment RPC atoms", () => {
  it("no bound client: gateway, calendar, Luma and thread state never read the kernel", async () => {
    // Another instance is V4, but the selected one is V3.
    await openV4(false);
    commitActiveWorkjetSelection(`v3-consumer-${++sequence}`);
    const registry = AtomRegistry.make();
    const atoms = [
      serverEnvironment.workjetGatewayStatus({ environmentId, input: {} }),
      serverEnvironment.calendarAccounts({
        environmentId,
        input: { connectionId: "connection-1" as never, instanceId: "i" },
      }),
      serverEnvironment.lumaConfiguration({
        environmentId,
        input: { connectionId: "connection-1", instanceId: "i" } as never,
      }),
      environmentThreads.stateAtom(environmentId, ThreadId.make("v3-thread")),
    ] as Atom.Atom<unknown>[];
    for (const atom of atoms) {
      const off = registry.subscribe(atom, () => {});
      try {
        expect(isLocalFailure(registry.get(atom))).toBe(false);
      } finally {
        off();
      }
    }
  });
});
