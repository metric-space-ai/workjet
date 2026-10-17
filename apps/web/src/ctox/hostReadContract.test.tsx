import { prepareJourFixeNarration } from "../lib/jourFixeNarration";
import { CtoxError } from "./kernel/values.mjs";
import {
  jourFixeCacheKey,
  readJourFixeCache,
  writeJourFixeCache,
  setJourFixeCacheBackend,
} from "../lib/jourFixeCache";
import { CommandId, ProjectId } from "@workjet/contracts";
import { platformView, seedKernelTestShell } from "./kernelTestHost";
import { readLocalProjectFile } from "./projectFileData";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vite-plus/test";
import { createKernel } from "./kernel/kernel.mjs";
import { KernelTransport } from "./kernel/transport.mjs";
import { mountWorkjetHost } from "./hostMount";
import { collectionLiveness, useCtoxCollectionLiveness } from "./liveness";
import { getCtoxClient } from "./ctoxClient";
import { readLocalProjectControl, useCtoxProjectRead, localReadFailure } from "./projectReadData";
import { installDom } from "../test/localReactDom";
import type { Kernel, Metrics } from "./kernel/index";

it("serializes host replacements and binds artifacts exactly once per mount", async () => {
  installDom();
  const kernel = createKernel({
    instanceId: "host-contract",
    userId: "owner",
    storage: "memory",
    dbName: "p11c-host",
    multiTab: false,
    transport: new KernelTransport(),
  });
  await kernel.ready;
  await seedKernelTestShell(kernel);
  const root = document.createElement("div");
  let bindings = 0;
  const counted: Kernel = {
    ...kernel,
    artifacts: {
      ...kernel.artifacts,
      bind: (...args) => {
        bindings++;
        return kernel.artifacts.bind(...args);
      },
    },
  };
  const order: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let releaseStop: (() => void) | undefined;
  const stopFence = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const first = mountWorkjetHost(root, counted, {
    appVersion: "one",
    module: {
      mount: async (_root, api) => {
        order.push("one-start");
        expect(getCtoxClient(kernel.instanceId)).toBe(api);
        await waiting;
        order.push("one-ready");
        return {
          snapshot: () => ({ draft: "keep" }),
          unmount: async () => {
            order.push("one-stop");
            await stopFence;
          },
        };
      },
    },
  });
  const second = mountWorkjetHost(root, counted, {
    appVersion: "two",
    module: {
      mount: (_root, _api, ctx) => {
        order.push("two-start");
        expect(ctx.restored).toEqual({ draft: "keep" });
        return {
          unmount: () => {
            order.push("two-stop");
          },
        };
      },
    },
  });
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(order).not.toContain("two-start");
    releaseFirst!();
    const initial = await first;
    const externalStop = initial.unmount();
    expect(initial.unmount()).toBe(externalStop);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).not.toContain("two-start");
    releaseStop!();
    await externalStop;
    const mounted = await second;
    expect(bindings).toBe(2);
    expect(order).toEqual(["one-start", "one-ready", "one-stop", "two-start"]);
    await expect(
      mountWorkjetHost(root, counted, {
        appVersion: "oversized",
        restored: new Map([["bytes", new Uint8Array(1_048_577)]]),
        module: { mount: () => ({ unmount() {} }) },
      }),
    ).rejects.toThrow("invalid_workjet_mount_snapshot");
    expect(bindings).toBe(2);
    await mounted.unmount();
    await mounted.unmount();
    expect(getCtoxClient(kernel.instanceId)).toBeNull();
    expect(order.filter((value) => value === "two-stop")).toHaveLength(1);
    expect(kernel.storageKind).toBe("memory");
  } finally {
    releaseFirst!();
    releaseStop!();
    await kernel.close();
  }
});

it("keeps missing or catching-up collection metrics non-live", () => {
  const metrics = {
    collections: {
      "projects@g1": { state: "live", backlog: 0, gen: 1, since_ms: 1 },
      "kpis@g2": { state: "catching_up", backlog: 1, gen: 2, since_ms: 1 },
    },
  } as unknown as Metrics;
  expect(collectionLiveness(metrics, ["projects", "kpis"]).allLive).toBe(false);
  expect(collectionLiveness(metrics, ["projects", "missing"]).allLive).toBe(false);
  expect(collectionLiveness(metrics, ["projects"]).allLive).toBe(true);
});

it("reads and updates a scoped projection without a guest and drops it on unmount", async () => {
  installDom();
  const kernel = createKernel({
    instanceId: "read-contract",
    userId: "owner",
    deviceId: "actual-device",
    storage: "memory",
    dbName: "p11c-read",
    multiTab: false,
    transport: new KernelTransport(),
  });
  await kernel.ready;
  await seedKernelTestShell(kernel);
  const element = document.createElement("div");
  const root = createRoot(element);
  let result: unknown;
  let liveness: ReturnType<typeof useCtoxCollectionLiveness> | undefined;
  const request = {
    action: "project.jour_fixe.meeting.read",
    projectId: ProjectId.make("p"),
    commandId: CommandId.make("request"),
  } as const;
  function Probe() {
    result = useCtoxProjectRead(kernel.instanceId, request);
    liveness = useCtoxCollectionLiveness(kernel.instanceId, ["workjet_jour_fixe_meetings"]);
    return createElement("output", null, JSON.stringify(result));
  }
  let host!: Awaited<ReturnType<typeof mountWorkjetHost>>;
  await act(async () => {
    host = await mountWorkjetHost(element, kernel, {
      appVersion: "read",
      module: {
        mount: () => {
          root.render(createElement(Probe));
          return { unmount: () => root.unmount() };
        },
      },
    });
  });
  try {
    await act(async () => {});
    expect(liveness?.deviceId).toBe("actual-device");

    expect(result).toMatchObject({ _tag: "completed", response: { meeting: null } });
    await act(async () => {
      await kernel.receivePage({
        epoch: "1",
        collection: "workjet_jour_fixe_meetings",
        scope_hash: "local",
        gen: 1,
        cursor_to: "1",
        complete: true,
        docs: [
          {
            id: "foreign",
            seq: "1",
            rev: "1",
            data: { id: "foreign", project_id: "other", is_current: true },
          },
        ],
      });
    });
    expect(result).toMatchObject({ _tag: "completed", response: { meeting: null } });
    expect(readLocalProjectControl(host.context.api, request)).toMatchObject({ meeting: null });
    expect(liveness?.requested.workjet_jour_fixe_meetings?.[0]?.state).toBe("offline");
    await act(async () => {
      await kernel.receivePage({
        epoch: "1",
        collection: "workjet_jour_fixe_meetings",
        scope_hash: "local",
        gen: 1,
        cursor_to: "2",
        complete: true,
        docs: [
          {
            id: "owned",
            seq: "2",
            rev: "2",
            data: { id: "owned", project_id: "p", is_current: true },
          },
        ],
      });
    });
    expect(result).toMatchObject({
      _tag: "failed",
      error: { code: "invalid", reason: "projection_schema_invalid" },
    });
    let legacyCacheAccesses = 0;
    setJourFixeCacheBackend({
      get: async () => {
        legacyCacheAccesses++;
        return { stale: true };
      },
      set: async () => {
        legacyCacheAccesses++;
      },
    });
    try {
      const key = jourFixeCacheKey.meeting(kernel.instanceId, "p");
      expect(await readJourFixeCache(key)).toBeUndefined();
      await writeJourFixeCache(key, { stale: true });
      expect(legacyCacheAccesses).toBe(0);
    } finally {
      setJourFixeCacheBackend(null);
    }
    let injectedReads = 0;
    await expect(
      prepareJourFixeNarration({
        scope: {
          instanceId: kernel.instanceId,
          projectId: "p",
          meetingId: "owned",
          deckRevision: 1,
        },
        slideId: "s",
        signal: new AbortController().signal,
        port: async () => {
          injectedReads++;
          return { _tag: "failed", code: "not_active" };
        },
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(injectedReads).toBe(0);
    expect(platformView(kernel).query("business_commands", {}).get()).toEqual([]);
    await act(async () => host.unmount());
    await expect(liveness!.reconnect()).rejects.toThrow("ctox_client_unavailable");
  } finally {
    await act(async () => host.unmount());
    await kernel.close();
  }
});

it("rejects a file generation changed while the actual kernel CAS transfer is in flight", async () => {
  installDom();
  const content = new TextEncoder().encode("presentation document");
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", content)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  let releaseBlob: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    releaseBlob = resolve;
  });
  class FileTransport extends KernelTransport {
    override async connect(
      _identity: Parameters<KernelTransport["connect"]>[0],
      events: Parameters<KernelTransport["connect"]>[1],
    ) {
      events.link({ state: "online", rtt_ms: 0, relay: false });
    }
    override async blob() {
      await waiting;
      return new Blob([content]);
    }
  }
  const kernel = createKernel({
    instanceId: "file-contract",
    userId: "owner",
    storage: "memory",
    dbName: "p11c-file",
    multiTab: false,
    transport: new FileTransport(),
  });
  await kernel.ready;
  await seedKernelTestShell(kernel, { workjetAppVer: "file" });
  const host = await mountWorkjetHost(document.createElement("div"), kernel, {
    appVersion: "file",
    module: { mount: () => ({ unmount() {} }) },
  });
  const page = async (collection: string, id: string, seq: string, data: object) =>
    kernel.receivePage({
      epoch: "1",
      collection,
      scope_hash: "local",
      gen: 1,
      cursor_to: seq,
      complete: true,
      docs: [{ id, seq, rev: seq, data: { id, ...data } }],
    });
  const file = {
    ref: digest,
    generation_id: "generation",
    size: content.length,
    owner_app: "workjet",
  };
  try {
    await page("workjet_presentations", "presentation", "1", {
      presentation_id: "presentation",
      project_id: "p",
      meeting_id: "meeting",
      owner_user_id: "owner",
      title: "Deck",
      revision: 1,
      document_schema: "learnordie.slide.v1",
      document_file_id: "file",
      document_generation_id: "generation",
      document_sha256: digest,
      document_bytes: content.length,
      slide_ids: ["slide"],
      source: "agent",
      updated_by: "owner",
      updated_at_ms: 1,
    });
    await page("files", "file", "2", file);
    const reading = readLocalProjectFile(host.context.api, {
      action: "project.presentation.content.read",
      commandId: CommandId.make("read"),
      projectId: ProjectId.make("p"),
      meetingId: "meeting",
      presentationId: "presentation",
      revision: 1,
      offset: 0,
      length: content.length,
    });
    await page("files", "file", "3", { ...file, generation_id: "replacement" });
    releaseBlob!();
    await expect(reading).rejects.toMatchObject({ reason: "file_integrity_failed" });
  } finally {
    releaseBlob!();
    await host.unmount();
    await kernel.close();
  }
});

it("preserves the real kernel failure code at the compatibility boundary", () => {
  expect(
    localReadFailure(
      new CtoxError("forbidden", "not a display caption", { path: "workjet_projects" }),
    ),
  ).toMatchObject({ _tag: "failed", error: { code: "forbidden", path: "workjet_projects" } });
  expect(
    localReadFailure({ code: "stale_base", reason: "payload_invalid:revision", path: "revision" }),
  ).toMatchObject({
    _tag: "failed",
    error: { code: "stale_base", reason: "payload_invalid:revision" },
  });
});
