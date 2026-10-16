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
  WORKJET_WORKER_DISPATCH_CONTRACT,
  WORKJET_WORKER_DISPATCH_INTENTS,
  WORKJET_WORKER_DISPATCH_SOURCES,
  acknowledgeWorkjetMailboxEnvelopes,
  callWorkjetBusinessOs,
  dispatchWorkjetWorker,
  publishWorkjetMailboxEnvelope,
  readPendingWorkjetMailboxEnvelopes,
  readWorkjetDecision,
  readWorkjetLumaConfiguration,
  requestWorkjetDecision,
  saveWorkjetLumaConfiguration,
  readWorkjetWorkerDispatchHead,
  watchPendingWorkjetMailboxEnvelopes,
  watchWorkjetWorkerDispatchIntents,
  type WorkjetMailboxEnvelopeDocument,
  type WorkjetWorkerDispatchIntent,
  type WorkjetWorkerDispatchIntentDocument,
  type WorkjetWorkerDispatchSourceDocument,
  type WorkjetWorkerSourceRegistration,
} from "@workjet/shared/ctoxV4AppData";
import {
  createCtoxV4ProxyServer,
  serveCtoxV4Proxy,
  type CtoxV4ProxyClientApi,
  type CtoxV4ProxyRequest,
} from "@workjet/shared/ctoxV4AppProxy";
import { createKernel } from "./kernel/kernel.mjs";
import { MemoryCoreTransport } from "./kernelTestkit";
import type { CtoxAppApi, Kernel } from "./kernel/index";
import { bindKernelCtoxClient } from "./kernelClient";
import { workerDispatchHandlerSource } from "./workerDispatchHandler.fixture";
import { getCtoxClient } from "./ctoxClient";
import {
  WORKJET_APP_ID,
  workjetAppManifest,
  workjetForeignOwnerManifests,
} from "./workjetAppManifest";
import {
  ctoxSignalingEndpoints,
  ctoxSshInstancePathAllowed,
  redeemWorkjetDeviceInvite,
  restartCtoxInstance,
} from "./instanceAccess";
import { encodeV4DeviceInviteLink, type V4PairingControlRequest } from "./v4DeviceInvite";
import { createMemoryV4DeviceKeyStorage, createV4DeviceKeySource } from "./v4DeviceKey";
import { takePairedV4LaunchContext } from "./v4PairedLaunchContexts";

const APP_VER = "v4-slice-c";

/**
 * Not in the pinned fake core, rebuilt from the contract:
 * - route `threads.ctox_approval.request` (core threads.rs request_approval → projection
 *   `ctox_task_approval_requests`, status pending|approved|rejected|cancelled),
 * - route `ctox.maintenance.restart` (E49.2: admin only, answer before the restart),
 * - the instance module handler `workjet.worker.dispatch` (E54.3b): the intent queue over ctx.db
 *   with all seven native actions, no capability (workerDispatchHandler.fixture.ts).
 */
/** Real sha256: the kernel verifies every manifest file before it activates the app. */
async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Read by the instance-module handler, not by the Workjet app itself. */
const HANDLER_READS = ["workjet_project_chats", "business_users"] as const;

let sequence = 0;
const open: { kernel: Kernel; release: () => void }[] = [];
afterEach(async () => {
  for (const { kernel, release } of open.splice(0)) {
    release();
    await kernel.close();
  }
});

async function openV4(role: "admin" | "chef" | "user" = "admin") {
  const instanceId = `v4-slice-c-${++sequence}`;
  const transport = new MemoryCoreTransport({
    namespace: instanceId,
    latencyMs: 0,
    user: { id: "gate-owner", role },
  });
  const handlerText = workerDispatchHandlerSource();
  const handlerHash = await sha256Hex(handlerText);
  (transport as unknown as { putArtifact(hash: string, text: string): void }).putArtifact(
    handlerHash,
    handlerText,
  );
  // The instance module `workjet` (app_id workjet) adds the handler to the Workjet manifest; it
  // starts no process and declares no capability (E54.3b).
  // Its handler also reads the supervisor chats and the business users (Shell v4, ctox #924).
  const base = workjetAppManifest(APP_VER);
  const manifest = {
    ...base,
    foreign_collections: {
      ...base.foreign_collections,
      ...Object.fromEntries(
        HANDLER_READS.map((collection) => [collection, { owner_app: "ctox", ops: ["read"] }]),
      ),
    },
    handlers: { [WORKJET_WORKER_DISPATCH]: "handlers/worker-dispatch.mjs" },
    files: { "handlers/worker-dispatch.mjs": handlerHash },
    capabilities_required: [],
  };
  const owners = workjetForeignOwnerManifests("v4-slice-c").map((row) =>
    row.app_id !== "ctox"
      ? row
      : {
          ...row,
          manifest: {
            ...row.manifest,
            collections: {
              ...row.manifest.collections,
              ...Object.fromEntries(HANDLER_READS.map((name) => [name, { class: "eager" }])),
            },
            exports: {
              ...row.manifest.exports,
              ...Object.fromEntries(HANDLER_READS.map((name) => [name, ["read"]])),
            },
          },
        },
  );
  await transport.push("business_app_versions", [
    { id: `${WORKJET_APP_ID}@${APP_VER}`, app_id: WORKJET_APP_ID, app_ver: APP_VER, manifest },
    ...owners,
  ]);
  await transport.push("business_apps", [
    { id: "ctox", title: "Crew", active_ver: "v4-slice-c" },
    { id: "ctox-platform", title: "Platform", active_ver: "v4-slice-c" },
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
  const apps = kernel.appApi("fixture-probe", "0").query<{ id: string }>("business_apps", {});
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

async function waitForRow<T>(
  api: CtoxAppApi,
  collection: string,
  id: string,
  ok: (row: T) => boolean,
) {
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

const SUPERVISOR = "00000000-0000-4000-8000-0000000000aa";

/**
 * ctox-owned rows the handler checks (ctox #924): the project (owner, status), the supervisor chat
 * of the actor in that project, and optionally the actor's business user (role, capability epoch).
 */
async function seedProject(
  transport: MemoryCoreTransport,
  api: CtoxAppApi,
  row: { id: string; owner_user_id: string; status?: string },
  chat: { thread_id?: string; owner_user_id?: string; project_id?: string } | null = {},
) {
  await seedBusinessUser(transport, {});
  await transport.push("workjet_projects", [{ status: "active", ...row }]);
  await waitForRow(api, "workjet_projects", row.id, () => true);
  if (chat === null) return;
  const thread = chat.thread_id ?? SUPERVISOR;
  const id = `chat-${row.id}-${thread}`;
  await transport.push("workjet_project_chats", [
    { id, thread_id: thread, owner_user_id: row.owner_user_id, project_id: row.id, ...chat },
  ]);
}

/** The actor's persisted business user (handler `currentActor`): active chef/admin. */
async function seedBusinessUser(
  transport: MemoryCoreTransport,
  row: { active?: boolean; role?: string; capability_epoch?: number },
) {
  await transport.push("business_users", [
    { id: "gate-owner", user_id: "gate-owner", active: true, role: "admin", ...row },
  ]);
}

/** Source rows are keyed by owner+project, so wait for them by registration id. */
async function waitForSource(
  api: CtoxAppApi,
  registrationId: string,
  ok: (row: WorkjetWorkerDispatchSourceDocument) => boolean,
) {
  const live = api.query<WorkjetWorkerDispatchSourceDocument>(WORKJET_WORKER_DISPATCH_SOURCES, {
    selector: { registration_id: registrationId },
  });
  const off = live.subscribe(() => {});
  try {
    await vi.waitFor(
      () => {
        const row = live.get()[0];
        if (row === undefined || !ok(row)) throw new Error(`source ${registrationId} not synced`);
      },
      { timeout: 2_000, interval: 5 },
    );
  } finally {
    off();
  }
}

const scope = (project: string, thread = SUPERVISOR) => ({
  project_id: project,
  source_supervisor_thread_id: thread,
});

const dispatched = (intent: WorkjetWorkerDispatchIntent) => ({
  schemaVersion: 1,
  status: "dispatched",
  environmentId: "env-worker",
  workerThreadId: intent.intentId,
  computerId: "computer-1",
  branch: `workjet/worker/${intent.intentId}`,
  worktreePath: `/tmp/worktrees/${intent.intentId}`,
  parent: { environmentId: intent.sourceEnvironmentId, threadId: intent.sourceSupervisorThreadId },
  modelSelection: { instanceId: "codex", model: "gpt" },
  enabledCapabilityIds: [],
});

const outcome = (intentId: string) => ({
  schema: "ctox.workjet.worker-outcome.v1",
  worker_thread_id: intentId,
  environment_id: "env-worker",
  computer_id: "computer-1",
  branch: `workjet/worker/${intentId}`,
  execution_stopped: true,
  pull_request: {
    provider: "github",
    number: 7,
    url: "https://github.com/metric-space-ai/workjet/pull/7",
    head_oid: "a".repeat(40),
    state: "merged",
  },
});

describe("slice C on a V4 instance (fake core, published manifest)", () => {
  it("1 mailbox: publish, live query instead of polling, receipt as api.patch", async () => {
    const { api, transport } = await openV4();
    const seen: string[][] = [];
    const off = watchPendingWorkjetMailboxEnvelopes(
      api,
      "env-me",
      () => 0,
      (rows) => seen.push(rows.map((row) => row.id)),
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
      expect(await acknowledgeWorkjetMailboxEnvelopes(api, ["e-1", "missing"], "env-me", 5)).toBe(
        1,
      );
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
    const { api, transport } = await openV4();
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
    // At pin eca39cf84 the approval request is a Core platform route (E39/E42): the fake Core
    // answers it itself without app dispatch, so the test plays the Core projection.
    await transport.push(CTOX_APPROVAL_REQUESTS, [
      {
        id: "workjet-decision:k-1",
        approval_request_id: "workjet-decision:k-1",
        status: "pending",
        reviewer_user_id: "reviewer",
        prompt: "Weiter?",
        target_module: "workjet",
        updated_at_ms: 1,
      },
    ]);
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

  it("3 the approval request is a Core platform route, never an app handler (E42)", async () => {
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
    ).resolves.toEqual({ decisionId: "workjet-decision:k-2", status: "open" });
  });

  it("4 worker dispatch is an intent queue in Workjet app data, all seven actions", async () => {
    const { api, transport } = await openV4();
    await seedProject(transport, api, { id: "p-1", owner_user_id: "gate-owner" });
    const registration = (await dispatchWorkjetWorker(api, {
      action: "register_source",
      source_environment_id: "env-me",
      source_supervisor_thread_id: SUPERVISOR,
      project_id: "p-1",
    })) as WorkjetWorkerSourceRegistration;
    expect(registration).toMatchObject({
      contract: WORKJET_WORKER_DISPATCH_CONTRACT,
      revision: 1,
      state: "active",
      sourceEnvironmentId: "env-me",
      sourceSupervisorThreadId: SUPERVISOR,
      sourceInstanceId: "local",
      sourceWorkspaceId: "local",
      authorityEpoch: 0,
      ownerUserId: "gate-owner",
      projectId: "p-1",
    });
    // Same registration again is a no-op replay (native `unchanged`).
    expect(
      await dispatchWorkjetWorker(api, {
        action: "register_source",
        source_environment_id: "env-me",
        source_supervisor_thread_id: SUPERVISOR,
        project_id: "p-1",
      }),
    ).toEqual(registration);

    // dispatch (supervisor side): an intent, never a process; replay keeps the same intent.
    const dispatchArgs = {
      action: "dispatch",
      dispatch_key: "k-1",
      task: "Baue X",
      title: "X",
      ...scope("p-1"),
    } as const;
    const first = (await dispatchWorkjetWorker(api, dispatchArgs)) as {
      state: string;
      intent: WorkjetWorkerDispatchIntent;
    };
    expect(first.state).toBe("pending");
    expect(first.intent).toMatchObject({
      registrationId: registration.registrationId,
      registrationRevision: 1,
      sourceEnvironmentId: "env-me",
      sourceSupervisorThreadId: SUPERVISOR,
      projectId: "p-1",
      task: "Baue X",
    });
    expect(first.intent.intentId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/,
    );
    const replay = (await dispatchWorkjetWorker(api, dispatchArgs)) as {
      intent: WorkjetWorkerDispatchIntent;
    };
    expect(replay.intent.intentId).toBe(first.intent.intentId);
    await expect(
      dispatchWorkjetWorker(api, { ...dispatchArgs, task: "anders" }),
    ).rejects.toMatchObject({ code: "conflict" });

    // poll: the dispatcher reads the head of its queue locally (live query, no MCP poll).
    const woke = vi.fn();
    const off = watchWorkjetWorkerDispatchIntents(api, "env-me", woke);
    try {
      await waitForRow(api, WORKJET_WORKER_DISPATCH_INTENTS, first.intent.intentId, () => true);
      await waitForSource(api, registration.registrationId, () => true);
      expect(readWorkjetWorkerDispatchHead(api, "env-me").intents).toEqual([first.intent]);
      expect(readWorkjetWorkerDispatchHead(api, "env-other").intents).toEqual([]);
      expect(woke).toHaveBeenCalled();
      // The handler's own poll answers the same head (native receipt shape).
      expect(
        await dispatchWorkjetWorker(api, { action: "poll", source_environment_id: "env-me" }),
      ).toMatchObject({ contract: WORKJET_WORKER_DISPATCH_CONTRACT, intents: [first.intent] });

      // complete: exactly-once startup acknowledgement.
      const result = dispatched(first.intent);
      expect(
        await dispatchWorkjetWorker(api, {
          action: "complete",
          registration_id: registration.registrationId,
          revision: 1,
          intent_id: first.intent.intentId,
          result,
        }),
      ).toEqual({
        contract: WORKJET_WORKER_DISPATCH_CONTRACT,
        intentId: first.intent.intentId,
        registrationId: registration.registrationId,
        revision: 1,
        result,
      });
      await expect(
        dispatchWorkjetWorker(api, {
          action: "complete",
          registration_id: registration.registrationId,
          revision: 1,
          intent_id: first.intent.intentId,
          result: { schemaVersion: 1, status: "failed", reason: "create-failed" },
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      await waitForRow<WorkjetWorkerDispatchIntentDocument>(
        api,
        WORKJET_WORKER_DISPATCH_INTENTS,
        first.intent.intentId,
        (row) => row.result !== null,
      );
      expect(readWorkjetWorkerDispatchHead(api, "env-me").intents).toEqual([]);

      // report_outcome: immutable terminal receipt, acknowledged with provenance.
      const receipt = outcome(first.intent.intentId);
      expect(
        await dispatchWorkjetWorker(api, {
          action: "report_outcome",
          registration_id: registration.registrationId,
          revision: 1,
          intent_id: first.intent.intentId,
          receipt,
        }),
      ).toMatchObject({
        provenance: "authenticated_source_report",
        registration_revision: 1,
        receipt,
      });
      await expect(
        dispatchWorkjetWorker(api, {
          action: "report_outcome",
          registration_id: registration.registrationId,
          revision: 1,
          intent_id: first.intent.intentId,
          receipt: { ...receipt, pull_request: { ...receipt.pull_request, state: "closed" } },
        }),
      ).rejects.toMatchObject({ code: "conflict" });

      // observe (supervisor side): acknowledgement plus reported outcome.
      expect(
        await dispatchWorkjetWorker(api, { action: "observe", limit: 4, ...scope("p-1") }),
      ).toMatchObject({
        projectId: "p-1",
        supervisorThreadId: SUPERVISOR,
        truncated: false,
        observations: [
          {
            intentId: first.intent.intentId,
            dispatchKey: "k-1",
            executionKey: `workjet-supervisor:p-1:${SUPERVISOR}`,
            registrationCurrent: true,
            acknowledgement: { status: "dispatched", workerThreadId: first.intent.intentId },
            reportedOutcome: { provenance: "authenticated_source_report" },
          },
        ],
      });

      // revoke_source: later intents of the revoked registration never reach the head.
      const second = (await dispatchWorkjetWorker(api, {
        action: "dispatch",
        dispatch_key: "k-2",
        task: "Baue Y",
        ...scope("p-1"),
      })) as { intent: WorkjetWorkerDispatchIntent };
      expect(
        await dispatchWorkjetWorker(api, {
          action: "revoke_source",
          registration_id: registration.registrationId,
          revision: 1,
        }),
      ).toMatchObject({ state: "revoked", revision: 2 });
      await waitForSource(
        api,
        registration.registrationId,
        (row) => row.record.state === "revoked",
      );
      await waitForRow(api, WORKJET_WORKER_DISPATCH_INTENTS, second.intent.intentId, () => true);
      expect(readWorkjetWorkerDispatchHead(api, "env-me").intents).toEqual([]);
    } finally {
      off();
    }
  });

  describe("4 the handler refuses every source outside the actor's supervisor scope", () => {
    const register = (api: CtoxAppApi, project: string, thread = SUPERVISOR) =>
      dispatchWorkjetWorker(api, {
        action: "register_source",
        source_environment_id: "env-me",
        ...scope(project, thread),
      });
    /** The client only surfaces the code; the handler's reason stays on the core's command row. */
    const expectForbidden = async (
      transport: MemoryCoreTransport,
      call: Promise<unknown>,
      reason: string,
    ) => {
      await expect(call).rejects.toMatchObject({ code: "forbidden" });
      const core = (
        transport as unknown as {
          core: { docs: Map<string, { collection: string; data: Record<string, unknown> }> };
        }
      ).core;
      const errors = [...core.docs.values()]
        .filter((row) => row.collection === "business_commands")
        .map((row) => row.data)
        .filter((doc) => doc.type === WORKJET_WORKER_DISPATCH && doc.status === "failed")
        .map((doc) => doc.error);
      expect(errors).toContain(`forbidden: ${reason}`);
    };

    it("a project of another owner", async () => {
      const { api, transport } = await openV4();
      await seedProject(transport, api, { id: "p-foreign", owner_user_id: "someone-else" });
      await expectForbidden(
        transport,
        register(api, "p-foreign"),
        "project is unavailable to this user",
      );
    });

    it("a project that is not active", async () => {
      const { api, transport } = await openV4();
      await seedProject(transport, api, {
        id: "p-1",
        owner_user_id: "gate-owner",
        status: "archived",
      });
      await expectForbidden(transport, register(api, "p-1"), "project is archived");
    });

    it("an unregistered supervisor thread", async () => {
      const { api, transport } = await openV4();
      await seedProject(transport, api, { id: "p-1", owner_user_id: "gate-owner" });
      await expectForbidden(
        transport,
        register(api, "p-1", "00000000-0000-4000-8000-00000000beef"),
        "source supervisor is not registered natively",
      );
      // The same holds for dispatch and observe: the scope travels in the payload.
      await expectForbidden(
        transport,
        dispatchWorkjetWorker(api, {
          action: "dispatch",
          dispatch_key: "k-x",
          task: "Baue X",
          ...scope("p-1", "00000000-0000-4000-8000-00000000beef"),
        }),
        "source supervisor is not registered natively",
      );
      await expectForbidden(
        transport,
        dispatchWorkjetWorker(api, {
          action: "observe",
          ...scope("p-1", "00000000-0000-4000-8000-00000000beef"),
        }),
        "source supervisor is not registered natively",
      );
    });

    it("a supervisor chat of another user", async () => {
      const { api, transport } = await openV4();
      await seedProject(
        transport,
        api,
        { id: "p-1", owner_user_id: "gate-owner" },
        { owner_user_id: "someone-else" },
      );
      await expectForbidden(
        transport,
        register(api, "p-1"),
        "source supervisor is not registered natively",
      );
    });

    it("a supervisor chat of another project", async () => {
      const { api, transport } = await openV4();
      await seedProject(transport, api, { id: "p-1", owner_user_id: "gate-owner" }, null);
      await seedProject(transport, api, { id: "p-2", owner_user_id: "gate-owner" });
      await expectForbidden(
        transport,
        register(api, "p-1"),
        "source supervisor belongs to another project",
      );
    });

    it("an inactive business user", async () => {
      const { api, transport } = await openV4();
      await seedProject(transport, api, { id: "p-1", owner_user_id: "gate-owner" });
      await seedBusinessUser(transport, { active: false });
      await expectForbidden(
        transport,
        register(api, "p-1"),
        "worker source actor authority is no longer current",
      );
    });

    it("a business user without chef or admin role", async () => {
      const { api, transport } = await openV4("admin");
      await seedProject(transport, api, { id: "p-1", owner_user_id: "gate-owner" });
      await seedBusinessUser(transport, { role: "user" });
      await expectForbidden(
        transport,
        register(api, "p-1"),
        "worker source actor authority is no longer current",
      );
    });

    it("a business user role that differs from the command role", async () => {
      const { api, transport } = await openV4("admin");
      await seedProject(transport, api, { id: "p-1", owner_user_id: "gate-owner" });
      await seedBusinessUser(transport, { role: "chef" });
      await expectForbidden(transport, register(api, "p-1"), "dispatch role changed");
    });

    it("a missing business user", async () => {
      const { api, transport } = await openV4();
      await seedProject(transport, api, { id: "p-1", owner_user_id: "gate-owner" });
      await transport.push("business_users", [
        { id: "gate-owner", user_id: "gate-owner", is_deleted: true },
      ]);
      await expectForbidden(
        transport,
        register(api, "p-1"),
        "worker source actor is not a persisted native user",
      );
    });

    it("a chef may register but not dispatch without the supervisor lease (E54.3c)", async () => {
      const { api, transport } = await openV4("chef");
      await seedProject(transport, api, { id: "p-1", owner_user_id: "gate-owner" });
      await seedBusinessUser(transport, { role: "chef" });
      await expect(register(api, "p-1")).resolves.toMatchObject({ state: "active" });
      await expectForbidden(
        transport,
        dispatchWorkjetWorker(api, {
          action: "dispatch",
          dispatch_key: "k-chef",
          task: "Baue X",
          ...scope("p-1"),
        }),
        "worker dispatch requires the supervisor lease (admin until projected, E54.3c)",
      );
    });

    it("an active chef/admin carries the capability epoch, and nothing asks for process.run", async () => {
      const { api, transport } = await openV4("admin");
      await seedProject(transport, api, { id: "p-1", owner_user_id: "gate-owner" });
      await seedBusinessUser(transport, { capability_epoch: 7 });
      await expect(register(api, "p-1")).resolves.toMatchObject({ authorityEpoch: 7 });
      expect(JSON.stringify(workerDispatchHandlerSource())).not.toContain("process");
    });
  });

  it("4 the same queue through the renderer→server proxy (C3)", async () => {
    const { api, transport } = await openV4();
    await seedProject(transport, api, { id: "p-1", owner_user_id: "gate-owner" });
    const sent: CtoxV4ProxyRequest[] = [];
    let client: ReturnType<typeof serveCtoxV4Proxy> | null = null;
    const server = createCtoxV4ProxyServer({
      actor: api.actor,
      send: (request) => {
        sent.push(request);
        queueMicrotask(() => client?.handle(request));
      },
    });
    client = serveCtoxV4Proxy(api as unknown as CtoxV4ProxyClientApi, (reply) =>
      queueMicrotask(() => server.receive(reply)),
    );
    try {
      await server.ready;
      expect(sent.filter((request) => request.op === "subscribe").map((r) => r.collection)).toEqual(
        expect.arrayContaining([WORKJET_WORKER_DISPATCH_INTENTS, WORKJET_MAILBOX_ENVELOPES]),
      );
      const port = server.port;
      const registration = (await dispatchWorkjetWorker(port, {
        action: "register_source",
        source_environment_id: "env-me",
        source_supervisor_thread_id: SUPERVISOR,
        project_id: "p-1",
      })) as WorkjetWorkerSourceRegistration;
      const { intent } = (await dispatchWorkjetWorker(api, {
        action: "dispatch",
        dispatch_key: "k-proxy",
        task: "Baue Z",
        ...scope("p-1"),
      })) as { intent: WorkjetWorkerDispatchIntent };
      await vi.waitFor(
        () => {
          if (readWorkjetWorkerDispatchHead(port, "env-me").intents.length !== 1)
            throw new Error("intent not mirrored");
        },
        { timeout: 2_000, interval: 5 },
      );
      expect(readWorkjetWorkerDispatchHead(port, "env-me").intents).toEqual([intent]);
      await dispatchWorkjetWorker(port, {
        action: "complete",
        registration_id: registration.registrationId,
        revision: 1,
        intent_id: intent.intentId,
        result: { schemaVersion: 1, status: "failed", reason: "computer-unavailable" },
      });
      await vi.waitFor(
        () => {
          if (readWorkjetWorkerDispatchHead(port, "env-me").intents.length !== 0)
            throw new Error("completion not mirrored");
        },
        { timeout: 2_000, interval: 5 },
      );
      // An unknown command type is rejected through the proxy just like on the kernel.
      await expect(
        callWorkjetBusinessOs(port, { kind: "command", type: "ctox.not.a.route", payload: {} }),
      ).rejects.toMatchObject({ code: "unknown_command" });
    } finally {
      client.close();
      server.close();
    }
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
    expect(
      await callWorkjetBusinessOs(api, {
        kind: "get",
        collection: WORKJET_MAILBOX_ENVELOPES,
        id: "x",
      }),
    ).toBeNull();
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
            transport: {
              codecs: ["gzip"],
              max_frame_bytes: 16384,
              fragmentation: true,
              reassembly: true,
            },
          },
        },
        packageKeys: [{ keyId: "k1", alg: "Ed25519", publicKey: "A".repeat(43) }],
      },
    };
    const instanceId = "inst-1";
    const link = encodeV4DeviceInviteLink({
      instanceId,
      signaling: {
        urls: ["wss://signal.example/ws"],
        room: "r",
        nativePeerId: "n",
        iceServers: [],
      },
      inviteId: "0b6f6f5e-3c1a-4d2e-9f00-123456789abc",
      oneTimeSecret: "A".repeat(43),
      expiresAtMs: Date.now() + 60_000,
    });
    const exchange = vi.fn(async (_target: unknown, request: V4PairingControlRequest) => ({
      type: "pairing_response",
      id: request.id,
      result: launch,
    }));
    const deviceKeys = createV4DeviceKeySource(createMemoryV4DeviceKeyStorage());
    expect(await redeemWorkjetDeviceInvite("https://evil/x", { exchange, deviceKeys })).toEqual({
      ok: false,
      code: "invite_invalid",
    });
    expect(exchange).not.toHaveBeenCalled();
    const redeemed = await redeemWorkjetDeviceInvite(link, { exchange, deviceKeys });
    expect(exchange).toHaveBeenCalledTimes(1);
    if (!redeemed.ok) throw new Error(redeemed.code);
    expect(redeemed.launchContext.instanceId).toBe(instanceId);
    expect(ctoxSignalingEndpoints(redeemed.launchContext)).toEqual(["wss://signal.example/ws"]);
    expect(takePairedV4LaunchContext(instanceId)).toEqual(launch);
    expect(
      await redeemWorkjetDeviceInvite(link, {
        deviceKeys,
        exchange: async (_target, request) => ({
          type: "pairing_response",
          id: request.id,
          result: { v4: {} },
        }),
      }),
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
