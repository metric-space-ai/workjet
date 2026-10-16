// V4 slice C, part 2 (E49): Workjet app data against the vendored fake core at the kernel pin with
// the published Workjet manifest (E35 Nr. 3). Each point has a V4 test through the bound kernel
// client and a V3 test showing that an unbound instance keeps today's path. Routes and collections
// the pinned fake core lacks are rebuilt here from the contract (see FAKE_CORE_ADDITIONS).
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  CTOX_APPROVAL_REQUEST,
  CTOX_APPROVAL_REQUESTS,
  CTOX_MAINTENANCE_RESTART,
  WORKJET_MAILBOX_ENVELOPES,
  WORKJET_WORKER_DISPATCH,
  acknowledgeWorkjetMailboxEnvelopes,
  callWorkjetBusinessOs,
  dispatchWorkjetWorker,
  publishWorkjetMailboxEnvelope,
  readPendingWorkjetMailboxEnvelopes,
  readWorkjetDecision,
  readWorkjetLumaConfiguration,
  requestWorkjetDecision,
  saveWorkjetLumaConfiguration,
  watchPendingWorkjetMailboxEnvelopes,
  type WorkjetMailboxEnvelopeDocument,
} from "@workjet/shared/ctoxV4AppData";
import { createKernel } from "./kernel/kernel.mjs";
import { MemoryCoreTransport } from "./kernel/fake-core.mjs";
import type { CtoxAppApi, Kernel } from "./kernel/index";
import { bindKernelCtoxClient } from "./kernelClient";
import { getCtoxClient } from "./ctoxClient";
import { WORKJET_APP_ID, WORKJET_FOREIGN_COLLECTIONS, workjetAppManifest } from "./workjetAppManifest";
import {
  ctoxSignalingEndpoints,
  ctoxSshInstancePathAllowed,
  redeemWorkjetDeviceInvite,
  restartCtoxInstance,
} from "./instanceAccess";

const APP_VER = "v4-slice-c";

/**
 * Not in the pinned fake core, rebuilt from the contract:
 * - route `threads.ctox_approval.request` (core threads.rs request_approval → projection
 *   `ctox_task_approval_requests`, status pending|approved|rejected|cancelled),
 * - route `ctox.maintenance.restart` (E49.2: admin only, answer before the restart),
 * - the Workjet app handler `workjet.worker.dispatch` (E49.5) with `process.run`.
 */
const WORKER_DISPATCH_HANDLER = `export default async function handle(command, ctx) {
  const p = command.payload;
  if (typeof p.worker_id !== "string" || typeof p.brief !== "string") throw Object.assign(new Error("payload_invalid"), { code: "invalid" });
  const run = await ctx.cap.process.run({ program: "cat", args: [], stdin: JSON.stringify({ worker_id: p.worker_id, project_id: p.project_id, brief: p.brief }), timeout_ms: 30000 });
  return { dispatch_id: p.dispatch_id, exit_code: run.exit_code, accepted: run.exit_code === 0, echo: run.stdout };
}
`;
const HANDLER_HASH = "sha256-workjet-worker-dispatch-spec";

let sequence = 0;
const open: { kernel: Kernel; release: () => void }[] = [];
afterEach(async () => {
  for (const { kernel, release } of open.splice(0)) {
    release();
    await kernel.close();
  }
});

async function openV4(role: "admin" | "user" = "admin") {
  const instanceId = `v4-slice-c-${++sequence}`;
  const transport = new MemoryCoreTransport({
    namespace: instanceId,
    latencyMs: 0,
    user: { id: "gate-owner", role },
  });
  (transport as unknown as { putArtifact(hash: string, text: string): void }).putArtifact(
    HANDLER_HASH,
    WORKER_DISPATCH_HANDLER,
  );
  const manifest = {
    ...workjetAppManifest(APP_VER),
    handlers: { [WORKJET_WORKER_DISPATCH]: "handlers/worker-dispatch.mjs" },
    files: { "handlers/worker-dispatch.mjs": HANDLER_HASH },
    capabilities_required: ["process.run"],
  };
  await transport.push("business_app_versions", [
    { id: `${WORKJET_APP_ID}@${APP_VER}`, app_id: WORKJET_APP_ID, app_ver: APP_VER, manifest },
    {
      id: "ctox@v4-slice-c",
      app_id: "ctox",
      app_ver: "v4-slice-c",
      manifest: {
        app_id: "ctox",
        app_ver: "v4-slice-c",
        min_app_api: "4.0",
        collections: Object.fromEntries(
          [...new Set(WORKJET_FOREIGN_COLLECTIONS)].map((name) => [name, { class: "eager" }]),
        ),
        handlers: {},
      },
    },
  ]);
  await transport.push("business_apps", [
    { id: "ctox", title: "Crew", active_ver: "v4-slice-c" },
    { id: WORKJET_APP_ID, title: "Workjet", active_ver: APP_VER },
    { id: "shell", title: "Shell", active_ver: "v4-slice-c-shell" },
  ]);
  const approvals: Record<string, unknown>[] = [];
  transport.handlers.set(CTOX_APPROVAL_REQUEST, async (payload) => {
    const p = payload as Record<string, unknown>;
    const row = {
      id: String(p.approval_request_id),
      approval_request_id: p.approval_request_id,
      status: "pending",
      reviewer_user_id: p.reviewer_user_id,
      prompt: p.prompt,
      target_module: p.target_module,
      updated_at_ms: 1,
    };
    approvals.push(row);
    await transport.push(CTOX_APPROVAL_REQUESTS, [row]);
    return { status: "completed", approval_request_id: row.id };
  });
  transport.handlers.set(CTOX_MAINTENANCE_RESTART, () => ({ accepted: true }));
  const kernel = createKernel({
    instanceId,
    userId: "gate-owner",
    storage: "memory",
    dbName: `${instanceId}-db`,
    multiTab: false,
    transport,
  });
  await kernel.ready;
  const apps = kernel.appApi(WORKJET_APP_ID, APP_VER).query<{ id: string }>("business_apps", {});
  const off = apps.subscribe(() => {});
  try {
    await vi.waitFor(() => {
      if (!apps.get().some((row) => row.id === "shell")) throw new Error("shell not synced");
    });
  } finally {
    off();
  }
  const release = bindKernelCtoxClient(kernel, APP_VER);
  open.push({ kernel, release });
  const api = getCtoxClient(instanceId)!;
  return { instanceId, api, transport, approvals };
}

async function waitForRow<T>(api: CtoxAppApi, collection: string, id: string, ok: (row: T) => boolean) {
  const live = api.get<T>(collection, id);
  const off = live.subscribe(() => {});
  try {
    await vi.waitFor(
      () => {
        const row = live.get();
        if (row === null || !ok(row)) throw new Error(`${collection}/${id} not synced`);
      },
      { timeout: 2_000, interval: 5 },
    );
  } finally {
    off();
  }
}

const envelope = (id: string, target: string) => ({
  id,
  target_environment_id: target,
  source_environment_id: "env-sender",
  created_at_ms: 1_000,
  expires_at_ms: Date.now() + 60_000,
  envelope_json: JSON.stringify({ envelopeId: id }),
  payload_json: "{}",
});

describe("slice C on a V4 instance (fake core, published manifest)", () => {
  it("1 mailbox: publish, live query instead of polling, receipt as api.patch", async () => {
    const { api, transport } = await openV4();
    const seen: string[][] = [];
    const off = watchPendingWorkjetMailboxEnvelopes(api, "env-me", () => 0, (rows) =>
      seen.push(rows.map((row) => row.id)),
    );
    try {
      expect(await publishWorkjetMailboxEnvelope(api, envelope("e-1", "env-me"))).toEqual({
        duplicate: false,
      });
      await publishWorkjetMailboxEnvelope(api, envelope("e-2", "env-other"));
      expect(await publishWorkjetMailboxEnvelope(api, envelope("e-1", "env-me"))).toEqual({
        duplicate: true,
      });
      await waitForRow(api, WORKJET_MAILBOX_ENVELOPES, "e-1", () => true);
      expect(seen.at(-1)).toEqual(["e-1"]);
      expect(readPendingWorkjetMailboxEnvelopes(api, "env-me", 0).map((row) => row.id)).toEqual([
        "e-1",
      ]);
      expect(await acknowledgeWorkjetMailboxEnvelopes(api, ["e-1", "missing"], "env-me", 5)).toBe(1);
      await waitForRow<WorkjetMailboxEnvelopeDocument>(
        api,
        WORKJET_MAILBOX_ENVELOPES,
        "e-1",
        (row) => row.status === "consumed",
      );
      expect(readPendingWorkjetMailboxEnvelopes(api, "env-me", 0)).toEqual([]);
      expect(seen.at(-1)).toEqual([]);
      // The receipt is durable in the core, not only in the local store.
      const core = (transport as unknown as { core: { docs: Map<string, { data: unknown }> } }).core
        .docs;
      const stored = [...core.entries()].find(([key]) => key.includes('"e-1"'))?.[1]?.data;
      expect(stored).toMatchObject({ status: "consumed", consumed_by: "env-me" });
    } finally {
      off();
    }
  });

  it("2 luma/preset configuration: api.get/api.patch with compare-and-set", async () => {
    const { api } = await openV4();
    expect(readWorkjetLumaConfiguration(api)).toEqual({
      revision: 0,
      configuration: null,
      updatedAtMs: null,
    });
    expect(await saveWorkjetLumaConfiguration(api, 0, { managedSystemPrompt: "a" }, 10)).toEqual({
      status: "saved",
      revision: 1,
    });
    expect(await saveWorkjetLumaConfiguration(api, 0, { managedSystemPrompt: "b" }, 11)).toEqual({
      status: "conflict",
      revision: 1,
    });
    expect(await saveWorkjetLumaConfiguration(api, 1, { managedSystemPrompt: "c" }, 12)).toEqual({
      status: "saved",
      revision: 2,
    });
    expect(readWorkjetLumaConfiguration(api)).toEqual({
      revision: 2,
      configuration: { managedSystemPrompt: "c" },
      updatedAtMs: 12,
    });
  });

  it("3 decision_hub → threads.ctox_approval.request plus approval read", async () => {
    const { api, approvals, transport } = await openV4();
    const result = await requestWorkjetDecision(api, {
      decisionKey: "k-1",
      title: "Freigabe",
      question: "Weiter?",
      options: [{ id: "approve" }, { id: "reject" }],
      reviewerUserId: "reviewer",
      threadId: "t-1",
      environmentId: "env-me",
    });
    expect(result).toEqual({ decisionId: "workjet-decision:k-1", status: "open" });
    expect(approvals[0]).toMatchObject({ prompt: "Weiter?", reviewer_user_id: "reviewer" });
    await waitForRow(api, CTOX_APPROVAL_REQUESTS, "workjet-decision:k-1", () => true);
    expect(readWorkjetDecision(api, "workjet-decision:k-1")).toMatchObject({ status: "open" });
    await transport.push(CTOX_APPROVAL_REQUESTS, [
      { id: "workjet-decision:k-1", status: "approved", review_comment: "ok", updated_at_ms: 7 },
    ]);
    await waitForRow<{ status: string }>(
      api,
      CTOX_APPROVAL_REQUESTS,
      "workjet-decision:k-1",
      (row) => row.status === "approved",
    );
    expect(readWorkjetDecision(api, "workjet-decision:k-1")).toEqual({
      decisionId: "workjet-decision:k-1",
      status: "resolved",
      selectedOptionId: "approve",
      comment: "ok",
      resolutionVersion: 7,
    });
  });

  it("3 without the approval route the core rejects with unknown_command", async () => {
    const { api, transport } = await openV4();
    transport.handlers.delete(CTOX_APPROVAL_REQUEST);
    await expect(
      requestWorkjetDecision(api, {
        decisionKey: "k-2",
        title: "t",
        question: "q",
        options: [],
        reviewerUserId: "r",
        threadId: "t",
        environmentId: "e",
      }),
    ).rejects.toMatchObject({ code: "unknown_command" });
  });

  it("4 worker dispatch runs in the Workjet app handler with process.run", async () => {
    const { api } = await openV4();
    const result = (await dispatchWorkjetWorker(api, {
      dispatchId: "d-1",
      workerId: "w-1",
      projectId: "p-1",
      brief: "Baue X",
    })) as { accepted: boolean; echo: string };
    expect(result.accepted).toBe(true);
    expect(JSON.parse(result.echo)).toEqual({ worker_id: "w-1", project_id: "p-1", brief: "Baue X" });
  });

  it("5 business OS adapter: query, get and command through the V4 client", async () => {
    const { api } = await openV4();
    await publishWorkjetMailboxEnvelope(api, envelope("e-9", "env-me"));
    const rows = (await callWorkjetBusinessOs(api, {
      kind: "query",
      collection: WORKJET_MAILBOX_ENVELOPES,
      selector: { target_environment_id: "env-me" },
    })) as { id: string }[];
    expect(rows.map((row) => row.id)).toEqual(["e-9"]);
    expect(await callWorkjetBusinessOs(api, { kind: "get", collection: WORKJET_MAILBOX_ENVELOPES, id: "x" })).toBeNull();
    await expect(
      callWorkjetBusinessOs(api, { kind: "command", type: "ctox.not.a.route", payload: {} }),
    ).rejects.toMatchObject({ code: "unknown_command" });
  });

  it("6 restart via ctox.maintenance.restart behind the capability, no SSH path", async () => {
    const { instanceId } = await openV4();
    const v3Restart = vi.fn(async () => ({ ok: true as const }));
    expect(ctoxSshInstancePathAllowed(instanceId)).toBe(false);
    expect(
      await restartCtoxInstance(instanceId, { capabilities: [], reason: "r", v3Restart }),
    ).toEqual({ ok: false, code: "capability_missing" });
    expect(
      await restartCtoxInstance(instanceId, {
        capabilities: [CTOX_MAINTENANCE_RESTART],
        reason: "r",
        v3Restart,
      }),
    ).toEqual({ ok: true });
    expect(v3Restart).not.toHaveBeenCalled();
  });

  it("6 restart is admin only and a core without the route reads as capability missing", async () => {
    const user = await openV4("user");
    const v3Restart = vi.fn(async () => ({ ok: true as const }));
    expect(
      await restartCtoxInstance(user.instanceId, {
        capabilities: [CTOX_MAINTENANCE_RESTART],
        reason: "r",
        v3Restart,
      }),
    ).toEqual({ ok: false, code: "forbidden" });
    const admin = await openV4();
    admin.transport.handlers.delete(CTOX_MAINTENANCE_RESTART);
    expect(
      await restartCtoxInstance(admin.instanceId, {
        capabilities: [CTOX_MAINTENANCE_RESTART],
        reason: "r",
        v3Restart,
      }),
    ).toEqual({ ok: false, code: "capability_missing" });
  });

  it("6 first pairing redeems the shell invitation over signaling into a V4LaunchContext", async () => {
    const launch = {
      v4: {
        instanceId: "inst-1",
        userId: "u-1",
        actor: { id: "u-1", role: "user" },
        signaling: {
          urls: ["wss://signal.example/ws"],
          room: "room",
          peerId: "peer",
          nativePeerId: "native",
          token: "t",
          iceServers: [],
        },
        hello: {
          offer: {
            type: "hello",
            protocol_ver: 4,
            bootstrap_ver: 1,
            app_api_ver: { min: "4.0", max: "4.0" },
            instance_id: "inst-1",
            capabilities: [],
            device_proof: {
              device_id: "device-1",
              public_key: "A".repeat(43),
              nonce: "B".repeat(43),
              signature: "C".repeat(86),
            },
            scopes_wanted: [],
            transport: { codecs: ["gzip"], max_frame_bytes: 16384, fragmentation: true, reassembly: true },
          },
        },
        packageKeys: [{ keyId: "k1", alg: "Ed25519", publicKey: "A".repeat(43) }],
      },
    };
    const exchange = vi.fn(async (_payload: string) => launch);
    expect(await redeemWorkjetDeviceInvite("https://evil/x", exchange)).toEqual({
      ok: false,
      code: "invite_invalid",
    });
    const redeemed = await redeemWorkjetDeviceInvite("workjet://pair?payload=abc_DEF-1", exchange);
    expect(exchange).toHaveBeenCalledWith("abc_DEF-1");
    if (!redeemed.ok) throw new Error(redeemed.code);
    expect(redeemed.launchContext.instanceId).toBe("inst-1");
    expect(ctoxSignalingEndpoints(redeemed.launchContext)).toEqual(["wss://signal.example/ws"]);
    expect(
      await redeemWorkjetDeviceInvite("workjet://pair?payload=abc", async () => ({ v4: {} })),
    ).toEqual({ ok: false, code: "launch_context_invalid" });
  });
});

describe("slice C on a V3 instance (no bound client) keeps today's path", () => {
  it("6 restart and SSH instance paths stay on the desktop route", async () => {
    const instanceId = `v3-slice-c-${++sequence}`;
    expect(getCtoxClient(instanceId)).toBeNull();
    const v3Restart = vi.fn(async () => ({ ok: true as const }));
    expect(
      await restartCtoxInstance(instanceId, {
        capabilities: [CTOX_MAINTENANCE_RESTART],
        reason: "r",
        v3Restart,
      }),
    ).toEqual({ ok: true });
    expect(v3Restart).toHaveBeenCalledTimes(1);
    expect(ctoxSshInstancePathAllowed(instanceId)).toBe(true);
    expect(ctoxSshInstancePathAllowed(null)).toBe(true);
  });
});
